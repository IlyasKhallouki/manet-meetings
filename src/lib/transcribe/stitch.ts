/**
 * Turns per-part pass outputs into one recording-wide transcript.
 *
 * Parts overlap (30 s by default) so no word is lost at a cut. Neighbours are cut
 * at a word both of them heard, as close to the middle of their overlap as possible,
 * and each keeps its words on its own side of that word, so the word is kept once.
 * The middle sits far from the cut edges, where recognition of a half-heard word is
 * least reliable. With no shared word (a quiet overlap) the cut is the midpoint.
 *
 * A part that failed does not sink its pass: the other parts are stitched, and the
 * ranges no successful part of either pass covered are reported as gaps.
 */
import { alignTokens, normalizeToken, splitWords, transferTimes } from '../align/sequence';
import type { PassOutcome, TimedWord, TranscriptionResult } from '../types';

export interface PartSpan {
  /** ms from recording start. */
  startMs: number;
  endMs: number;
}

/** Half-open [from, to) in recording ms. */
export interface OwnershipWindow {
  from: number;
  to: number;
}

export interface TimedPart extends PartSpan {
  /** Times relative to the start of the part. */
  words: TimedWord[];
}

export interface TextPart extends PartSpan {
  text: string;
}

/**
 * What one part of a pass produced. `incomplete`: the interaction ended early (e.g.
 * an output cap) and its output is partial. `transient`: the failure may go away
 * later (network, timeout, 408/429/5xx).
 */
export type PartOutcome<T> = PartSpan &
  ({ ok: true; value: T; incomplete?: boolean } | { ok: false; error: string; transient: boolean });

/** Both passes failed: the caller falls back to captions only. */
export class TranscriptionError extends Error {
  readonly timingError: string;
  readonly textError: string;
  /** Every failure was transient (network, timeout, 408/429/5xx): worth retrying later. */
  readonly transient: boolean;

  constructor(timingError: string, textError: string, transient = false) {
    super(`Transcription failed (timing pass: ${timingError}; text pass: ${textError})`);
    this.name = 'TranscriptionError';
    this.timingError = timingError;
    this.textError = textError;
    this.transient = transient;
  }
}

/** Longest a word's start may differ between two parts' transcriptions of the same audio. */
const MAX_SKEW_MS = 1500;
/** Unmatched timing words in a row that mean the text pass skipped speech. */
const MIN_SKIPPED_RUN = 5;
/** Consecutive shared words that prove two untimed texts overlap. */
const MIN_OVERLAP_RUN = 3;
const MIN_OVERLAP_MATCHES = 3;
/** Share of the smaller compared window that must match for a join without a run. */
const DENSE_OVERLAP = 0.6;

function byStart<T extends PartSpan>(parts: readonly T[]): T[] {
  return [...parts].sort((a, b) => a.startMs - b.startMs);
}

function sortWords(words: TimedWord[]): TimedWord[] {
  return words.sort((a, b) => a.start - b.start);
}

const midpoint = (a: PartSpan, b: PartSpan) => (a.endMs + b.startMs) / 2;

/** Midpoint windows for parts already sorted by start. */
export function ownershipWindows(parts: readonly PartSpan[]): OwnershipWindow[] {
  return parts.map((part, i) => ({
    from: i === 0 ? -Infinity : midpoint(parts[i - 1]!, part),
    to: i === parts.length - 1 ? Infinity : midpoint(part, parts[i + 1]!),
  }));
}

function owns(window: OwnershipWindow, word: TimedWord): boolean {
  return word.start >= window.from && word.start < window.to;
}

/**
 * Where to cut between `a` and the next part `b`, as [end of a's window, start of b's].
 * `cut` picks a shared word near the overlap midpoint and returns a's and b's copies.
 */
