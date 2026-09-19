import { beforeAll, describe, expect, it } from 'vitest';
import { splitWebm, webmDurationMs, type WebmPart } from '@lib/audio/webm';
import { expectValidSplit, indexOfBytes, probeTimes, toneHz } from './webm-helpers';

const RATE = 48_000;
const RECORD_MS = 12_000;
const SPLIT = { maxPartMs: 5000, overlapMs: 1000 };
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const CLUSTER_UNKNOWN = [0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

interface Recording {
  bytes: Uint8Array<ArrayBuffer>;
  chunkCount: number;
  elapsedMs: number;
}

/** Records a tone stepping +40 Hz every second, the way the offscreen recorder does. */
async function record(ms: number): Promise<Recording> {
  const ctx = new AudioContext();
  await ctx.resume();
  const osc = ctx.createOscillator();
  for (let i = 0; i <= ms / 1000 + 2; i++) osc.frequency.setValueAtTime(300 + 40 * i, ctx.currentTime + i);
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 1;
  osc.connect(dest);
  osc.start();
  const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const started = new Promise((r) => (rec.onstart = r));
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(1000);
  await started;
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  rec.stop();
  await stopped;
  const elapsedMs = performance.now() - t0;
  await ctx.close();
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return { bytes, chunkCount: chunks.length, elapsedMs };
}

function decode(bytes: Uint8Array): Promise<AudioBuffer> {
  // decodeAudioData detaches its argument, so hand it a copy.
  return new OfflineAudioContext(1, 1, RATE).decodeAudioData(bytes.slice().buffer);
}

async function expectPartsDecode(parts: WebmPart[], full: AudioBuffer): Promise<void> {
  const original = full.getChannelData(0);
  for (const part of parts) {
    const audio = await decode(part.data);
    const lengthMs = part.endMs - part.startMs;
    expect(Math.abs(audio.duration * 1000 - lengthMs)).toBeLessThanOrEqual(100);
    const samples = audio.getChannelData(0);
    for (const t of probeTimes(part)) {
      const want = toneHz(original, full.sampleRate, part.startMs / 1000 + t);
      expect(want).toBeGreaterThan(250);
      expect(Math.abs(toneHz(samples, audio.sampleRate, t) - want)).toBeLessThanOrEqual(10);
    }
  }
}

describe('webm with real Chrome MediaRecorder output', () => {
  let rec: Recording;
  let full: AudioBuffer;

  beforeAll(async () => {
    rec = await record(RECORD_MS);
    full = await decode(rec.bytes);
  }, 40_000);

  it('records live WebM: unknown-size Segment and about one unknown-size Cluster per timeslice', () => {
    expect([...rec.bytes.subarray(36, 48)]).toEqual(SEGMENT_UNKNOWN);
    let clusters = 0;
    let at = indexOfBytes(rec.bytes, CLUSTER_UNKNOWN);
    while (at >= 0) {
      clusters++;
      at = indexOfBytes(rec.bytes, CLUSTER_UNKNOWN, at + 1);
    }
    // The splitter cuts on clusters, so it needs them about one timeslice long. The
    // exact count varies: the flush on stop may or may not open a cluster of its own.
    expect(clusters).toBeGreaterThanOrEqual(rec.chunkCount - 1);
    expect(clusters).toBeLessThanOrEqual(rec.chunkCount + 1);
  });

  it('measures the recorded length', () => {
    const duration = webmDurationMs(rec.bytes);
    expect(Math.abs(duration - rec.elapsedMs)).toBeLessThanOrEqual(500);
    expect(Math.abs(duration - full.duration * 1000)).toBeLessThanOrEqual(100);
  });

  it('splits into ≤5 s parts overlapping by ≥1 s that decodeAudioData accepts', async () => {
    const duration = webmDurationMs(rec.bytes);
    const parts = splitWebm(rec.bytes, SPLIT);
    expectValidSplit(parts, duration, SPLIT.maxPartMs, SPLIT.overlapMs);
    await expectPartsDecode(parts, full);
  });

  it('parses and splits a recording truncated mid-cluster', async () => {
    const fullMs = webmDurationMs(rec.bytes);
    const truncated = rec.bytes.subarray(0, rec.bytes.length - 3000);
    const duration = webmDurationMs(truncated);
    expect(duration).toBeLessThan(fullMs);
    expect(duration).toBeGreaterThan(fullMs - 1000);
    const parts = splitWebm(truncated, SPLIT);
    expectValidSplit(parts, duration, SPLIT.maxPartMs, SPLIT.overlapMs);
    await expectPartsDecode(parts, full);
  });
});
