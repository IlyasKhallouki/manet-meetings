/**
 * Disk figures for the dashboard. Extension pages share the offscreen document's origin,
 * so they can read the recordings in OPFS directly.
 */
import { createOpfsAudioStore, storageUsage } from '../storage/opfsAudioStore';
import type { AudioStore } from '../types';

/** Committed audio bytes per session id, or null when OPFS cannot be read. */
export async function audioBytesOnDisk(
  store: AudioStore = createOpfsAudioStore(),
): Promise<Map<string, number> | null> {
  try {
    return new Map((await store.list()).map((s): [string, number] => [s.sessionId, s.bytes]));
  } catch {
    return null;
  }
}

/** navigator.storage.estimate() for the extension origin, or null when unavailable. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    return await storageUsage();
  } catch {
    return null;
  }
}
