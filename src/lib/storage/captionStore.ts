/**
 * Caption segments per session in chrome.storage.local (`captions:<id>`), keyed by
 * segment id so repeated revisions collapse to the latest one.
 */
import { browser } from 'wxt/browser';
import type { CaptionSegment } from '../types';

type Stored = Record<string, CaptionSegment>;

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

/** Merges a batch, keeping the highest `rev` per segment id. Returns the segment count. */
export function mergeCaptions(sessionId: string, segments: CaptionSegment[]): Promise<number> {
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
    return Object.keys(stored).length;
  });
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