function windowsFromCuts<T>(
  parts: readonly PartSpan[],
  words: readonly T[],
  cut: (a: PartSpan, aWords: T, b: PartSpan, bWords: T, mid: number) => [number, number] | undefined,
): OwnershipWindow[] {
  const windows = parts.map(() => ({ from: -Infinity, to: Infinity }));
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i - 1]!;
    const b = parts[i]!;
    const mid = midpoint(a, b);
    // No overlap (a part between them failed): nothing to deduplicate.
    const [to, from] = (b.startMs < a.endMs ? cut(a, words[i - 1]!, b, words[i]!, mid) : undefined) ?? [mid, mid];
    windows[i - 1]!.to = to;
    windows[i]!.from = from;
  }
  return windows;
}

/**
 * The two parts transcribed the overlap independently, so the same word carries
 * slightly different times in each. Align the overlap words and cut at the matched
 * pair nearest the midpoint: a keeps what precedes its copy, b keeps its copy onward.
 */
function timingCut(a: PartSpan, aWords: TimedWord[], b: PartSpan, bWords: TimedWord[], mid: number): [number, number] | undefined {
  const inOverlap = (w: TimedWord) => w.start >= b.startMs - MAX_SKEW_MS && w.start <= a.endMs + MAX_SKEW_MS;
  const x = aWords.filter(inOverlap);
  const y = bWords.filter(inOverlap);
  const pairs = alignTokens(
    x.map((w) => normalizeToken(w.text)),
    y.map((w) => normalizeToken(w.text)),
  );
  let best: [TimedWord, TimedWord] | undefined;
  let bestDistance = Infinity;
  for (const [i, j] of pairs) {
    const p = x[i]!;
    const q = y[j]!;
    if (Math.abs(p.start - q.start) > MAX_SKEW_MS) continue;
    const distance = Math.abs((p.start + q.start) / 2 - mid);
    if (distance < bestDistance) {
      best = [p, q];
      bestDistance = distance;
    }
  }
  return best && [best[0].start, best[1].start];
}

/**
 * Shifts each part's words to recording time and keeps each overlap word once.
 * Parts are concatenated rather than sorted together: their clocks can disagree by
 * a few hundred ms, and a sort would interleave the words around a cut. Starts are
 * then kept non-decreasing.
 */
export function stitchTimingParts(parts: readonly TimedPart[]): TimedWord[] {
  const ordered = byStart(parts);
  const shifted = ordered.map((part) =>
    sortWords(part.words.map((w) => ({ ...w, start: w.start + part.startMs, end: w.end + part.startMs }))),
  );
  const windows = windowsFromCuts(ordered, shifted, timingCut);
  const out: TimedWord[] = [];
  let last = -Infinity;
  shifted.forEach((words, i) => {
    for (const word of words) {
      if (!owns(windows[i]!, word)) continue;
      out.push(word.start >= last ? word : { ...word, start: last, end: Math.max(word.end, last) });
      last = Math.max(last, word.start);
    }
  });
  return out;
}

function spread(text: string[], from: number, to: number): TimedWord[] {
  const n = text.length;
  const span = Math.max(0, to - from);
  return text.map((t, k) => ({
    text: t,
    start: Math.round(from + (span * k) / n),
    end: Math.round(from + (span * (k + 1)) / n),
    approx: true,
  }));
}

function covers(part: PartSpan, word: TimedWord): boolean {
  return word.start >= part.startMs && word.start <= part.endMs;
}

/**
 * Words both text parts placed on timing words carry identical times, so cutting at
 * one of them (the one nearest the midpoint) keeps each word, timed or not, once.
 */
function textCut(a: PartSpan, aWords: TimedWord[], b: PartSpan, bWords: TimedWord[], mid: number): [number, number] | undefined {
  const inOverlap = (w: TimedWord) => !w.approx && w.start >= b.startMs && w.start <= a.endMs;
  const shared = new Set(aWords.filter(inOverlap).map((w) => w.start));
  let best: number | undefined;
  for (const w of bWords) {
    if (inOverlap(w) && shared.has(w.start) && (best === undefined || Math.abs(w.start - mid) < Math.abs(best - mid))) {
      best = w.start;
    }
  }
  return best === undefined ? undefined : [best, best];
}

