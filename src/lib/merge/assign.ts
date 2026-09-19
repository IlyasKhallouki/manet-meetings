/**
 * Gives each timed word a speaker from the caption blocks.
 *
 * A block's speech interval is estimated as [tStart − lag.start, tEnd − lag.end].
 * Timing is the primary signal because Meet's caption text is often wrong (captions
 * run in one language while the meeting mixes English and French). Caption text is
 * secondary evidence: each block is aligned against the words spoken near it, and a
 * word that the block's text confirms goes to that block even across the lag
 * uncertainty. Per word, in order: confirmed by caption text → best time overlap
 * among blocks within the lag tolerance (a block whose readable text lacks the word
 * yields to one that does not contradict it; remaining ties go to the most recent
 * block) → nearest block within a few seconds → previous word's speaker → unknown.
 * Then two clean-ups touch only weakly supported words: one- or two-word flips
 * inside one speaker's speech are smoothed away, and a speaker change that falls
 * inside continuous speech moves to a clear pause a word or two away (speakers
 * change at pauses; uncaptioned fillers like "euh" otherwise stick to the wrong turn).
 */
import { alignTokens } from '../align/sequence';
import type { TimedWord } from '../types';
import { lowerBound, upperBound } from './lag';
import type { Segment } from './segments';
import { LONG_PAUSE_MS } from './turns';

export interface Lags {
  start: number;
  end: number;
}

/** Caption text this far outside a block's interval still counts as evidence. */
const TEXT_SLACK_MS = 2000;
/** Per-block lag noise: blocks this close to a word are as plausible as overlapping ones. */
const LAG_TOLERANCE_MS = 600;
/** A word outside every block takes the nearest one within this distance. */
const NEAR_MS = 3000;
/** Inherit the previous word's speaker only in continuous speech... */
const INHERIT_GAP_MS = 1000;
/** ...and not further than this from the last word placed by a caption block. */
const INHERIT_MAX_MS = 6000;
/** A block whose text matched this share of its words vouches only for those words. */
const CONTRADICT_QUALITY = 0.6;
/** Minimum interval for blocks that appeared and never changed. */
const MS_PER_TOKEN = 250;
const MAX_MIN_SPAN_MS = 3000;
const FLIP_MAX_WORDS = 2;
/** An overlap lead below this is within lag noise. */
const CLEAR_OVERLAP_LEAD = 0.5;
/** How many words a speaker change may move to reach a pause. */
const SNAP_MAX_WORDS = 2;
/** Shorter pauses count as continuous speech. */
const SNAP_MIN_PAUSE_MS = 150;
/** A change moves only to a pause at least this much longer than where it is. */
const SNAP_MIN_GAIN_MS = 100;
const EPS = 1e-6;

/** Hesitations Gemini transcribes verbatim but Meet leaves out of captions. */
const DISFLUENCIES = new Set('euh heu euhm hum hmm hm mm mmm um umm uh uhm erm er'.split(' '));

// Evidence behind a word's speaker, strongest first.
const EV_TEXT = 4;
const EV_TIME = 3;
const EV_TIE = 2;
const EV_NEAR = 1;
const EV_NONE = 0;

// Text agreement between a word and a block.
const TEXT_STRONG = 2;
const TEXT_WEAK = 1;
const TEXT_NONE = 0;
const TEXT_AGAINST = -1;

interface Span {
  /** Index in the input segments. */
  index: number;
  speaker: string;
  tokens: readonly string[];
  a: number;
  b: number;
  /** Share of the block's tokens found among nearby words. */
  quality: number;
}

export interface Assignment {
  /** One speaker per word, null when nothing supports any speaker. */
  labels: (string | null)[];
  /** Per input segment: share of its caption tokens found among the words spoken around it. */
  quality: number[];
}

interface Candidate {
  k: number;
  speaker: string;
  frac: number;
  dist: number;
  text: number;
  a: number;
}

/** `words` sorted by start, `norm` their normalized tokens. */
export function assignSpeakers(
  words: readonly TimedWord[],
  norm: readonly string[],
  segments: readonly Segment[],
  lags: Lags,
): Assignment {
  const spans = toSpans(segments, lags);
  const hits = matchText(words, norm, spans);
  const { labels, evidence } = decide(words, norm, spans, hits);
  smooth(words, labels, evidence);
  snapToPauses(words, labels, evidence);
  const quality: number[] = new Array(segments.length);
  for (const s of spans) quality[s.index] = s.quality;
  return { labels, quality };
}

/** The block's estimated speech interval: lag compensated, at least a few hundred ms per word. */
export function blockSpan(seg: Segment, lags: Lags): { a: number; b: number } {
  const a = seg.tStart - lags.start;
  const minLen = Math.min(MAX_MIN_SPAN_MS, Math.max(1, seg.tokens.length) * MS_PER_TOKEN);
  return { a, b: Math.max(seg.tEnd - lags.end, a + minLen) };
}

