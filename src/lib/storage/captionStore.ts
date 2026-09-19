/**
 * Caption segments per session in chrome.storage.local (`captions:<id>`), keyed by
 * segment id so repeated revisions collapse to the latest one.
 */
import { browser } from 'wxt/browser';
import type { CaptionSegment, SpeakerInfo } from '../types';

type Stored = Record<string, CaptionSegment>;

export interface MergeResult {
  /** Distinct segments stored for the session. */
  count: number;
  /** Everyone the stored captions name, in order of first speech. */
  speakers: SpeakerInfo[];
}

function captionsKey(sessionId: string): string {
  return `captions:${sessionId}`;
}

const queues = new Map<string, Promise<unknown>>();

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

async function read(sessionId: string): Promise<Stored> {
  const key = captionsKey(sessionId);
  const got = await browser.storage.local.get(key);
  return (got[key] as Stored | undefined) ?? {};
}

/**
 * Merges a batch, keeping the highest `rev` per segment id. Returns the segment count and
 * the speakers of everything stored, so the session meta can carry the roll.
 */
export function mergeCaptions(sessionId: string, segments: CaptionSegment[]): Promise<MergeResult> {
  return serialized(sessionId, async () => {
    const stored = await read(sessionId);
    let changed = false;
    for (const seg of segments) {
      const prev = stored[seg.id];
      if (prev && prev.rev >= seg.rev) continue;
      stored[seg.id] = seg;
      changed = true;
    }
    if (changed) await browser.storage.local.set({ [captionsKey(sessionId)]: stored });
    const all = Object.values(stored);
    return { count: all.length, speakers: speakersOf(all) };
  });
}

const tidy = (name: string) => name.trim().replace(/\s+/g, ' ');

/**
 * The roll: one entry per person the captions name, ordered by first speech. Every block
 * Meet labelled as the local user is one `self` entry, whatever the label ("You", "Vous").
 * Other names match without regard to case or spacing and keep their earliest spelling.
 * Expects the latest revision of each block (as stored).
 */
export function speakersOf(segments: Iterable<CaptionSegment>): SpeakerInfo[] {
  const byKey = new Map<string, SpeakerInfo>();
  for (const c of segments) {
    const name = tidy(c.speaker);
    if (!name) continue;
    const key = c.self ? '\u0000self' : name.toLocaleLowerCase();
    const start = c.tStart;
    const end = Math.max(c.tStart, c.tEnd);
    const known = byKey.get(key);
    if (!known) {
      byKey.set(key, { name, self: c.self, firstAt: start, lastAt: end, talkMs: end - start });
      continue;
    }
    if (start < known.firstAt) {
      known.firstAt = start;
      known.name = name;
    }
    known.lastAt = Math.max(known.lastAt, end);
    known.talkMs += end - start;
  }
  return [...byKey.values()].sort((a, b) => a.firstAt - b.firstAt || a.lastAt - b.lastAt || a.name.localeCompare(b.name));
}

/** Latest revision of every segment, sorted by start time. */
export async function loadCaptions(sessionId: string): Promise<CaptionSegment[]> {
  const stored = await read(sessionId);
  return Object.values(stored).sort(
    (a, b) => a.tStart - b.tStart || a.tEnd - b.tEnd || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function deleteCaptions(sessionId: string): Promise<void> {
  return serialized(sessionId, () => browser.storage.local.remove(captionsKey(sessionId)));
}
