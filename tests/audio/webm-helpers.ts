import { expect } from 'vitest';
import type { WebmPart } from '@lib/audio/webm';

export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/**
 * Tone frequency around `centerSec`, from upward zero crossings. The fixtures are
 * stepped tones, so comparing this between a part and the original at the same
 * original time checks that the part really holds that stretch of audio.
 */
export function toneHz(
  samples: ArrayLike<number>,
  sampleRate: number,
  centerSec: number,
  windowSec = 0.2,
): number {
  const from = Math.max(1, Math.round((centerSec - windowSec / 2) * sampleRate));
  const to = Math.min(samples.length, Math.round((centerSec + windowSec / 2) * sampleRate));
  if (to - from < sampleRate * windowSec * 0.5) return 0;
  let crossings = 0;
  for (let i = from; i < to; i++) {
    if ((samples[i - 1] ?? 0) < 0 && (samples[i] ?? 0) >= 0) crossings++;
  }
  return crossings / ((to - from) / sampleRate);
}

/** Part-relative seconds at which to compare a part against the original. */
export function probeTimes(part: WebmPart): number[] {
  const lenSec = (part.endMs - part.startMs) / 1000;
  return [0.3, 0.55, 0.8].map((f) => lenSec * f);
}

/** The split contract: covers [0, d], parts ≤ maxPartMs, consecutive overlap ≥ overlapMs. */
export function expectValidSplit(
  parts: WebmPart[],
  durationMs: number,
  maxPartMs: number,
  overlapMs: number,
): void {
  expect(parts.length).toBeGreaterThan(1);
  expect(parts[0]?.startMs).toBe(0);
  expect(parts.at(-1)?.endMs).toBe(durationMs);
  parts.forEach((part, i) => {
    expect(part.endMs).toBeGreaterThan(part.startMs);
    expect(part.endMs - part.startMs).toBeLessThanOrEqual(maxPartMs);
    expect([...part.data.subarray(0, 4)]).toEqual(EBML_MAGIC);
    const prev = parts[i - 1];
    if (prev) {
      expect(part.startMs).toBeGreaterThan(prev.startMs);
      expect(part.endMs).toBeGreaterThan(prev.endMs);
      expect(prev.endMs - part.startMs).toBeGreaterThanOrEqual(overlapMs);
    }
  });
}

export function indexOfBytes(haystack: Uint8Array, needle: readonly number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function concatBytes(...pieces: Array<Uint8Array | readonly number[]>): Uint8Array<ArrayBuffer> {
  const arrays = pieces.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