function toSpans(segments: readonly Segment[], lags: Lags): Span[] {
  return segments
    .map((seg, index) => ({
      index,
      speaker: seg.speaker,
      tokens: seg.tokens,
      ...blockSpan(seg, lags),
      quality: 0,
    }))
    .sort((x, y) => x.a - y.a);
}

/**
 * Aligns each block's text with the words spoken around it. Returns, per word, the
 * blocks that matched it encoded as `spanIndex * 2 + (strong ? 1 : 0)`. A match is
 * strong when it is part of a run of two or more, the token is long enough to be
 * distinctive, or the block is a one- or two-word interjection.
 */
function matchText(words: readonly TimedWord[], norm: readonly string[], spans: Span[]): (number[] | undefined)[] {
  const starts = words.map((w) => w.start);
  const hits: (number[] | undefined)[] = new Array(words.length);
  for (let k = 0; k < spans.length; k++) {
    const s = spans[k]!;
    const n = s.tokens.length;
    if (n === 0) continue;
    const lo = lowerBound(starts, s.a - TEXT_SLACK_MS);
    const hi = upperBound(starts, s.b + TEXT_SLACK_MS);
    if (lo >= hi) continue;
    const window = norm.slice(lo, hi);
    // Wrong-language captions usually share nothing with the words; skip aligning them.
    const present = new Set(window);
    if (!s.tokens.some((t) => present.has(t))) continue;
    const pairs = n <= 2 ? nearestMatches(s, words, norm, lo, hi) : alignTokens(s.tokens, window);
    s.quality = pairs.length / n;
    for (let p = 0; p < pairs.length; p++) {
      const [ti, wj] = pairs[p]!;
      const prev = pairs[p - 1];
      const next = pairs[p + 1];
      const inRun =
        (prev !== undefined && prev[0] === ti - 1 && prev[1] === wj - 1) ||
        (next !== undefined && next[0] === ti + 1 && next[1] === wj + 1);
      const strong = n <= 2 || inRun || s.tokens[ti]!.length >= 4;
      (hits[lo + wj] ??= []).push(k * 2 + (strong ? 1 : 0));
    }
  }
  return hits;
}

/** For short blocks ("oui", "ok"): the matching word closest in time, in order. */
function nearestMatches(
  s: Span,
  words: readonly TimedWord[],
  norm: readonly string[],
  lo: number,
  hi: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = lo;
  for (let t = 0; t < s.tokens.length; t++) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = from; i < hi; i++) {
      if (norm[i] !== s.tokens[t]) continue;
      const d = distance(words[i]!, s);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    if (best >= 0) {
      out.push([t, best - lo]);
      from = best + 1;
    }
  }
  return out;
}

function distance(w: TimedWord, s: Span): number {
  return Math.max(0, s.a - w.end, w.start - s.b);
}

function decide(
  words: readonly TimedWord[],
  norm: readonly string[],
  spans: readonly Span[],
  hits: readonly (number[] | undefined)[],
): { labels: (string | null)[]; evidence: Uint8Array } {
  const n = words.length;
  const labels: (string | null)[] = new Array(n).fill(null);
  const evidence = new Uint8Array(n);
  const pad = Math.max(NEAR_MS, TEXT_SLACK_MS);
  // Spans that can still reach the current word; words come in start order.
  const active: number[] = [];
  let next = 0;
  let anchorEnd = -Infinity;

  for (let i = 0; i < n; i++) {
    const w = words[i]!;
    while (next < spans.length && spans[next]!.a - pad <= w.end) active.push(next++);
    let keep = 0;
    for (const k of active) if (spans[k]!.b + pad >= w.start) active[keep++] = k;
    active.length = keep;

    const choice = choose(w, DISFLUENCIES.has(norm[i]!), active, spans, hits[i]);
    if (choice) {
      labels[i] = spans[choice.k]!.speaker;
      evidence[i] = choice.ev;
      anchorEnd = w.end;
    } else if (i > 0) {
      const prev = labels[i - 1];
      const prevWord = words[i - 1]!;
      if (prev != null && w.start - prevWord.end <= INHERIT_GAP_MS && w.start - anchorEnd <= INHERIT_MAX_MS) {
        labels[i] = prev;
        evidence[i] = EV_NONE;
      }
    }
  }
  return { labels, evidence };
}

