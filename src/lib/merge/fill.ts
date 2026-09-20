/**
 * Caption text for speech the audio transcript does not contain. Words stay the
 * primary source; a caption block becomes text of its own only where its speech
 * cannot be among them:
 *  - the recorder's own blocks when their mic was not recorded (Meet never plays the
 *    local voice into the tab), whatever words overlap them;
 *  - blocks whose span holds (almost) no words and whose text matched none nearby;
 *  - the part of a block that falls where no transcription part succeeded or after
 *    the audio ended.
 * Token times inside a block are only interpolated, so at such a boundary the
 * block's edge tokens that the words already contain (the same word, spoken about
 * then) are given back: the audio has them.
 */
import { normalizeToken, splitWords } from '../align/sequence';
import { formatClock, formatDuration } from '../util/time';
import { blockSpan, type Lags } from './assign';
import { lowerBound, MAX_LAG_MS, MIN_LAG_MS, upperBound } from './lag';
import type { Segment } from './segments';
import type { LabeledWord } from './turns';

export interface TimeRange {
  start: number;
  end: number;
}

export interface CaptionFill extends LabeledWord {
  /** 'mic': the recorder's own speech, not recorded. 'gap': the audio has no transcript there. */
  reason: 'mic' | 'gap';
}

/** The timed words, sorted by start, with their normalized tokens. */
export interface HeardWords {
  words: ReadonlyArray<Pick<LabeledWord, 'start' | 'end'>>;
  norm: readonly string[];
}

/** Words this far outside a block's span may still be its speech (lag noise). */
const EDGE_MS = 1000;
/** A block with at most this many words per caption token in its span was not heard... */
const UNHEARD_SHARE = 0.2;
/** ...unless this share of its text was found among nearby words. */
const HEARD_QUALITY = 0.5;
/** Words are sorted by start; a word overlapping a span starts at most this much earlier. */
const MAX_WORD_MS = 3000;
/** A caption token was heard if the same word starts this close to its interpolated time. */
const HEARD_NEAR_MS = 1500;
/** Unheard tokens allowed between heard ones at the edge of a piece (a word Meet misheard). */
const EDGE_SKIP_TOKENS = 1;
/** Share of a block's covered tokens that must be heard for its text to place a boundary... */
const READABLE = 0.5;
/** ...up to this far from where the interpolated token times put it. */
const REACH_MS = 1000;
/** Shorter uncovered stretches left beside words are just pauses. */
const MIN_UNCOVERED_MS = 2000;
const MAX_RANGES = 5;
/** Gaps this short are summed up rather than listed: a second or two is ordinary. */
const SHORT_GAP_MS = 5000;

/**
 * Sorted, disjoint ranges the audio transcript does not cover. Timed words (sorted by
 * start) win over the ranges: where words exist the audio was transcribed, so an
 * audio end or gap edge estimated a few seconds off loses the stretch the words cover.
 */
export function uncoveredRanges(
  gaps: readonly TimeRange[] = [],
  audioEndMs?: number,
  words: HeardWords['words'] = [],
): TimeRange[] {
  const all = gaps.filter((g) => Number.isFinite(g.start) && g.end > g.start).map((g) => ({ ...g }));
  if (audioEndMs !== undefined && Number.isFinite(audioEndMs)) all.push({ start: audioEndMs, end: Infinity });
  all.sort((x, y) => x.start - y.start);
  const merged: TimeRange[] = [];
  for (const r of all) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ start: r.start, end: r.end });
  }
  if (words.length === 0) return merged;

  const starts = words.map((w) => w.start);
  const out: TimeRange[] = [];
  const keep = (start: number, end: number) => {
    if (end - start >= MIN_UNCOVERED_MS) out.push({ start, end });
  };
  for (const r of merged) {
    let first = Infinity;
    let last = -Infinity;
    const end = lowerBound(starts, r.end);
    for (let i = lowerBound(starts, r.start - MAX_WORD_MS); i < end; i++) {
      const w = words[i]!;
      if (w.end <= r.start) continue;
      first = Math.min(first, w.start);
      last = Math.max(last, w.end);
    }
    if (first > last) out.push(r);
    else {
      keep(r.start, first);
      keep(last, r.end);
    }
  }
  return out;
}

/** False when the block lies in uncovered time whatever the caption lag is. */
export function mayBeHeard(seg: Segment, uncovered: readonly TimeRange[]): boolean {
  return !inside(uncovered, seg.tStart - MAX_LAG_MS, seg.tEnd - MIN_LAG_MS);
}

/** True when every token of the block falls in one uncovered range. */
export function inUncoveredTime(seg: Segment, lags: Lags, uncovered: readonly TimeRange[]): boolean {
  if (uncovered.length === 0) return false;
  const { a, b } = blockSpan(seg, lags);
  const half = (b - a) / Math.max(1, seg.tokens.length) / 2;
  return inside(uncovered, a + half, b - half);
}

