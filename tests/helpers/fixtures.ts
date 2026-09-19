/**
 * Real speech recordings (see tests/fixtures/audio/README.md) and the means to put
 * them into an AudioStore the way the recorder does: consecutive chunks of one WebM
 * stream.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AudioStore } from '@lib/types';

export const SPEECH_EN = 'speech-en.webm';
export const SPEECH_FR = 'speech-fr.webm';
/** English 0–40.2 s, then French 40.2–80.4 s. */
export const SPEECH_MIXED = 'speech-mixed.webm';
export const SPEECH_MIXED_MS = 80_408;
export const SPEECH_MIXED_SWITCH_MS = 40_200;

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/audio/${name}`, import.meta.url));
}

export function fixtureBytes(name: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

/** Writes the fixture as consecutive chunks of `chunkBytes`. Returns the chunk count. */
export async function seedAudio(store: AudioStore, sessionId: string, name: string, chunkBytes = 32_768): Promise<number> {
  const bytes = fixtureBytes(name);
  let index = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    await store.writeChunk(sessionId, index++, new Blob([bytes.slice(offset, offset + chunkBytes)], { type: 'audio/webm' }));
  }
  return index;
}
