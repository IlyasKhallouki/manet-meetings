import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeToken } from '@lib/align/sequence';
import { createGeminiMeetingAI } from '@lib/transcribe/ai';
import { TranscriptionError } from '@lib/transcribe/stitch';
import { transcribeParts, type AudioPart } from '@lib/transcribe/transcribe';
import type { JobStage, TimedWord, TranscriptionResult } from '@lib/types';

// Real Gemini. See tests/fixtures/audio/README.md for what the clips contain.
const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const INVALID_KEY = 'manet-test-invalid-key';
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/audio/${name}`, import.meta.url));
const MIXED = fixture('speech-mixed.webm');
const MIXED_MS = 80_408;
/** English is 0–40.2 s of the mixed clip, French 40.2–80.4 s. */
const SWITCH_MS = 40_200;
const VOCABULARY = ['LibriVox', 'Sherlock Holmes', 'Arthur Conan Doyle', 'Jules Verne', 'Phileas Fogg', 'Passepartout'];
const EN_COMMON = new Set(['the', 'of', 'and', 'is', 'this', 'to', 'she', 'all', 'are', 'in', 'for', 'please', 'by']);
const FR_COMMON = new Set(['le', 'la', 'les', 'de', 'du', 'des', 'et', 'un', 'une', 'est', 'dans', 'sont', 'pour', 'ceci', 'comme']);
const FR_DISTINCTIVE = ['verne', 'monde', 'passepartout', 'fogg', 'phileas'];

function blob(path: string): Blob {
  return new Blob([new Uint8Array(readFileSync(path))], { type: 'audio/webm;codecs=opus' });
}

/**
 * Re-encodes [fromMs, toMs) of the mixed clip into a standalone Opus WebM part.
 * Streamed WebM without metadata has no duration, like MediaRecorder output.
 */
function cut(fromMs: number, toMs: number): AudioPart {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-ss', String(fromMs / 1000), '-t', String((toMs - fromMs) / 1000), '-i', MIXED,
      '-map_metadata', '-1', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'],
    { maxBuffer: 16 << 20 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString() ?? r.error?.message}`);
  return { data: new Uint8Array(r.stdout), startMs: fromMs, endMs: toMs };
}

/** Real fetch that counts uploads and deletions. */
function trackingFetch() {
  const counts = { uploads: 0, deletes: 0 };
  const tracked: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (new Headers(init?.headers).get('x-goog-upload-command') === 'start') counts.uploads++;
    if (init?.method === 'DELETE') counts.deletes++;
    return fetch(input, init);
  };
  return { fetch: tracked, counts };
}

const tokens = (ws: TimedWord[]) => ws.map((w) => normalizeToken(w.text));

function expectMixedTranscript(r: TranscriptionResult): void {
  expect(r.timingPass).toEqual({ ok: true });
  expect(r.textPass).toEqual({ ok: true });
  expect(r.words.length).toBeGreaterThan(80);
  expect(r.text).toBe(r.words.map((w) => w.text).join(' '));

  // Timed, monotonic, inside the recording.
  r.words.forEach((w, k) => {
    expect(w.start).toBeGreaterThanOrEqual(0);
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    expect(w.end).toBeLessThanOrEqual(MIXED_MS + 1000);
    if (k > 0) expect(w.start).toBeGreaterThanOrEqual(r.words[k - 1]!.start);
  });
  expect(r.words[0]!.start).toBeLessThan(5000);
  expect(r.words.at(-1)!.end).toBeGreaterThan(70_000);
  // Most words carry timing-pass times rather than interpolated ones.
  expect(r.words.filter((w) => !w.approx).length / r.words.length).toBeGreaterThan(0.6);

  // English first, French second, each landing on the right side of the switch.
  const en = tokens(r.words.filter((w) => w.end <= SWITCH_MS - 1000));
  const fr = tokens(r.words.filter((w) => w.start >= SWITCH_MS + 1000));
  expect(en).toContain('holmes');
  expect(fr.some((t) => FR_DISTINCTIVE.includes(t))).toBe(true);
  expect(en.filter((t) => EN_COMMON.has(t)).length).toBeGreaterThan(5);
  expect(fr.filter((t) => FR_COMMON.has(t)).length).toBeGreaterThan(5);
  expect(en.filter((t) => FR_COMMON.has(t)).length).toBeLessThan(en.filter((t) => EN_COMMON.has(t)).length);

  // Vocabulary spelling from the text pass.
  expect(tokens(r.words)).toContain('librivox');
}

/** A word kept from both sides of an overlap shows up twice, back to back. */
function expectNoOverlapDuplicates(r: TranscriptionResult): void {
  for (let k = 1; k < r.words.length; k++) {
    const a = r.words[k - 1]!;
    const b = r.words[k]!;
    const same = normalizeToken(a.text) !== '' && normalizeToken(a.text) === normalizeToken(b.text);
    expect(same && b.start - a.start < 400, `"${a.text}" twice at ${a.start} and ${b.start} ms`).toBe(false);
  }
}

/** Words of a multi-part run land where the single-part run put them. */
function expectSameTimeline(multi: TranscriptionResult, single: TranscriptionResult): void {
  expect(multi.words.length).toBeGreaterThan(single.words.length * 0.85);
  expect(multi.words.length).toBeLessThan(single.words.length * 1.15);
  let compared = 0;
  for (const token of ['holmes', 'librivox', ...FR_DISTINCTIVE]) {
    const a = multi.words.filter((w) => normalizeToken(w.text) === token).at(-1);
    const b = single.words.filter((w) => normalizeToken(w.text) === token).at(-1);
    if (!a || !b) continue;
    compared++;
    expect(Math.abs(a.start - b.start), token).toBeLessThan(2000);
  }
  expect(compared).toBeGreaterThan(0);
}