/** True when part of the block falls in uncovered time. */
export function touchesUncoveredTime(seg: Segment, lags: Lags, uncovered: readonly TimeRange[]): boolean {
  const { a, b } = blockSpan(seg, lags);
  return overlaps(uncovered, a, b);
}

/** The whole block as one piece of text at its lag-compensated time. */
export function wholeFill(seg: Segment, lags: Lags, reason: CaptionFill['reason']): CaptionFill {
  const { a, b } = blockSpan(seg, lags);
  return fill(seg.text, seg.speaker, a, b, reason);
}

/**
 * Fills for the blocks that labelled the words. `quality` from assignSpeakers, in the
 * same order as `segments`.
 */
export function unheardFills(
  heard: HeardWords,
  segments: readonly Segment[],
  quality: readonly number[],
  lags: Lags,
  uncovered: readonly TimeRange[],
): CaptionFill[] {
  const starts = heard.words.map((w) => w.start);
  const out: CaptionFill[] = [];
  segments.forEach((seg, k) => {
    const m = seg.tokens.length;
    if (m === 0) return;
    const { a, b } = blockSpan(seg, lags);
    const wasHeard =
      (quality[k] ?? 0) >= HEARD_QUALITY ||
      moreWordsThan(m * UNHEARD_SHARE, heard, starts, a - EDGE_MS, b + EDGE_MS);
    const boundary = overlaps(uncovered, a, b);
    if (!wasHeard && !boundary) out.push(fill(seg.text, seg.speaker, a, b, 'gap'));
    // At a boundary, the few words an unheard block has are likely its first or last ones.
    else if (boundary) out.push(...uncoveredPieces(seg, a, b, heard, starts, uncovered, !wasHeard));
  });
  return out;
}

/**
 * The runs of a block's tokens that fall in uncovered time (all of them when
 * `allOpen`), less the heard tokens at their edges. When the block's text is
 * readable, each run first reaches a little into covered time, so the text rather
 * than the interpolation decides where the audio stops.
 */
function uncoveredPieces(
  seg: Segment,
  a: number,
  b: number,
  heard: HeardWords,
  starts: readonly number[],
  uncovered: readonly TimeRange[],
  allOpen: boolean,
): CaptionFill[] {
  const m = seg.tokens.length;
  const slot = (b - a) / m;
  const isHeard = new Uint8Array(m);
  const open: boolean[] = [];
  let covered = 0;
  let coveredHeard = 0;
  for (let t = 0; t < m; t++) {
    const mid = a + slot * (t + 0.5);
    isHeard[t] = saidNear(seg.tokens[t]!, mid, heard, starts) ? 1 : 0;
    open.push(allOpen || inside(uncovered, mid, mid));
    if (!open[t]) {
      covered++;
      coveredHeard += isHeard[t]!;
    }
  }
  const reach = covered > 0 && coveredHeard / covered >= READABLE ? Math.ceil(REACH_MS / Math.max(1, slot)) : 0;

  const runs: Array<[number, number]> = [];
  for (let t = 0; t < m; t++) {
    if (!open[t]) continue;
    let u = t + 1;
    while (u < m && open[u]) u++;
    runs.push([t, u - 1]);
    t = u;
  }
  const out: CaptionFill[] = [];
  runs.forEach(([first, last], r) => {
    const from = Math.max(first - reach, r > 0 ? runs[r - 1]![1] + 1 : 0);
    const to = Math.min(last + reach, r + 1 < runs.length ? runs[r + 1]![0] - 1 : m - 1);
    // Only an edge next to covered time can hold words the audio has.
    const leadCovered = first > 0 || !inside(uncovered, a - REACH_MS, a + slot / 2);
    const trailCovered = last < m - 1 || !inside(uncovered, b - slot / 2, b + REACH_MS);
    const lo = leadCovered ? heardEdge(isHeard, from, to + 1, 1) : from;
    const hi = trailCovered ? heardEdge(isHeard, to, from - 1, -1) : to;
    // Only unheard tokens next to the run: a covered token alone was heard, just not matched.
    if (lo > hi || lo > last || hi < first) return;
    const [start, end] = clampInto(uncovered, a + slot * lo, a + slot * (hi + 1));
    out.push(fill(tokenText(seg.text, lo, hi), seg.speaker, start, end, 'gap'));
  });
  return out;
}

