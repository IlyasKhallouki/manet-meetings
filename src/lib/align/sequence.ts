/**
 * Word-sequence alignment shared by the transcriber (text pass → timing pass) and the
 * merger (untimed text → caption words).
 *
 * alignTokens finds a longest-common-subsequence style matching between two token
 * arrays. It trims common prefixes/suffixes, anchors on k-grams that are unique in
 * both ranges (patience diff, k = 1..MAX_ANCHOR_K), and only runs a quadratic DP on
 * small gaps, so hour-long transcripts (~10k words) align in well under a second.
 */
import type { TimedWord } from '../types';

const DP_CELL_LIMIT = 4_000_000;
const MAX_ANCHOR_K = 6;
const DEFAULT_WORD_MS = 300;

/** Lowercase, strip diacritics and everything that is not a letter or digit. */
export function normalizeToken(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Returns matched index pairs [i, j] with a[i] === b[j], strictly increasing in both
 * i and j. Callers pass tokens already normalized. Empty tokens never match.
 */
export function alignTokens(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  alignRange(a, 0, a.length, b, 0, b.length, out);
  return out;
}

function alignRange(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  out: Array<[number, number]>,
): void {
  // Common prefix.
  while (aLo < aHi && bLo < bHi && a[aLo] !== '' && a[aLo] === b[bLo]) {
    out.push([aLo++, bLo++]);
  }
  // Common suffix, emitted after the middle.
  const suffix: Array<[number, number]> = [];
  while (aHi > aLo && bHi > bLo && a[aHi - 1] !== '' && a[aHi - 1] === b[bHi - 1]) {
    suffix.push([--aHi, --bHi]);
  }

  if (aLo < aHi && bLo < bHi) {
    const anchors = findAnchors(a, aLo, aHi, b, bLo, bHi);
    if (anchors.length > 0) {
      let ai = aLo;
      let bi = bLo;
      for (const { i, j, k } of anchors) {
        alignRange(a, ai, i, b, bi, j, out);
        for (let d = 0; d < k; d++) out.push([i + d, j + d]);
        ai = i + k;
        bi = j + k;
      }
      alignRange(a, ai, aHi, b, bi, bHi, out);
    } else if ((aHi - aLo) * (bHi - bLo) <= DP_CELL_LIMIT) {
      lcsDp(a, aLo, aHi, b, bLo, bHi, out);
    } else {
      greedy(a, aLo, aHi, b, bLo, bHi, out);
    }
  }

  for (let s = suffix.length - 1; s >= 0; s--) out.push(suffix[s]!);
}

interface Anchor {
  i: number;
  j: number;
  k: number;
}

/**
 * k-grams unique in both ranges, reduced to a non-overlapping increasing chain via
 * longest increasing subsequence on j. Tries k = 1 first, then longer k-grams for
 * repetitive text.
 */
function findAnchors(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
): Anchor[] {
  for (let k = 1; k <= MAX_ANCHOR_K; k++) {
    if (aHi - aLo < k || bHi - bLo < k) break;
    const inA = uniqueGrams(a, aLo, aHi, k);
    const inB = uniqueGrams(b, bLo, bHi, k);
    const candidates: Anchor[] = [];
    for (const [key, i] of inA) {
      if (i < 0) continue;
      const j = inB.get(key);
      if (j !== undefined && j >= 0) candidates.push({ i, j, k });
    }
    if (candidates.length === 0) continue;
    candidates.sort((x, y) => x.i - y.i);
    const chain = longestIncreasingByJ(candidates);
    // Drop anchors overlapping the previous one (possible when k > 1).
    const result: Anchor[] = [];
    for (const c of chain) {
      const prev = result.at(-1);
      if (!prev || (c.i >= prev.i + prev.k && c.j >= prev.j + prev.k)) result.push(c);
    }
    if (result.length > 0) return result;
  }
  return [];
}

/** Map k-gram key → start index if it occurs once in the range, -1 if repeated. */
function uniqueGrams(t: readonly string[], lo: number, hi: number, k: number): Map<string, number> {
  const seen = new Map<string, number>();
  outer: for (let i = lo; i + k <= hi; i++) {
    for (let d = 0; d < k; d++) if (t[i + d] === '') continue outer;
    const key = k === 1 ? t[i]! : t.slice(i, i + k).join('');
    seen.set(key, seen.has(key) ? -1 : i);
  }
  return seen;
}

function longestIncreasingByJ(c: Anchor[]): Anchor[] {
  // Patience sorting: tails[len] = index in c of the smallest tail j for that length.
  const tails: number[] = [];
  const prev = new Int32Array(c.length).fill(-1);
  for (let x = 0; x < c.length; x++) {
    const j = c[x]!.j;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[tails[mid]!]!.j < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[x] = tails[lo - 1]!;
    tails[lo] = x;
  }
  const chain: Anchor[] = [];
  for (let x = tails.at(-1) ?? -1; x >= 0; x = prev[x]!) chain.push(c[x]!);
  return chain.reverse();
}

function lcsDp(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  out: Array<[number, number]>,
): void {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[aLo + i];
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] =
        ai !== '' && ai === b[bLo + j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aLo + i] !== '' && a[aLo + i] === b[bLo + j]) {
      out.push([aLo + i, bLo + j]);
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
}

