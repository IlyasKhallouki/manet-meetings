/**
 * Builds realistic merge inputs from a meeting script: Gemini-style timed words for
 * what was said, and Meet-style caption blocks that appear after the speech (a start
 * lag while recognition kicks in, a longer end lag while Meet refines the text).
 */
import { normalizeToken, splitWords } from '@lib/align/sequence';
import type { CaptionSegment, MeetingTranscript, TimedWord } from '@lib/types';

export interface Line {
  /** Meet label ("You" for the local user). */
  speaker: string;
  text: string;
  self?: boolean;
  /** What Meet captioned. Defaults to `text`; null means no caption block at all. */
  caption?: string | null;
  /** Silence before this line, from the end of all speech so far. Negative overlaps. */
  gap?: number;
  /** Start right after word `k` (0-based) of the previous non-interjection line. */
  interject?: number;
  /** Split the interrupted line's caption block around this interjection. */
  splitCaption?: boolean;
}

export interface BuildOptions {
  startLag?: number;
  endLag?: number;
  /** Max ± ms of per-block lag noise. */
  jitter?: number;
  selfName?: string;
  seed?: number;
}

export interface Scenario {
  /** Sorted by start, like the transcriber returns them. */
  words: TimedWord[];
  captions: CaptionSegment[];
  /** Expected speaker of each word in `words` (self mapped to selfName). */
  expected: string[];
  /** Timed words of each line, in line order. */
  lines: TimedWord[][];
}

const WORD_GAP_MS = 60;
const SENTENCE_PAUSE_MS = 250;
const DEFAULT_GAP_MS = 600;

export function speak(text: string, at: number): TimedWord[] {
  const out: TimedWord[] = [];
  let t = at;
  for (const w of splitWords(text)) {
    const dur = 140 + 45 * normalizeToken(w).length;
    out.push({ text: w, start: t, end: t + dur });
    t += dur + WORD_GAP_MS + (/[.?!]$/.test(w) ? SENTENCE_PAUSE_MS : 0);
  }
  return out;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Block {
  speaker: string;
  self: boolean;
  text: string;
  start: number;
  end: number;
}

export function build(lines: Line[], opts: BuildOptions = {}): Scenario {
  const startLag = opts.startLag ?? 1200;
  const endLag = opts.endLag ?? 1800;
  const jitter = opts.jitter ?? 0;
  const selfName = opts.selfName ?? 'Me';
  const rand = rng(opts.seed ?? 1);
  const noise = () => Math.round((rand() * 2 - 1) * jitter);

  const spoken: Array<{ word: TimedWord; speaker: string }> = [];
  const timedLines: TimedWord[][] = [];
  const blocks: Block[] = [];
  let cursor = 0;
  let mainWords: TimedWord[] = [];
  let mainBlock: Block | undefined;
  // Index in mainWords of the first word still covered by mainBlock.
  let mainFrom = 0;

  for (const line of lines) {
    const at =
      line.interject !== undefined
        ? mainWords[line.interject]!.end + 40
        : Math.max(0, cursor + (line.gap ?? DEFAULT_GAP_MS));
    const timed = speak(line.text, at);
    timedLines.push(timed);
    const label = line.self ? selfName : line.speaker;
    for (const word of timed) spoken.push({ word, speaker: label });
    cursor = Math.max(cursor, timed.at(-1)!.end);

    if (line.interject !== undefined && line.splitCaption && mainBlock) {
      const k = line.interject;
      const tokens = splitWords(mainBlock.text);
      const cut = Math.round((tokens.length * (k + 1 - mainFrom)) / (mainWords.length - mainFrom));
      const rest: Block = {
        ...mainBlock,
        text: tokens.slice(cut).join(' '),
        start: mainWords[k + 1]!.start,
        end: mainBlock.end,
      };
      mainBlock.text = tokens.slice(0, cut).join(' ');
      mainBlock.end = mainWords[k]!.end;
      if (rest.text) {
        blocks.push(rest);
        mainBlock = rest;
        mainFrom = k + 1;
      }
    }

    if (line.caption !== null) {
      const block: Block = {
        speaker: line.speaker,
        self: line.self ?? false,
        text: line.caption ?? line.text,
        start: timed[0]!.start,
        end: timed.at(-1)!.end,
      };
      blocks.push(block);
      if (line.interject === undefined) {
        mainBlock = block;
        mainFrom = 0;
      }
    } else if (line.interject === undefined) {
      mainBlock = undefined;
    }
    if (line.interject === undefined) mainWords = timed;
  }

  const captions: CaptionSegment[] = blocks.map((b, i) => {
    const tStart = Math.max(0, b.start + startLag + noise());
    return {
      id: `blk-${i}`,
      speaker: b.speaker,
      self: b.self,
      text: b.text,
      tStart,
      tEnd: Math.max(tStart, b.end + endLag + noise()),
      rev: splitWords(b.text).length,
    };
  });

  const order = spoken.map((s, i) => ({ ...s, i })).sort((x, y) => x.word.start - y.word.start || x.i - y.i);
  return {
    words: order.map((s) => s.word),
    captions,
    expected: order.map((s) => s.speaker),
    lines: timedLines,
  };
}

/** Speaker of every word, reading turns back in order. Assumes no standalone punctuation. */
export function labelsOf(t: MeetingTranscript): string[] {
  return t.turns.flatMap((turn) => splitWords(turn.text).map(() => turn.speaker));
}

export function accuracy(actual: string[], expected: string[]): number {
  if (actual.length !== expected.length) return 0;
  let ok = 0;
  for (let i = 0; i < actual.length; i++) if (actual[i] === expected[i]) ok++;
  return expected.length === 0 ? 1 : ok / expected.length;
}

// English-sounding junk, as Meet produces when captions are set to the wrong language.
const JUNK = 'bond ocean mercy bottle sandy lock ray tape view bell drag moss pony crest fable jolly quilt zebra'.split(
  ' ',
);

export function garble(text: string, seed = 3): string {
  const rand = rng(seed);
  return splitWords(text)
    .map(() => JUNK[Math.floor(rand() * JUNK.length)]!)
    .join(' ');
}

/** Whitespace-free concatenation, to check that no word was dropped or reordered. */
export function squash(parts: string[]): string {
  return parts.join('').replace(/\s+/g, '');
}
