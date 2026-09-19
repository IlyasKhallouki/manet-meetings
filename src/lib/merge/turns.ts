import type { TranscriptTurn } from '../types';

export interface LabeledWord {
  text: string;
  start: number;
  end: number;
  speaker: string;
}

/** A pause this long starts a new turn even when the speaker does not change. */
export const LONG_PAUSE_MS = 3000;

// Elided French articles/pronouns that a word-level transcript may split off: "l' équipe".
const ELISION = /(^|[\s("«“])((?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu)['’])\s+(?=\p{L})/giu;
const SPACE_BEFORE_CLOSING = /\s+([,.;:!?…%)\]}])/gu;
const SPACE_AFTER_OPENING = /([(\[{])\s+/gu;

/** Collapses whitespace and removes spaces before punctuation and inside brackets. */
export function tidyText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(ELISION, '$1$2')
    .replace(SPACE_BEFORE_CLOSING, '$1')
    .replace(SPACE_AFTER_OPENING, '$1')
    .trim();
}

/**
 * Groups consecutive words of one speaker into turns, splitting on pauses of at
 * least `pauseMs`. Words must be in reading order.
 */
export function buildTurns(words: readonly LabeledWord[], pauseMs = LONG_PAUSE_MS): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let parts: string[] = [];
  let current: TranscriptTurn | undefined;
  const flush = () => {
    if (!current) return;
    current.text = tidyText(parts.join(' '));
    turns.push(current);
  };
  for (const w of words) {
    if (current && w.speaker === current.speaker && w.start - current.end < pauseMs) {
      parts.push(w.text);
      current.end = Math.max(current.end, w.end);
      continue;
    }
    flush();
    current = { speaker: w.speaker, start: w.start, end: Math.max(w.start, w.end), text: '' };
    parts = [w.text];
  }
  flush();
  return turns.sort((x, y) => x.start - y.start);
}
