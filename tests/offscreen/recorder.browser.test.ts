import { afterEach, describe, expect, it } from 'vitest';
import { createMixer } from '../../entrypoints/offscreen/mixer';
import {
  startRecording,
  type ChunkInfo,
  type Recording,
  type RecordingOptions,
  type RecordingStopped,
} from '../../entrypoints/offscreen/recorder';
import { decode, endable, sleep, testStore, tone, type Tone } from './helpers';

const SESSION = 'abc-defg-hij_20260919T101500Z';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function source(hz = 440, opts: Parameters<typeof tone>[1] = {}): Promise<Tone> {
  const t = await tone(hz, opts);
  cleanups.push(() => t.close());
  return t;
}

async function store() {
  const s = await testStore();
  cleanups.push(() => s.cleanup());
  return s;
}

/** Starts a recording that is stopped after the test, and captures its callbacks. */
async function record(opts: Omit<RecordingOptions, 'onChunk' | 'onStop'>) {
  const chunks: ChunkInfo[] = [];
  const stops: RecordingStopped[] = [];
  let resolveStopped!: (s: RecordingStopped) => void;
  const stopped = new Promise<RecordingStopped>((r) => (resolveStopped = r));
  const rec: Recording = await startRecording({
    ...opts,
    onChunk: (c) => chunks.push(c),
    onStop: (s) => {
      stops.push(s);
      resolveStopped(s);
    },
  });
  cleanups.push(() => rec.stop());
  return { rec, chunks, stops, stopped };
}

