import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGeminiMeetingAI, DEFAULT_SPLIT_LIMITS, planParts } from '@lib/transcribe/ai';
import { TranscriptionError } from '@lib/transcribe/stitch';

const FIXTURE = fileURLToPath(new URL('../fixtures/audio/speech-mixed.webm', import.meta.url));
const MIXED_MS = 80_408;

function fixtureBlob(): Blob {
  return new Blob([new Uint8Array(readFileSync(FIXTURE))], { type: 'audio/webm;codecs=opus' });
}

describe('DEFAULT_SPLIT_LIMITS', () => {
  it('keeps timing parts under the 30-min timestamp cap and text parts under the 60-min cap', () => {
    expect(DEFAULT_SPLIT_LIMITS).toEqual({ timingMaxPartMs: 28 * 60_000, textMaxPartMs: 55 * 60_000, overlapMs: 30_000 });
  });
});

describe('planParts', () => {
  it('uses the whole recording, once, for both passes when it fits a timing part', async () => {
    const audio = fixtureBlob();
    const plan = await planParts(audio, DEFAULT_SPLIT_LIMITS);
    expect(plan.durationMs).toBe(MIXED_MS);
    expect(plan.timingParts).toHaveLength(1);
    expect(plan.textParts).toHaveLength(1);
    expect(plan.textParts[0]).toBe(plan.timingParts[0]);
    expect(plan.timingParts[0]).toEqual({ data: audio, startMs: 0, endMs: MIXED_MS });
  });

  it('trusts a known duration without parsing the audio', async () => {
    const notWebm = new Blob(['not a webm file'], { type: 'audio/webm' });
    const plan = await planParts(notWebm, DEFAULT_SPLIT_LIMITS, 5000);
    expect(plan.timingParts).toEqual([{ data: notWebm, startMs: 0, endMs: 5000 }]);
  });

  it('cuts overlapping parts per pass when the recording is longer than the limits', async () => {
    const limits = { timingMaxPartMs: 30_000, textMaxPartMs: 50_000, overlapMs: 5_000 };
    const plan = await planParts(fixtureBlob(), limits);
    for (const [parts, max] of [
      [plan.timingParts, limits.timingMaxPartMs],
      [plan.textParts, limits.textMaxPartMs],
    ] as const) {
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0]!.startMs).toBe(0);
      expect(parts.at(-1)!.endMs).toBe(MIXED_MS);
      for (const [k, part] of parts.entries()) {
        expect(part.data).toBeInstanceOf(Uint8Array);
        expect(part.endMs - part.startMs).toBeLessThanOrEqual(max);
        if (k > 0) expect(parts[k - 1]!.endMs - part.startMs).toBeGreaterThanOrEqual(limits.overlapMs);
      }
    }
  });
});

describe('createGeminiMeetingAI', () => {
  it('refuses an empty recording as a failure of both passes, without calling Gemini', async () => {
    const stages: string[] = [];
    const ai = createGeminiMeetingAI('unused-key', { onProgress: (s) => stages.push(s) });
    const err = await ai
      .transcribe(new Blob([], { type: 'audio/webm' }), { customVocabulary: [], languageCodes: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptionError);
    expect((err as TranscriptionError).timingError).toMatch(/no audio/);
    expect(stages).toEqual([]);
  });

  it('rejects with the abort reason when already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('cancelled', 'AbortError'));
    const ai = createGeminiMeetingAI('unused-key');
    await expect(
      ai.transcribe(fixtureBlob(), { customVocabulary: [], languageCodes: [], signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
