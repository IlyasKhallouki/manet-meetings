/**
 * Caption blocks prepared for merging: one entry per block id (latest revision),
 * the local user's label replaced by their display name, text tokenized once.
 */
import { normalizeToken, splitWords } from '../align/sequence';
import type { CaptionSegment } from '../types';

export const UNKNOWN_SPEAKER = 'Unknown speaker';

/** Meet shows a block this long after speech starts (and ends); ≈ 1–2 s in practice. */
export const DEFAULT_CAPTION_LAG_MS = 1500;

export interface Segment {
  speaker: string;
  text: string;
  /** Normalized, non-empty tokens of `text`. */
  tokens: string[];
  tStart: number;
  tEnd: number;
}

const tidyName = (s: string) => s.trim().replace(/\s+/g, ' ');

export function speakerLabel(c: Pick<CaptionSegment, 'speaker' | 'self'>, selfName: string): string {
  const self = tidyName(selfName);
  if (c.self && self) return self;
  return tidyName(c.speaker) || UNKNOWN_SPEAKER;
}

/** Highest `rev` per id, sorted by first appearance. */
export function latestRevisions(captions: readonly CaptionSegment[]): CaptionSegment[] {
  const byId = new Map<string, CaptionSegment>();
  for (const c of captions) {
    const prev = byId.get(c.id);
    if (!prev || c.rev >= prev.rev) byId.set(c.id, c);
  }
  return [...byId.values()].sort((x, y) => x.tStart - y.tStart || x.tEnd - y.tEnd);
}

/** Blocks with text, ready for merging. Sorted by tStart. */
export function prepareSegments(captions: readonly CaptionSegment[], selfName: string): Segment[] {
  const out: Segment[] = [];
  for (const c of latestRevisions(captions)) {
    const text = c.text.trim();
    if (!text) continue;
    out.push({
      speaker: speakerLabel(c, selfName),
      text,
      tokens: splitWords(text).map(normalizeToken).filter(Boolean),
      tStart: c.tStart,
      tEnd: Math.max(c.tStart, c.tEnd),
    });
  }
  return out;
}
