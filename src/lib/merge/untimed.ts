/**
 * Fallback when the timing pass failed: the transcript text has no times, so its
 * words are aligned to the caption words, each taking the speaker and (lag
 * compensated, interpolated) time of the caption word it lands on. Unmatched words
 * are placed proportionally between their matched neighbours.
 */
import { alignTokens, normalizeToken, splitWords } from '../align/sequence';
import type { Lags } from './assign';
import type { Segment } from './segments';
import type { LabeledWord } from './turns';

export interface UntimedAlignment {
  words: LabeledWord[];
  /** Share of transcript words that matched a caption word. */
  matchedRatio: number;
  /** How many transcript words landed on each segment, in input order. */
  perSegment: number[];
}

/** Null when the captions carry no words to align against. */
export function alignUntimed(text: string, segments: readonly Segment[], lags: Lags): UntimedAlignment | null {
  const capTokens: string[] = [];
  const capSpeaker: string[] = [];
  const capStart: number[] = [];
  const capEnd: number[] = [];
  const capSegment: number[] = [];
  segments.forEach((seg, k) => {
    const n = seg.tokens.length;
    const a = seg.tStart - lags.start;
    const b = Math.max(a, seg.tEnd - lags.end);
    for (let t = 0; t < n; t++) {
      capTokens.push(seg.tokens[t]!);
      capSpeaker.push(seg.speaker);
      capStart.push(a + ((b - a) * t) / n);
      capEnd.push(a + ((b - a) * (t + 1)) / n);
      capSegment.push(k);
    }
  });
  const raw = splitWords(text);
  const m = capTokens.length;
  const n = raw.length;
  if (m === 0 || n === 0) return null;

  const pairs = alignTokens(raw.map(normalizeToken), capTokens);
  const pos = new Float64Array(n);
  if (pairs.length === 0) {
    for (let i = 0; i < n; i++) pos[i] = n > 1 ? (i * (m - 1)) / (n - 1) : 0;
  } else {
    const [i0, j0] = pairs[0]!;
    for (let i = 0; i < i0; i++) pos[i] = (j0 * i) / i0;
    for (let p = 0; p < pairs.length; p++) {
      const [ia, ja] = pairs[p]!;
      pos[ia] = ja;
      const next = pairs[p + 1];
      if (!next) continue;
      const [ib, jb] = next;
      for (let i = ia + 1; i < ib; i++) pos[i] = ja + ((jb - ja) * (i - ia)) / (ib - ia);
    }
    const [iz, jz] = pairs.at(-1)!;
    for (let i = iz + 1; i < n; i++) pos[i] = jz + ((m - 1 - jz) * (i - iz)) / (n - 1 - iz);
  }

  const words: LabeledWord[] = [];
  const perSegment = new Array<number>(segments.length).fill(0);
  let prevStart = 0;
  for (let i = 0; i < n; i++) {
    const p = pos[i]!;
    const f = Math.floor(p);
    const c = Math.min(m - 1, Math.ceil(p));
    const t = p - f;
    const start = Math.max(prevStart, Math.round(capStart[f]! + (capStart[c]! - capStart[f]!) * t));
    const end = Math.max(start, Math.round(capEnd[f]! + (capEnd[c]! - capEnd[f]!) * t));
    const at = Math.round(p);
    words.push({ text: raw[i]!, start, end, speaker: capSpeaker[at]! });
    const k = capSegment[at]!;
    perSegment[k] = perSegment[k]! + 1;
    prevStart = start;
  }
  return { words, matchedRatio: pairs.length / n, perSegment };
}