describe('startRecording', () => {
  it('writes chunks to OPFS in order while it records', async () => {
    const t = await source();
    const { store: audio } = await store();
    const { rec, chunks } = await record({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 250 });
    await sleep(1300);

    const mid = await audio.stat(SESSION);
    expect(mid.chunkCount).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.index)).toEqual([...chunks.keys()]);
    let total = 0;
    for (const c of chunks) {
      total += c.size;
      expect(c).toMatchObject({ chunkCount: c.index + 1, bytes: total });
      expect(c.size).toBeGreaterThan(0);
    }

    const result = await rec.stop();
    expect(result.reason).toBe('requested');
    expect(result.error).toBeUndefined();
    expect(result.chunkCount).toBe(chunks.length);
    expect(result.bytes).toBe(chunks.at(-1)?.bytes);
    expect(await audio.stat(SESSION)).toEqual({ chunkCount: result.chunkCount, bytes: result.bytes });
  });

  it('records Opus WebM at about 32 kb/s and stamps startedAt when recording starts', async () => {
    const t = await source();
    const { store: audio } = await store();
    const before = Date.now();
    const { rec } = await record({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 500 });
    const after = Date.now();
    expect(rec.startedAt).toBeGreaterThanOrEqual(before);
    expect(rec.startedAt).toBeLessThanOrEqual(after);
    expect(rec.sessionId).toBe(SESSION);
    expect(rec.mimeType.toLowerCase().replace(/\s/g, '')).toBe('audio/webm;codecs=opus');
    await sleep(3000);
    const { bytes } = await rec.stop();
    const kbps = (bytes * 8) / 1000 / ((Date.now() - rec.startedAt) / 1000);
    expect(kbps).toBeGreaterThan(8);
    expect(kbps).toBeLessThan(48);
  });

  it('produces audio that decodes as mono to the recorded duration, through the mixer', async () => {
    const tab = await source(440, { channel: 'left' });
    const mic = await source(1000);
    const mixer = createMixer({ tabStream: tab.stream, micStream: mic.stream });
    cleanups.push(() => mixer.close());
    const { store: audio } = await store();
    const { rec } = await record({ sessionId: SESSION, stream: mixer.stream, store: audio, timesliceMs: 500 });
    await sleep(2200);
    await rec.stop();
    const elapsedMs = Date.now() - rec.startedAt;

    const blob = await audio.readAudio(SESSION);
    expect(blob).not.toBeNull();
    const decoded = await decode(blob!);
    expect(decoded.numberOfChannels).toBe(1);
    expect(Math.abs(decoded.duration * 1000 - elapsedMs)).toBeLessThan(300);
  });

  it('persists the final partial chunk before stop() resolves', async () => {
    const t = await source();
    const { store: audio } = await store();
    const { rec, stops } = await record({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 1000 });
    await sleep(1700);
    const result = await rec.stop();
    const elapsedMs = Date.now() - rec.startedAt;

    expect(stops).toEqual([result]);
    expect(await audio.stat(SESSION)).toEqual({ chunkCount: result.chunkCount, bytes: result.bytes });
    const decoded = await decode((await audio.readAudio(SESSION))!);
    // Only whole timeslices would give 1 s; the flushed tail brings it to ~1.7 s.
    expect(Math.abs(decoded.duration * 1000 - elapsedMs)).toBeLessThan(300);
    expect(await rec.stop()).toBe(result);
    expect(stops).toHaveLength(1);
  });

  it("stops with 'track-ended' when the tab track ends, keeping the audio", async () => {
    const tab = endable(await source());
    const mixer = createMixer({ tabStream: tab.stream, micStream: null });
    cleanups.push(() => mixer.close());
    const { store: audio } = await store();
    const { rec, stopped, stops } = await record({
      sessionId: SESSION,
      stream: mixer.stream,
      store: audio,
      timesliceMs: 250,
      endOnTracks: [tab.track],
    });
    await sleep(900);
    tab.end();

    const result = await stopped;
    expect(result.reason).toBe('track-ended');
    expect(result.chunkCount).toBeGreaterThanOrEqual(3);
    expect(await audio.stat(SESSION)).toEqual({ chunkCount: result.chunkCount, bytes: result.bytes });
    const decoded = await decode((await audio.readAudio(SESSION))!);
    expect(decoded.duration).toBeGreaterThan(0.7);
    expect(await rec.stop()).toBe(result);
    expect(stops).toHaveLength(1);
  });

  it("stops with 'track-ended' when the recorded stream ends by itself", async () => {
    const t = await source();
    const { store: audio } = await store();
    const { stopped } = await record({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 250 });
    await sleep(600);
    // stop() on a track fires no 'ended' event, but MediaRecorder stops once its stream is dead.
    t.track.stop();
    const result = await stopped;
    expect(result.reason).toBe('track-ended');
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(await audio.stat(SESSION)).toEqual({ chunkCount: result.chunkCount, bytes: result.bytes });
  });

  it("reports a MediaRecorder error as 'error' and keeps the audio so far", async () => {
    const t = await source();
    const extra = await source(880);
    const { store: audio } = await store();
    const { stopped } = await record({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 250 });
    await sleep(600);
    // Changing the track set of a stream being recorded is a real recorder error.
    t.stream.addTrack(extra.track);
    const result = await stopped;
    expect(result.reason).toBe('error');
    expect(result.error).toMatch(/InvalidModificationError/);
    expect(result.chunkCount).toBeGreaterThan(0);
    const decoded = await decode((await audio.readAudio(SESSION))!);
    expect(decoded.duration).toBeGreaterThan(0.4);
  });

  it("stops with 'error' when a chunk cannot be saved, and saves nothing after it", async () => {
    const t = await source();
    const s = await store();
    const { rec, chunks, stopped } = await record({
      sessionId: SESSION,
      stream: t.stream,
      store: s.store,
      timesliceMs: 200,
    });
    await sleep(700);
    const saved = chunks.length;
    expect(saved).toBeGreaterThan(0);
    await s.removeRoot();

    const result = await stopped;
    expect(result.reason).toBe('error');
    expect(result.error).toMatch(new RegExp(`chunk ${saved}\\b.*NotFoundError`));
    expect(result.chunkCount).toBe(saved);
    expect(chunks).toHaveLength(saved);
    expect(await rec.stop()).toBe(result);
  });

  it('rejects a non-positive timeslice', async () => {
    const t = await source();
    const { store: audio } = await store();
    await expect(startRecording({ sessionId: SESSION, stream: t.stream, store: audio, timesliceMs: 0 })).rejects.toThrow(
      RangeError,
    );
  });

  it('rejects a tab track that has already ended', async () => {
    const tab = endable(await source());
    tab.end();
    for (let i = 0; i < 50 && tab.track.readyState !== 'ended'; i++) await sleep(20);
    expect(tab.track.readyState).toBe('ended');
    const mixer = createMixer({ tabStream: tab.stream, micStream: null });
    cleanups.push(() => mixer.close());
    const { store: audio } = await store();
    const opts = { sessionId: SESSION, stream: mixer.stream, store: audio, timesliceMs: 250, endOnTracks: [tab.track] };
    await expect(startRecording(opts)).rejects.toThrow(/ended/);
  });
});
