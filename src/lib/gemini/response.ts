/**
 * Shapes and helpers for Interactions API responses (steps schema, May 2026).
 * Only the fields this extension reads are typed; everything else passes through.
 */
import type { TimedWord } from '../types';

export interface WordInfoAnnotation {
  type: 'word_info';
  text?: string;
  /** google-duration, e.g. "0.100s". Present when word timestamps were requested. */
  start_offset?: string;
  end_offset?: string;
  speaker?: string;
}

export type Annotation = WordInfoAnnotation | { type: string; [key: string]: unknown };

export interface ContentBlock {
  type: string;
  text?: string;
  annotations?: Annotation[];
  [key: string]: unknown;
}

export interface Step {
  type: string;
  content?: ContentBlock[];
  [key: string]: unknown;
}

export interface Interaction {
  id?: string;
  /** completed | incomplete | failed | cancelled | in_progress | requires_action | queued */
  status?: string;
  steps?: Step[];
  errors?: { code?: string; message?: string }[];
  [key: string]: unknown;
}

const DURATION = /^(\d+(?:\.\d+)?)s$/;

/** "0.100s" → 100. Undefined for anything that is not a non-negative google-duration. */
export function parseOffsetMs(offset: string | undefined): number | undefined {
  if (!offset) return undefined;
  const m = DURATION.exec(offset.trim());
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

function modelOutputBlocks(interaction: Interaction): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const step of interaction.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) if (block.type === 'text') blocks.push(block);
  }
  return blocks;
}

/** Concatenated text of every model_output step (thoughts and echoed input excluded). */
export function outputText(interaction: Interaction): string {
  return modelOutputBlocks(interaction)
    .map((b) => b.text ?? '')
    .join('');
}

function isWordInfo(a: Annotation): a is WordInfoAnnotation {
  return a.type === 'word_info';
}

export function wordAnnotations(interaction: Interaction): WordInfoAnnotation[] {
  const words: WordInfoAnnotation[] = [];
  for (const block of modelOutputBlocks(interaction)) {
    for (const a of block.annotations ?? []) if (isWordInfo(a)) words.push(a);
  }
  return words;
}

/** word_info annotations with both offsets, as ms relative to the start of the audio sent. */
export function timedWords(interaction: Interaction): TimedWord[] {
  const out: TimedWord[] = [];
  for (const w of wordAnnotations(interaction)) {
    const text = w.text?.trim();
    const start = parseOffsetMs(w.start_offset);
    const end = parseOffsetMs(w.end_offset);
    if (!text || start === undefined || end === undefined) continue;
    out.push({ text, start, end: Math.max(start, end) });
  }
  return out;
}
