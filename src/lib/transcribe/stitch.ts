/**
 * Turns per-part pass outputs into one recording-wide transcript.
 *
 * Parts overlap (30 s by default) so no word is lost at a cut. Each part owns the
 * time between the midpoints of its overlaps with its neighbours; a word is kept
 * only from the part that owns its start time. Midpoints sit far from the cut
 * edges, where recognition of a half-heard word is least reliable.
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

export type PassResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Both passes failed: the caller falls back to captions only. */
export class TranscriptionError extends Error {
  readonly timingError: string;
  readonly textError: string;

  constructor(timingError: string, textError: string) {
    super(`Transcription failed (timing pass: ${timingError}; text pass: ${textError})`);
    this.name = 'TranscriptionError';
    this.timingError = timingError;
    this.textError = textError;
  }
}

const MIN_OVERLAP_MATCHES = 3;

function byStart<T extends PartSpan>(parts: readonly T[]): T[] {
  return [...parts].sort((a, b) => a.startMs - b.startMs);
}

function sortWords(words: TimedWord[]): TimedWord[] {
  return words.sort((a, b) => a.start - b.start);
}

/** Windows for parts already sorted by start. */
export function ownershipWindows(parts: readonly PartSpan[]): OwnershipWindow[] {
  const mid = (a: PartSpan, b: PartSpan) => (a.endMs + b.startMs) / 2;
  return parts.map((part, i) => ({
    from: i === 0 ? -Infinity : mid(parts[i - 1]!, part),
    to: i === parts.length - 1 ? Infinity : mid(part, parts[i + 1]!),
  }));
}

function owns(window: OwnershipWindow, word: TimedWord): boolean {
  return word.start >= window.from && word.start < window.to;
}

/** Shifts each part's words to recording time and keeps each overlap word once. */
export function stitchTimingParts(parts: readonly TimedPart[]): TimedWord[] {
  const ordered = byStart(parts);
  const windows = ownershipWindows(ordered);
  const out: TimedWord[] = [];
  ordered.forEach((part, i) => {
    for (const word of part.words) {
      const shifted = { ...word, start: word.start + part.startMs, end: word.end + part.startMs };
      if (owns(windows[i]!, shifted)) out.push(shifted);
    }
  });
  return sortWords(out);
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

/**
 * Aligns each text part onto the recording-wide timing words that fall inside it,
 * then keeps the words it owns. A part with no text keeps the timing words (so a
 * blank text-pass answer loses nothing); a part with no timing words spreads its
 * text evenly over the time it owns.
 */
export function stitchTextParts(parts: readonly TextPart[], timingWords: readonly TimedWord[]): TimedWord[] {
  const ordered = byStart(parts);
  const windows = ownershipWindows(ordered);
  const out: TimedWord[] = [];
  ordered.forEach((part, i) => {
    const window = windows[i]!;
    const target = timingWords.filter((x) => x.start >= part.startMs && x.start <= part.endMs);
    const source = splitWords(part.text);
    let placed: TimedWord[];
    if (source.length === 0) placed = target;
    else if (target.length === 0) {
      placed = spread(source, Math.max(part.startMs, window.from), Math.min(part.endMs, window.to));
    } else placed = transferTimes(source, target);
    for (const word of placed) if (owns(window, word)) out.push(word);
  });
  return sortWords(out);
}

/**
 * Joins untimed part texts (timing pass unavailable), dropping the words both
 * neighbours heard in their overlap. With no common words (a silent overlap) the
 * texts are simply concatenated, so nothing is lost.
 */
export function joinOverlappingTexts(parts: readonly TextPart[]): string {
  let acc: string[] = [];
  let prev: TextPart | undefined;
  for (const part of byStart(parts)) {
    const next = splitWords(part.text);
    const overlapMs = prev ? prev.endMs - part.startMs : 0;
    if (prev && overlapMs > 0 && acc.length > 0 && next.length > 0) {
      // Words expected in the overlap, with generous slack.
      const rate = splitWords(prev.text).length / Math.max(1, prev.endMs - prev.startMs);
      const k = Math.ceil(overlapMs * rate * 2) + 20;
      const tailStart = Math.max(0, acc.length - k);
      const pairs = alignTokens(
        acc.slice(tailStart).map(normalizeToken),
        next.slice(0, k).map(normalizeToken),
      );
      if (pairs.length >= MIN_OVERLAP_MATCHES) {
        const [i, j] = pairs[Math.floor(pairs.length / 2)]!;
        acc = acc.slice(0, tailStart + i).concat(next.slice(j));
      } else acc = acc.concat(next);
    } else acc = acc.concat(next);
    prev = part;
  }
  return acc.join(' ');
}

const OK: PassOutcome = { ok: true };

/**
 * Applies the degradation rules:
 *  - both passes ok → text-pass spelling on timing-pass times;
 *  - text pass failed → timing-pass words;
 *  - timing pass failed → no words, text-pass text (aligned to captions downstream);
 *  - both failed → TranscriptionError.
 * `timing` holds recording-wide words (see stitchTimingParts).
 */
export function combinePasses(timing: PassResult<TimedWord[]>, text: PassResult<TextPart[]>): TranscriptionResult {
  if (timing.ok) {
    if (text.ok) {
      const words = stitchTextParts(text.value, timing.value);
      return { words, text: words.map((x) => x.text).join(' '), timingPass: OK, textPass: OK };
    }
    return {
      words: timing.value,
      text: timing.value.map((x) => x.text).join(' '),
      timingPass: OK,
      textPass: { ok: false, error: text.error },
    };
  }
  if (text.ok) {
    return {
      words: [],
      text: joinOverlappingTexts(text.value),
      timingPass: { ok: false, error: timing.error },
      textPass: OK,
    };
  }
  throw new TranscriptionError(timing.error, text.error);
}