/** Notes for the fills used: one about the missing mic, one listing the uncovered stretches. */
export function fillNotes(fills: readonly CaptionFill[], words: HeardWords['words'], selfName: string): string[] {
  const notes: string[] = [];
  if (fills.some((f) => f.reason === 'mic')) {
    const who = selfName.trim() ? `${selfName.trim()}'s` : "The recorder's";
    notes.push(
      `${who} microphone was not recorded, so their words come from Meet captions and may contain recognition errors.`,
    );
  }
  const gaps = fills.filter((f) => f.reason === 'gap').sort((x, y) => x.start - y.start);
  if (gaps.length > 0) {
    // Neighbouring fills with no audio word between them form one stretch.
    const starts = words.map((w) => w.start);
    const ranges: Array<[number, number]> = [];
    for (const f of gaps) {
      const last = ranges.at(-1);
      if (last && lowerBound(starts, last[1]) >= lowerBound(starts, f.start)) last[1] = Math.max(last[1], f.end);
      else ranges.push([f.start, f.end]);
    }
    // A few seconds here and there is normal; listing each one reads like a failure.
    const long = ranges.filter(([a, b]) => b - a >= SHORT_GAP_MS);
    const short = ranges.length - long.length;
    const total = ranges.reduce((ms, [a, b]) => ms + (b - a), 0);
    const plural = (n: number) => (n === 1 ? 'stretch' : 'stretches');
    notes.push(
      long.length === 0
        ? `${ranges.length} short ${plural(ranges.length)} with no audio transcript ` +
            `(${formatDuration(total)} in total) use Meet's captions instead, which may contain recognition errors.`
        : `Where the audio had no transcript (${formatRanges(long)}` +
            `${short > 0 ? `, and ${short} shorter ${plural(short)}` : ''}), the text comes from Meet captions ` +
            'and may contain recognition errors.',
    );
  }
  return notes;
}

/** "00:01:00–00:02:00, 00:05:00–00:06:00 and 3 more". */
export function formatRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  const shown = ranges.slice(0, MAX_RANGES).map(([a, b]) => `${formatClock(a)}–${formatClock(b)}`);
  const more = ranges.length > MAX_RANGES ? ` and ${ranges.length - MAX_RANGES} more` : '';
  return `${shown.join(', ')}${more}`;
}

function fill(text: string, speaker: string, a: number, b: number, reason: CaptionFill['reason']): CaptionFill {
  const start = Math.max(0, Math.round(a));
  return { text, speaker, start, end: Math.max(start, Math.round(b)), reason };
}

/** True when more than `limit` words overlap [lo, hi]. */
function moreWordsThan(limit: number, heard: HeardWords, starts: readonly number[], lo: number, hi: number): boolean {
  let n = 0;
  const end = upperBound(starts, hi);
  for (let i = lowerBound(starts, lo - MAX_WORD_MS); i < end; i++) {
    if (heard.words[i]!.end >= lo && ++n > limit) return true;
  }
  return false;
}

/** True when a word equal to `token` starts within HEARD_NEAR_MS of `at`. */
function saidNear(token: string, at: number, heard: HeardWords, starts: readonly number[]): boolean {
  const end = upperBound(starts, at + HEARD_NEAR_MS);
  for (let i = lowerBound(starts, at - HEARD_NEAR_MS); i < end; i++) if (heard.norm[i] === token) return true;
  return false;
}

/**
 * First token from `from` towards `stop` (exclusive, direction `dir`) past the heard
 * tokens at that edge, allowing EDGE_SKIP_TOKENS unheard ones between them.
 */
function heardEdge(isHeard: Uint8Array, from: number, stop: number, dir: 1 | -1): number {
  let edge = from;
  let unheard = 0;
  for (let t = from; t !== stop; t += dir) {
    if (isHeard[t]) {
      edge = t + dir;
      unheard = 0;
    } else if (++unheard > EDGE_SKIP_TOKENS) break;
  }
  return edge;
}

/** Tokens lo..hi of a caption text, with the punctuation that follows them. */
function tokenText(text: string, lo: number, hi: number): string {
  const out: string[] = [];
  let t = 0;
  for (const raw of splitWords(text)) {
    if (normalizeToken(raw)) {
      if (t >= lo && t <= hi) out.push(raw);
      t++;
    } else if (t > lo && t <= hi + 1) {
      out.push(raw);
    }
  }
  return out.join(' ');
}

/** First range whose end is after `t`. Ranges are sorted and disjoint, so ends are sorted too. */
function firstEndingAfter(ranges: readonly TimeRange[], t: number): number {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]!.end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [from, to] cut to the uncovered ranges it overlaps, so a piece never lands among the words. */
function clampInto(ranges: readonly TimeRange[], from: number, to: number): [number, number] {
  const i = firstEndingAfter(ranges, from);
  let j = i;
  while (j + 1 < ranges.length && ranges[j + 1]!.start < to) j++;
  const first = ranges[i];
  const last = ranges[j];
  if (!first || !last || first.start >= to) return [from, to];
  return [Math.max(from, first.start), Math.min(to, last.end)];
}

function overlaps(ranges: readonly TimeRange[], from: number, to: number): boolean {
  const r = ranges[firstEndingAfter(ranges, from)];
  return r !== undefined && r.start < to;
}

function inside(ranges: readonly TimeRange[], from: number, to: number): boolean {
  const r = ranges[firstEndingAfter(ranges, from)];
  return r !== undefined && r.start <= from && r.end >= to;
}
