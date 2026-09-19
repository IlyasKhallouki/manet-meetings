/**
 * Caption lag estimation. A block appears `start` ms after its first word is spoken
 * and stops changing `end` ms after its last word (Meet keeps refining the text for
 * a moment).
 *
 * estimateLags measures both from blocks whose first/last two caption words match
 * two consecutive transcript words at exactly one place within the plausible lag
 * range, combined with a median so a few wrong matches do not matter.
 *
 * estimateLagsFromTiming needs no caption text (a meeting captioned in the wrong
 * language): blocks begin when someone starts talking after a pause and end after
 * they stop, so the right lag lines block starts up with speech onsets and block
 * ends with speech offsets.
 */
import { normalizeToken } from '../align/sequence';
import type { TimedWord } from '../types';
import type { Segment } from './segments';

export interface LagEstimate {
  start: number | null;
  end: number | null;
}

const MIN_LAG_MS = -2000;
const MAX_LAG_MS = 8000;
const MIN_SAMPLES = 3;
/** Words are sorted by start; a word ending in range starts at most this much earlier. */
const MAX_WORD_MS = 3000;

const TIMING_STEP_MS = 50;
/** How far a block edge may sit from the pause edge it belongs to. */
const TIMING_TOLERANCE_MS = 300;
/** Longer pauses are not more telling. */
const PAUSE_CAP_MS = 1000;
/** A pause at least this long counts as a clear turn boundary. */
const CLEAR_PAUSE_MS = 150;
const MIN_TIMING_BLOCKS = 6;
/** Share of blocks whose edge must land on a clear pause at the chosen lag. */
const MIN_TIMING_SUPPORT = 0.25;
/** The chosen lag must score this many times the average candidate. */
const MIN_PEAK_RATIO = 2;

/** `words` sorted by start. `norm` is normalizeToken of each word, if already computed. */
export function estimateLags(
  words: readonly TimedWord[],
  segments: readonly Segment[],
  norm: readonly string[] = words.map((w) => normalizeToken(w.text)),
): LagEstimate {
  const starts = words.map((w) => w.start);
  const startSamples: number[] = [];
  const endSamples: number[] = [];

  for (const seg of segments) {
    const n = seg.tokens.length;
    if (n < 2) continue;

    const first0 = seg.tokens[0]!;
    const first1 = seg.tokens[1]!;
    let found = -1;
    let count = 0;
    const sHi = upperBound(starts, seg.tStart - MIN_LAG_MS);
    for (let i = lowerBound(starts, seg.tStart - MAX_LAG_MS); i < sHi; i++) {
      if (norm[i] === first0 && norm[i + 1] === first1) {
        found = i;
        count++;
      }
    }
    if (count === 1) startSamples.push(seg.tStart - words[found]!.start);

    const last0 = seg.tokens[n - 2]!;
    const last1 = seg.tokens[n - 1]!;
    found = -1;
    count = 0;
    const eLo = seg.tEnd - MAX_LAG_MS;
    const eHi = seg.tEnd - MIN_LAG_MS;
    const jHi = upperBound(starts, eHi);
    for (let j = Math.max(1, lowerBound(starts, eLo - MAX_WORD_MS)); j < jHi; j++) {
      const end = words[j]!.end;
      if (end >= eLo && end <= eHi && norm[j] === last1 && norm[j - 1] === last0) {
        found = j;
        count++;
      }
    }
    if (count === 1) endSamples.push(seg.tEnd - words[found]!.end);
  }

  return {
    start: startSamples.length >= MIN_SAMPLES ? median(startSamples) : null,
    end: endSamples.length >= MIN_SAMPLES ? median(endSamples) : null,
  };
}

/** `words` sorted by start. */
export function estimateLagsFromTiming(words: readonly TimedWord[], segments: readonly Segment[]): LagEstimate {
  if (segments.length < MIN_TIMING_BLOCKS || words.length === 0) return { start: null, end: null };

  // Pause edges: an onset where speech resumes, an offset where it stops, each
  // weighted by the length of the silence.
  const onsets: number[] = [];
  const onsetWeight: number[] = [];
  const offsets: number[] = [];
  const offsetWeight: number[] = [];
  let maxEnd = -Infinity;
  for (const w of words) {
    const pause = maxEnd === -Infinity ? PAUSE_CAP_MS : Math.min(PAUSE_CAP_MS, w.start - maxEnd);
    if (pause > 0) {
      if (maxEnd !== -Infinity) {
        offsets.push(maxEnd);
        offsetWeight.push(pause);
      }
      onsets.push(w.start);
      onsetWeight.push(pause);
    }
    maxEnd = Math.max(maxEnd, w.end);
  }
  offsets.push(maxEnd);
  offsetWeight.push(PAUSE_CAP_MS);

  return {
    start: bestShift(segments.map((s) => s.tStart), onsets, onsetWeight),
    end: bestShift(segments.map((s) => s.tEnd), offsets, offsetWeight),
  };
}

/** The lag that best lines `edges − lag` up with weighted pause edges, or null. */
function bestShift(edges: readonly number[], at: readonly number[], weight: readonly number[]): number | null {
  const bins = Math.floor((MAX_LAG_MS - MIN_LAG_MS) / TIMING_STEP_MS) + 1;
  const score = new Float64Array(bins);
  const support = new Uint32Array(bins);
  // Per edge: the best pause edge each candidate lag lines it up with.
  const top = new Float64Array(bins);
  const clear = new Uint8Array(bins);
  for (const edge of edges) {
    top.fill(0);
    clear.fill(0);
    const hi = upperBound(at, edge - MIN_LAG_MS + TIMING_TOLERANCE_MS);
    for (let i = lowerBound(at, edge - MAX_LAG_MS - TIMING_TOLERANCE_MS); i < hi; i++) {
      const exact = edge - at[i]!;
      const w = weight[i]!;
      const bLo = Math.max(0, Math.ceil((exact - TIMING_TOLERANCE_MS - MIN_LAG_MS) / TIMING_STEP_MS));
      const bHi = Math.min(bins - 1, Math.floor((exact + TIMING_TOLERANCE_MS - MIN_LAG_MS) / TIMING_STEP_MS));
      for (let b = bLo; b <= bHi; b++) {
        const v = w * (1 - Math.abs(exact - (MIN_LAG_MS + b * TIMING_STEP_MS)) / TIMING_TOLERANCE_MS);
        if (v > top[b]!) top[b] = v;
        if (w >= CLEAR_PAUSE_MS) clear[b] = 1;
      }
    }
    for (let b = 0; b < bins; b++) {
      score[b] = score[b]! + top[b]!;
      support[b] = support[b]! + clear[b]!;
    }
  }

  let best = -1;
  let total = 0;
  for (let b = 0; b < bins; b++) {
    total += score[b]!;
    if (score[b]! > (best < 0 ? 0 : score[best]!)) best = b;
  }
  if (best < 0) return null;
  const confident =
    support[best]! >= Math.max(3, edges.length * MIN_TIMING_SUPPORT) && score[best]! >= (MIN_PEAK_RATIO * total) / bins;
  return confident ? MIN_LAG_MS + best * TIMING_STEP_MS : null;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** First index with a[i] >= x. */
export function lowerBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with a[i] > x. */
export function upperBound(a: readonly number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