/**
 * Aligns each text part onto the recording-wide timing words that fall inside it,
 * then keeps the words it owns. Timing words the text pass skipped (a truncated or
 * abridged answer) are kept, and so are timing words outside every text part (a
 * text part failed). A part with no text keeps the timing words; a part with no
 * timing words spreads its text evenly over the time it owns.
 */
export function stitchTextParts(parts: readonly TextPart[], timingWords: readonly TimedWord[]): TimedWord[] {
  const ordered = byStart(parts);
  const midWindows = ownershipWindows(ordered);
  const placed = ordered.map((part, i) => {
    const target = timingWords.filter((w) => covers(part, w));
    const source = splitWords(part.text);
    if (source.length === 0) return [...target];
    if (target.length === 0) {
      const window = midWindows[i]!;
      return spread(source, Math.max(part.startMs, window.from), Math.min(part.endMs, window.to));
    }
    return transferTimes(source, target, {
      keepSkippedTarget: MIN_SKIPPED_RUN,
      minMs: part.startMs,
      maxMs: part.endMs,
    });
  });
  const windows = windowsFromCuts(ordered, placed, textCut);
  const out: TimedWord[] = [];
  placed.forEach((words, i) => {
    for (const word of words) if (owns(windows[i]!, word)) out.push(word);
  });
  for (const word of timingWords) if (!ordered.some((part) => covers(part, word))) out.push(word);
  return sortWords(out);
}

/** Longest run of pairs that advance together in both sequences, as [first, length]. */
function longestRun(pairs: readonly [number, number][]): [number, number] {
  let best: [number, number] = [0, 0];
  let first = 0;
  for (let k = 0; k < pairs.length; k++) {
    const prev = pairs[k - 1];
    const cur = pairs[k]!;
    if (!prev || cur[0] !== prev[0] + 1 || cur[1] !== prev[1] + 1) first = k;
    if (k - first + 1 > best[1]) best = [first, k - first + 1];
  }
  return best;
}

/**
 * Normalized tokens of words[from, to) with their indexes. Tokens that normalize to
 * nothing (punctuation) are left out, so they cannot break a run of shared words.
 */
function tokensFrom(words: readonly string[], from: number, to: number): { tokens: string[]; index: number[] } {
  const tokens: string[] = [];
  const index: number[] = [];
  for (let k = Math.max(0, from); k < Math.min(words.length, to); k++) {
    const token = normalizeToken(words[k]!);
    if (!token) continue;
    tokens.push(token);
    index.push(k);
  }
  return { tokens, index };
}

/**
 * Joins untimed part texts (timing pass unavailable), dropping the words both
 * neighbours heard in their overlap. Only the words expected inside the overlap are
 * compared, and the join needs real agreement: a run of shared words, or most of
 * the compared words matching. Otherwise (a quiet overlap, where only stray function
 * words match) the texts are simply concatenated, so nothing is lost.
 */
export function joinOverlappingTexts(parts: readonly TextPart[]): string {
  let acc: string[] = [];
  let prev: TextPart | undefined;
  for (const part of byStart(parts)) {
    const next = splitWords(part.text);
    const overlapMs = prev ? prev.endMs - part.startMs : 0;
    if (prev && overlapMs > 0 && acc.length > 0 && next.length > 0) {
      const rate = (text: string, span: PartSpan) => splitWords(text).length / Math.max(1, span.endMs - span.startMs);
      const window = (r: number) => Math.ceil(overlapMs * r * 1.5) + 5;
      const tail = tokensFrom(acc, acc.length - window(rate(prev.text, prev)), acc.length);
      const head = tokensFrom(next, 0, window(rate(part.text, part)));
      const pairs = alignTokens(tail.tokens, head.tokens);
      const [first, length] = longestRun(pairs);
      const dense =
        pairs.length >= MIN_OVERLAP_MATCHES &&
        pairs.length >= DENSE_OVERLAP * Math.min(tail.tokens.length, head.tokens.length);
      const at = length >= MIN_OVERLAP_RUN ? first + Math.floor(length / 2) : dense ? Math.floor(pairs.length / 2) : -1;
      if (at >= 0) {
        const [i, j] = pairs[at]!;
        acc = acc.slice(0, tail.index[i]!).concat(next.slice(head.index[j]!));
      } else acc = acc.concat(next);
    } else acc = acc.concat(next);
    prev = part;
  }
  return acc.join(' ');
}

