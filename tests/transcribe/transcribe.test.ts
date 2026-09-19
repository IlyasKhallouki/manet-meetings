import { describe, expect, it } from 'vitest';
import { TranscriptionError } from '@lib/transcribe/stitch';
import { baseMimeType, createLimiter, partKey, toBlob, transcribeParts } from '@lib/transcribe/transcribe';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('createLimiter', () => {
  it('runs at most n tasks at once and keeps results in order', async () => {
    const limit = createLimiter(3);
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          running++;
          peak = Math.max(peak, running);
          await tick(5 + (i % 3) * 5);
          running--;
          return i * 2;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(results).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('frees the slot of a failed task', async () => {
    const limit = createLimiter(1);
    const failed = limit(async () => {
      throw new Error('boom');
    });
    const next = limit(async () => 'still runs');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('still runs');
  });
});

describe('partKey', () => {
  it('identifies a part by its span and size', () => {
    const blob = new Blob([new Uint8Array(10)]);
    expect(partKey({ data: blob, startMs: 0, endMs: 5000 })).toBe(partKey({ data: new Uint8Array(10), startMs: 0, endMs: 5000 }));
    expect(partKey({ data: blob, startMs: 0, endMs: 5000 })).not.toBe(partKey({ data: blob, startMs: 0, endMs: 5001 }));
    expect(partKey({ data: blob, startMs: 0, endMs: 5000 })).not.toBe(partKey({ data: new Uint8Array(11), startMs: 0, endMs: 5000 }));
  });
});

describe('baseMimeType', () => {
  it('strips codec parameters for the API', () => {
    expect(baseMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(baseMimeType(' AUDIO/WEBM ')).toBe('audio/webm');
    expect(baseMimeType('')).toBe('audio/webm');
  });
});

describe('toBlob', () => {
  it('wraps exactly the viewed bytes of a Uint8Array', async () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const blob = toBlob(backing.subarray(2, 5), 'audio/webm');
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('audio/webm');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('passes a Blob through', () => {
    const blob = new Blob(['x'], { type: 'audio/webm' });
    expect(toBlob(blob, 'audio/webm')).toBe(blob);
  });
});

describe('transcribeParts when Gemini is unreachable', () => {
  // Port 9 (discard) on loopback refuses connections: a real network failure.
  it('throws a TranscriptionError marked transient, for a later retry', async () => {
    const part = { data: new Uint8Array(64), startMs: 0, endMs: 5000 };
    const other = { data: new Uint8Array(64), startMs: 4000, endMs: 9000 };
    const err = await transcribeParts('some-key', [part, other], [part], {
      mimeType: 'audio/webm',
      customVocabulary: [],
      languageCodes: [],
      rest: { baseUrl: 'http://127.0.0.1:9', retries: 0 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    const e = err as TranscriptionError;
    expect(e.transient).toBe(true);
    expect(e.timingError).toMatch(/Could not reach Gemini/);
    expect(e.textError).toMatch(/Could not reach Gemini/);
  });
});