function choose(
  w: TimedWord,
  disfluency: boolean,
  active: readonly number[],
  spans: readonly Span[],
  hit: readonly number[] | undefined,
): { k: number; ev: number } | null {
  if (active.length === 0) return null;
  const dur = w.end - w.start;
  const cands: Candidate[] = [];
  for (const k of active) {
    const s = spans[k]!;
    const overlap = Math.min(w.end, s.b) - Math.max(w.start, s.a);
    const frac = dur > 0 ? Math.max(0, overlap) / dur : w.start >= s.a && w.start <= s.b ? 1 : 0;
    // Captions never show hesitations, so their absence says nothing.
    let text = s.quality >= CONTRADICT_QUALITY && !disfluency ? TEXT_AGAINST : TEXT_NONE;
    if (hit?.includes(k * 2 + 1)) text = TEXT_STRONG;
    else if (hit?.includes(k * 2)) text = TEXT_WEAK;
    cands.push({ k, speaker: s.speaker, frac, dist: distance(w, s), text, a: s.a });
  }

  const confirmed = cands.filter((c) => c.text === TEXT_STRONG && c.dist <= TEXT_SLACK_MS);
  if (confirmed.length > 0) {
    confirmed.sort((x, y) => byFrac(x, y) || x.dist - y.dist || y.a - x.a);
    return { k: confirmed[0]!.k, ev: EV_TEXT };
  }

  const plausible = cands.filter((c) => c.frac > 0 || c.dist <= LAG_TOLERANCE_MS);
  if (plausible.length > 0) {
    plausible.sort((x, y) => byEvidence(x, y) || y.a - x.a);
    const best = plausible[0]!;
    const rival = plausible.find((c) => c.speaker !== best.speaker);
    // Uncontradicted rivals sort first, so a contradicted top rival means all are.
    const clear =
      !rival ||
      (best.text !== TEXT_AGAINST && rival.text === TEXT_AGAINST) ||
      best.frac - rival.frac >= CLEAR_OVERLAP_LEAD;
    return { k: best.k, ev: clear ? EV_TIME : EV_TIE };
  }

  let near: Candidate | undefined;
  for (const c of cands) {
    if (c.dist > NEAR_MS) continue;
    if (!near || c.dist < near.dist || (c.dist === near.dist && c.a > near.a)) near = c;
  }
  return near ? { k: near.k, ev: EV_NEAR } : null;
}

/** Larger overlap first; overlaps within EPS count as equal. */
function byFrac(x: Candidate, y: Candidate): number {
  return Math.abs(x.frac - y.frac) > EPS ? y.frac - x.frac : 0;
}

/** Uncontradicted blocks first, then larger overlap, text agreement, closeness. */
function byEvidence(x: Candidate, y: Candidate): number {
  return (
    Number(x.text === TEXT_AGAINST) - Number(y.text === TEXT_AGAINST) ||
    byFrac(x, y) ||
    y.text - x.text ||
    x.dist - y.dist
  );
}

/**
 * Relabels runs of at most FLIP_MAX_WORDS words that sit inside one other speaker's
 * continuous speech, unless caption text or unambiguous timing supports them.
 */
function smooth(words: readonly TimedWord[], labels: (string | null)[], evidence: Uint8Array): void {
  const n = labels.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && labels[j] === labels[i]) j++;
    const around = i > 0 ? labels[i - 1] : undefined;
    if (
      around != null &&
      j < n &&
      j - i <= FLIP_MAX_WORDS &&
      labels[j] === around &&
      words[i]!.start - words[i - 1]!.end < LONG_PAUSE_MS &&
      words[j]!.start - words[j - 1]!.end < LONG_PAUSE_MS
    ) {
      let weak = true;
      for (let k = i; k < j; k++) if (evidence[k]! > EV_TIE) weak = false;
      if (weak) for (let k = i; k < j; k++) labels[k] = around;
    }
    i = j;
  }
}

/**
 * Moves each speaker change that sits inside continuous speech to a clearly longer
 * pause at most SNAP_MAX_WORDS words away, when every word that changes side was
 * only weakly placed.
 */
function snapToPauses(words: readonly TimedWord[], labels: (string | null)[], evidence: Uint8Array): void {
  const n = labels.length;
  const pauseBefore = (i: number) => words[i]!.start - words[i - 1]!.end;
  for (let i = 1; i < n; i++) {
    const left = labels[i - 1];
    const right = labels[i];
    if (left == null || right == null || left === right) continue;
    const here = pauseBefore(i);
    if (here >= SNAP_MIN_PAUSE_MS) continue;
    let target = i;
    let targetPause = Math.max(SNAP_MIN_PAUSE_MS, here + SNAP_MIN_GAIN_MS);
    for (let j = Math.max(1, i - SNAP_MAX_WORDS); j <= Math.min(n - 1, i + SNAP_MAX_WORDS); j++) {
      if (j === i || pauseBefore(j) < targetPause) continue;
      // The words between the two positions change side; all must be weak.
      const side = j < i ? left : right;
      let movable = true;
      for (let k = Math.min(i, j); k < Math.max(i, j); k++) {
        if (labels[k] !== side || evidence[k]! > EV_TIE) movable = false;
      }
      if (movable) {
        target = j;
        targetPause = pauseBefore(j);
      }
    }
    if (target < i) {
      for (let k = target; k < i; k++) labels[k] = right;
    } else if (target > i) {
      for (let k = i; k < target; k++) labels[k] = left;
      i = target;
    }
  }
}