/** Last resort for huge anchor-less ranges: match within a sliding window. */
function greedy(
  a: readonly string[],
  aLo: number,
  aHi: number,
  b: readonly string[],
  bLo: number,
  bHi: number,
  out: Array<[number, number]>,
): void {
  const WINDOW = 50;
  let j = bLo;
  for (let i = aLo; i < aHi && j < bHi; i++) {
    if (a[i] === '') continue;
    const limit = Math.min(bHi, j + WINDOW);
    for (let jj = j; jj < limit; jj++) {
      if (a[i] === b[jj]) {
        out.push([i, jj]);
        j = jj + 1;
        break;
      }
    }
  }
}

/**
 * Gives every `source` word a time taken from `target`: matched words copy the
 * target word's times, unmatched runs are spread evenly across the gap between
 * their matched neighbours (flagged `approx`). Output keeps source spelling and
 * order and is sorted by start. Returns [] when `target` is empty.
 */
export function transferTimes(source: readonly string[], target: readonly TimedWord[]): TimedWord[] {
  if (target.length === 0 || source.length === 0) return [];
  const pairs = alignTokens(source.map(normalizeToken), target.map((w) => normalizeToken(w.text)));

  const spanStart = target[0]!.start;
  const spanEnd = target.at(-1)!.end;
  const avg =
    target.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0) / target.length || DEFAULT_WORD_MS;

  const out: (TimedWord | undefined)[] = new Array(source.length);
  for (const [i, j] of pairs) out[i] = { text: source[i]!, start: target[j]!.start, end: target[j]!.end };

  if (pairs.length === 0) {
    fill(out, source, 0, source.length, spanStart, spanEnd);
    return out as TimedWord[];
  }

  let i = 0;
  while (i < source.length) {
    if (out[i]) {
      i++;
      continue;
    }
    let runEnd = i;
    while (runEnd < source.length && !out[runEnd]) runEnd++;
    const n = runEnd - i;
    const prev = i > 0 ? out[i - 1] : undefined;
    const next = runEnd < source.length ? out[runEnd] : undefined;
    let ws: number;
    let we: number;
    if (prev && next) {
      ws = prev.end;
      we = next.start;
    } else if (next) {
      we = next.start;
      ws = spanStart < we ? spanStart : Math.max(0, we - n * avg);
    } else {
      ws = prev!.end;
      we = spanEnd > ws ? spanEnd : ws + n * avg;
    }
    fill(out, source, i, runEnd, ws, Math.max(ws, we));
    i = runEnd;
  }
  return out as TimedWord[];
}

function fill(
  out: (TimedWord | undefined)[],
  source: readonly string[],
  from: number,
  to: number,
  ws: number,
  we: number,
): void {
  const n = to - from;
  for (let k = 0; k < n; k++) {
    out[from + k] = {
      text: source[from + k]!,
      start: Math.round(ws + ((we - ws) * k) / n),
      end: Math.round(ws + ((we - ws) * (k + 1)) / n),
      approx: true,
    };
  }
}