/** "0:05", "54:30", "1:50:00". */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The pass outcome, and whether all its failures were transient. */
function passOutcome(
  pass: 'timing' | 'text',
  parts: readonly PartOutcome<unknown>[],
): { outcome: PassOutcome; transient: boolean } {
  if (parts.length === 0) return { outcome: { ok: false, error: 'no audio to transcribe' }, transient: false };
  const ordered = byStart(parts);
  const failed = ordered.filter((p): p is Extract<PartOutcome<unknown>, { ok: false }> => !p.ok);
  if (failed.length === ordered.length) {
    const error = [...new Set(failed.map((p) => p.error))].join('; ');
    return { outcome: { ok: false, error }, transient: failed.every((p) => p.transient) };
  }
  const warnings: string[] = [];
  ordered.forEach((p, k) => {
    const range = `${clock(p.startMs)}–${clock(p.endMs)}`;
    const label = ordered.length > 1 ? `${pass} pass part ${k + 1} (${range})` : `${pass} pass (${range})`;
    if (!p.ok) warnings.push(`${label} failed: ${p.error}`);
    else if (p.incomplete) warnings.push(`${label} was cut short`);
  });
  return { outcome: warnings.length > 0 ? { ok: true, warning: warnings.join('; ') } : { ok: true }, transient: false };
}

/** Ranges of the recording that no successful part covered. */
export function uncoveredRanges(parts: readonly PartOutcome<unknown>[]): { start: number; end: number }[] {
  if (parts.length === 0) return [];
  const end = Math.max(...parts.map((p) => p.endMs));
  let cursor = Math.min(...parts.map((p) => p.startMs));
  const gaps: { start: number; end: number }[] = [];
  for (const p of byStart(parts.filter((p) => p.ok))) {
    if (p.startMs > cursor) gaps.push({ start: cursor, end: p.startMs });
    cursor = Math.max(cursor, p.endMs);
  }
  if (cursor < end) gaps.push({ start: cursor, end });
  return gaps;
}

/**
 * Applies the degradation rules to the parts that succeeded:
 *  - both passes → text-pass spelling on timing-pass times, timing words where the
 *    text pass is missing;
 *  - no text part → timing-pass words;
 *  - no timing part → no words, text-pass text (aligned to captions downstream);
 *  - nothing succeeded → TranscriptionError.
 * A pass with failed or cut-short parts is ok with a warning; it fails only when all
 * its parts failed.
 */
export function combinePasses(
  timing: readonly PartOutcome<TimedWord[]>[],
  text: readonly PartOutcome<string>[],
): TranscriptionResult {
  const timingPass = passOutcome('timing', timing);
  const textPass = passOutcome('text', text);
  if (!timingPass.outcome.ok && !textPass.outcome.ok) {
    throw new TranscriptionError(
      timingPass.outcome.error,
      textPass.outcome.error,
      timingPass.transient && textPass.transient,
    );
  }
  const timedParts: TimedPart[] = [];
  for (const p of timing) if (p.ok) timedParts.push({ startMs: p.startMs, endMs: p.endMs, words: p.value });
  const textParts: TextPart[] = [];
  for (const p of text) if (p.ok) textParts.push({ startMs: p.startMs, endMs: p.endMs, text: p.value });

  let words: TimedWord[] = [];
  let joined: string;
  if (timedParts.length > 0) {
    const timingWords = stitchTimingParts(timedParts);
    words = textParts.length > 0 ? stitchTextParts(textParts, timingWords) : timingWords;
    joined = words.map((x) => x.text).join(' ');
  } else joined = joinOverlappingTexts(textParts);

  const gaps = uncoveredRanges([...timing, ...text]);
  return {
    words,
    text: joined,
    timingPass: timingPass.outcome,
    textPass: textPass.outcome,
    ...(gaps.length > 0 ? { gaps } : {}),
  };
}