describe('transcription against the real API with an invalid key', () => {
  it('fails both passes and reports both messages', async () => {
    const stages: JobStage[] = [];
    const ai = createGeminiMeetingAI(INVALID_KEY);
    const err = await ai
      .transcribe(blob(MIXED), { customVocabulary: VOCABULARY, languageCodes: [], onProgress: (s) => stages.push(s) })
      .catch((e: unknown) => e);
    expect(err, 'needs network access to generativelanguage.googleapis.com').toBeInstanceOf(TranscriptionError);
    const e = err as TranscriptionError;
    expect(e.timingError).toMatch(/API key not valid/);
    expect(e.textError).toMatch(/API key not valid/);
    // A bad key will not fix itself: degrade now rather than retry later.
    expect(e.transient).toBe(false);
    expect(stages).toEqual(['transcribing-timing']);
  });
});

describe.skipIf(!API_KEY)('gemini transcription integration (needs GOOGLE_API_KEY)', () => {
  let single: TranscriptionResult | undefined;

  it('transcribes the bilingual clip in one part, uploading it once', async () => {
    const stages: JobStage[] = [];
    const { fetch, counts } = trackingFetch();
    const ai = createGeminiMeetingAI(API_KEY, { rest: { fetch } });
    single = await ai.transcribe(blob(MIXED), {
      customVocabulary: VOCABULARY,
      languageCodes: [],
      onProgress: (s) => stages.push(s),
    });
    expectMixedTranscript(single);
    expect(counts).toEqual({ uploads: 1, deletes: 1 });
    expect(stages[0]).toBe('transcribing-timing');
    expect(stages.at(-1)).toBe('aligning');
  }, 300_000);

  it.skipIf(!hasFfmpeg)('stitches ffmpeg-cut overlapping parts for both passes (needs ffmpeg)', async () => {
    const { fetch, counts } = trackingFetch();
    const timingParts = [cut(0, 30_000), cut(25_000, 55_000), cut(50_000, MIXED_MS)];
    const textParts = [cut(0, 45_000), cut(40_000, MIXED_MS)];
    const r = await transcribeParts(API_KEY, timingParts, textParts, {
      mimeType: 'audio/webm',
      customVocabulary: VOCABULARY,
      languageCodes: [],
      rest: { fetch },
    });
    expectMixedTranscript(r);
    expectNoOverlapDuplicates(r);
    if (single) expectSameTimeline(r, single);
    expect(counts).toEqual({ uploads: 5, deletes: 5 });
  }, 300_000);

  it.skipIf(!hasFfmpeg)('keeps the other parts when one part fails (needs ffmpeg)', async () => {
    // Real requests; the network "drops" every timing request for the 25–55 s part.
    const { fetch: tracked, counts } = trackingFetch();
    const uriToPart = new Map<string, string>();
    const lossy: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? init.body : '';
      if (/\/interactions$/.test(String(input)) && body.includes('timestamp_granularities')) {
        const uri = (JSON.parse(body) as { input: { uri: string }[] }).input[0]!.uri;
        if (uriToPart.get(uri) === 'manet-25000-55000') throw new TypeError('fetch failed');
      }
      const res = await tracked(input, init);
      if (headers.get('x-goog-upload-command')?.includes('finalize')) {
        const file = ((await res.clone().json()) as { file: { uri: string; displayName: string } }).file;
        uriToPart.set(file.uri, file.displayName);
      }
      return res;
    };
    const r = await transcribeParts(API_KEY, [cut(0, 30_000), cut(25_000, 55_000), cut(50_000, MIXED_MS)], [cut(0, MIXED_MS)], {
      mimeType: 'audio/webm',
      customVocabulary: VOCABULARY,
      languageCodes: [],
      rest: { fetch: lossy, retries: 0 },
    });
    expect(r.timingPass).toEqual({ ok: true, warning: expect.stringMatching(/^timing pass part 2 \(0:25–0:55\) failed: Could not reach Gemini/) });
    expect(r.textPass).toEqual({ ok: true });
    expect(r.gaps).toBeUndefined();
    // The text pass covers the failed span: its words are there, interpolated.
    expect(r.words.some((w) => w.start > 32_000 && w.start < 48_000)).toBe(true);
    expect(r.words.at(-1)!.end).toBeGreaterThan(70_000);
    expect(counts).toEqual({ uploads: 4, deletes: 4 });
  }, 300_000);

  it('splits with the WebM splitter when the limits are small', async () => {
    const ai = createGeminiMeetingAI(API_KEY, {
      limits: { timingMaxPartMs: 30_000, textMaxPartMs: 50_000, overlapMs: 5_000 },
    });
    const r = await ai.transcribe(blob(MIXED), { customVocabulary: VOCABULARY, languageCodes: [] });
    expectMixedTranscript(r);
    expectNoOverlapDuplicates(r);
    if (single) expectSameTimeline(r, single);
  }, 300_000);

  it('passes language hints through', async () => {
    const ai = createGeminiMeetingAI(API_KEY);
    const r = await ai.transcribe(blob(fixture('speech-fr.webm')), {
      customVocabulary: VOCABULARY,
      languageCodes: ['fr-FR'],
    });
    expect(r.timingPass).toEqual({ ok: true });
    expect(r.textPass).toEqual({ ok: true });
    const fr = tokens(r.words);
    expect(fr.filter((t) => FR_COMMON.has(t)).length).toBeGreaterThan(10);
    expect(fr.some((t) => FR_DISTINCTIVE.includes(t))).toBe(true);
  }, 300_000);
});
