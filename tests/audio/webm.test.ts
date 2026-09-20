import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitWebm, webmDurationMs, type WebmPart } from '@lib/audio/webm';
import { concatBytes, expectValidSplit, indexOfBytes, probeTimes, toneHz } from './webm-helpers';

// Real Chrome 151 MediaRecorder output ('audio/webm;codecs=opus', mono, 32 kbps, timeslice
// 1000 ms) of a tone stepping +40 Hz every second: unknown-size Segment, one unknown-size
// Cluster per timeslice, 60 ms SimpleBlocks. Expected numbers below were read off the
// file with an independent EBML dump.
const chrome = new Uint8Array(
  readFileSync(resolve(import.meta.dirname, '../fixtures/audio/tone-chrome-12s.webm')),
);
const CHROME_MS = 11_942;
const CHROME_LAST_BLOCK_MS = CHROME_MS - 60;
const CHROME_CLUSTER_STARTS = [0, 1025, 2037, 3062, 4085, 5099, 6122, 7136, 8159, 9184, 10197, 11222];

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const TIMECODE_SCALE_1MS = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
const VOID_1 = [0xec, 0x81, 0x00];
// The fixture is CBR: every SimpleBlock is A3 40 F3 + 243 bytes (track 1, 60 ms of Opus).
const BLOCK_BYTES = 246;

const firstCluster = indexOfBytes(chrome, CLUSTER_ID);
// Cluster ID + 8-byte unknown size, then Timecode (E7 81 00).
const firstClusterBody = firstCluster + 12 + 3;

function span(parts: WebmPart[]): Array<[number, number]> {
  return parts.map((p) => [p.startMs, p.endMs]);
}

/** Rewrites the file's last SimpleBlock as a BlockGroup, optionally with a BlockDuration. */
function lastBlockAsBlockGroup(durationMs?: number, source: Uint8Array = chrome): Uint8Array {
  const at = source.length - BLOCK_BYTES;
  expect([...source.subarray(at, at + 3)]).toEqual([0xa3, 0x40, 0xf3]);
  const body = source.slice(at + 3);
  body[3] = body[3]! & 0x7f; // Block flags have no keyframe bit
  const block = concatBytes([0xa1, 0x40, 0xf3], body);
  const extra = durationMs === undefined ? [] : [0x9b, 0x81, durationMs];
  const group = concatBytes([0xa0, 0x40, block.length + extra.length], block, extra);
  return concatBytes(source.subarray(0, at), group);
}

/** Void elements before the first Cluster and inside it, right after its Timecode. */
function withVoids(source: Uint8Array = chrome): Uint8Array {
  return concatBytes(
    source.subarray(0, firstCluster),
    VOID_1,
    source.subarray(firstCluster, firstClusterBody),
    VOID_1,
    source.subarray(firstClusterBody),
  );
}

describe('webmDurationMs', () => {
  it('reads the duration of a live Chrome recording (unknown-size Segment and Clusters)', () => {
    expect([...chrome.subarray(36, 48)]).toEqual(SEGMENT_UNKNOWN);
    expect(webmDurationMs(chrome)).toBe(CHROME_MS);
  });

  it('honours TimecodeScale from Info', () => {
    const at = indexOfBytes(chrome, TIMECODE_SCALE_1MS);
    expect(at).toBeGreaterThan(0);
    const scaled = chrome.slice();
    scaled.set([0x1e, 0x84, 0x80], at + 4); // 2 ms per tick
    // Block times double; the last Opus packet still lasts 60 ms.
    expect(webmDurationMs(scaled)).toBe(2 * CHROME_LAST_BLOCK_MS + 60);
  });

  it('drops a truncated trailing block', () => {
    expect(webmDurationMs(chrome.subarray(0, chrome.length - 1500))).toBe(11_517);
    // Chrome stamps blocks with capture times, so they are not exactly 60 ms apart.
    expect(webmDurationMs(chrome.subarray(0, chrome.length - 1))).toBe(11_222 + 597 + 60);
  });

  it('skips Void elements at segment and cluster level', () => {
    expect(webmDurationMs(withVoids())).toBe(CHROME_MS);
  });

  it('reads BlockGroups, preferring their BlockDuration', () => {
    expect(webmDurationMs(lastBlockAsBlockGroup())).toBe(CHROME_MS);
    expect(webmDurationMs(lastBlockAsBlockGroup(25))).toBe(CHROME_LAST_BLOCK_MS + 25);
  });

  it('rejects data that is not WebM', () => {
    expect(() => webmDurationMs(new Uint8Array(0))).toThrow(/not a WebM/i);
    expect(() => webmDurationMs(new TextEncoder().encode('hello world'))).toThrow(/not a WebM/i);
    expect(() => webmDurationMs(Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]))).toThrow(/not a WebM/i);
    expect(() => webmDurationMs(chrome.subarray(0, 20))).toThrow(/not a WebM/i);
  });

  it('rejects WebM without clusters', () => {
    expect(() => webmDurationMs(chrome.subarray(0, firstCluster))).toThrow(/no clusters/i);
    // A cluster cut before its first block is complete counts as no cluster.
    expect(() => webmDurationMs(chrome.subarray(0, firstClusterBody + 100))).toThrow(/no clusters/i);
  });
});

describe('splitWebm', () => {
  it('returns the original bytes as a single part when short enough', () => {
    const parts = splitWebm(chrome, { maxPartMs: 20_000, overlapMs: 1000 });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.data).toEqual(chrome);
    expect(parts[0]?.startMs).toBe(0);
    expect(parts[0]?.endMs).toBe(CHROME_MS);
    expect(splitWebm(chrome, { maxPartMs: CHROME_MS, overlapMs: 1000 })).toHaveLength(1);
  });

  it('cuts on cluster boundaries with the requested overlap', () => {
    const parts = splitWebm(chrome, { maxPartMs: 5000, overlapMs: 1000 });
    expectValidSplit(parts, CHROME_MS, 5000, 1000);
    for (const part of parts) expect(CHROME_CLUSTER_STARTS).toContain(part.startMs);
    expect(span(parts)).toEqual([
      [0, 4082],
      [3062, 7141],
      [6122, 10204],
      [9184, 11942],
    ]);
  });

  it('builds each part as EBML header + unknown-size Segment with rebased timecodes', () => {
    const ebmlHeader = chrome.subarray(0, 36);
    for (const part of splitWebm(chrome, { maxPartMs: 5000, overlapMs: 1000 })) {
      expect(part.data.subarray(0, 36)).toEqual(ebmlHeader);
      expect([...part.data.subarray(36, 48)]).toEqual(SEGMENT_UNKNOWN);
      // Rebased: the part's own timeline runs from 0 to its length.
      expect(webmDurationMs(part.data)).toBe(part.endMs - part.startMs);
      expect(splitWebm(part.data, { maxPartMs: 5000, overlapMs: 1000 })).toHaveLength(1);
    }
  });

  it('keeps start/end in the original timeline when TimecodeScale is not 1 ms', () => {
    const scaled = chrome.slice();
    scaled.set([0x1e, 0x84, 0x80], indexOfBytes(chrome, TIMECODE_SCALE_1MS) + 4);
    const duration = 2 * CHROME_LAST_BLOCK_MS + 60;
    const parts = splitWebm(scaled, { maxPartMs: 10_000, overlapMs: 2000 });
    expectValidSplit(parts, duration, 10_000, 2000);
    for (const part of parts) expect(CHROME_CLUSTER_STARTS.map((t) => 2 * t)).toContain(part.startMs);
    for (const part of parts) expect(webmDurationMs(part.data)).toBe(part.endMs - part.startMs);
  });

  it('splits truncated, Void-laden and BlockGroup recordings', () => {
    const truncated = splitWebm(chrome.subarray(0, chrome.length - 1500), { maxPartMs: 5000, overlapMs: 1000 });
    expectValidSplit(truncated, 11_517, 5000, 1000);
    for (const part of truncated) expect(webmDurationMs(part.data)).toBe(part.endMs - part.startMs);

    const voids = splitWebm(withVoids(), { maxPartMs: 5000, overlapMs: 1000 });
    expect(span(voids)).toEqual(span(splitWebm(chrome, { maxPartMs: 5000, overlapMs: 1000 })));
    for (const part of voids) expect(indexOfBytes(part.data, VOID_1)).toBe(-1);

    const grouped = splitWebm(lastBlockAsBlockGroup(25), { maxPartMs: 5000, overlapMs: 1000 });
    expectValidSplit(grouped, CHROME_LAST_BLOCK_MS + 25, 5000, 1000);
    expect(webmDurationMs(grouped.at(-1)!.data)).toBe(CHROME_LAST_BLOCK_MS + 25 - 9184);
  });

  it('rejects impossible options and clusters longer than a part', () => {
    expect(() => splitWebm(chrome, { maxPartMs: 0, overlapMs: 0 })).toThrow(RangeError);
    expect(() => splitWebm(chrome, { maxPartMs: 5000, overlapMs: 5000 })).toThrow(RangeError);
    expect(() => splitWebm(chrome, { maxPartMs: 5000, overlapMs: -1 })).toThrow(RangeError);
    expect(() => splitWebm(chrome, { maxPartMs: Number.NaN, overlapMs: 0 })).toThrow(RangeError);
    // ~1 s clusters cannot fit in 900 ms parts, nor overlap by 1 s within 1.5 s parts.
    expect(() => splitWebm(chrome, { maxPartMs: 900, overlapMs: 100 })).toThrow(/cannot split/i);
    expect(() => splitWebm(chrome, { maxPartMs: 1500, overlapMs: 1000 })).toThrow(/cannot split/i);
  });

  it('rejects data that is not WebM', () => {
    const opts = { maxPartMs: 5000, overlapMs: 0 };
    expect(() => splitWebm(new TextEncoder().encode('hello'), opts)).toThrow(/not a WebM/i);
    expect(() => splitWebm(chrome.subarray(0, firstCluster), opts)).toThrow(/no clusters/i);
  });
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('splitWebm output decodes with ffmpeg (needs ffmpeg + ffprobe on PATH)', () => {
  const RATE = 48_000;
  let dir = '';
  const files = new Map<string, Uint8Array>();

  // 300 Hz stepping +25 Hz every second, mono Opus 48 kbps.
  const steppedTone = (secs: number) => [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `aevalsrc=sin(2*PI*(300+25*floor(t))*t):s=${RATE}:d=${secs}`,
    '-ac', '1', '-c:a', 'libopus', '-b:a', '48k',
  ];

  function decode(file: string): { pcm: Int16Array; stderr: string; status: number | null } {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(RATE), '-'], {
      maxBuffer: 1 << 28,
    });
    const bytes = new Uint8Array(r.stdout);
    const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
    return { pcm, stderr: r.stderr.toString(), status: r.status };
  }

  function probe(file: string): { durationMs: number; startMs: number } {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration:stream=start_time', '-of', 'json', file],
      { encoding: 'utf8' },
    );
    const json = JSON.parse(out) as { format?: { duration?: string }; streams?: Array<{ start_time?: string }> };
    return {
      durationMs: Number(json.format?.duration ?? Number.NaN) * 1000,
      startMs: Number(json.streams?.[0]?.start_time ?? Number.NaN) * 1000,
    };
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'manet-webm-'));
    const make = (name: string, args: string[]) => {
      execFileSync('ffmpeg', [...args, join(dir, name)]);
      files.set(name, new Uint8Array(readFileSync(join(dir, name))));
    };
    // Seekable output: known sizes, SeekHead, Void, Tags, Cues, Duration, ~5 s clusters,
    // and a trailing BlockGroup (BlockDuration + DiscardPadding).
    make('steps-95.webm', steppedTone(95));
    make('steps-95-small.webm', [...steppedTone(95), '-cluster_time_limit', '700']);
    // Non-seekable output: unknown-size Segment, no Cues.
    const live = execFileSync('ffmpeg', [...steppedTone(40), '-live', '1', '-f', 'webm', 'pipe:1'], {
      maxBuffer: 1 << 26,
    });
    writeFileSync(join(dir, 'steps-40-live.webm'), live);
    files.set('steps-40-live.webm', new Uint8Array(live));
    // A known-size Cluster cut in the middle.
    const full = files.get('steps-95.webm')!;
    files.set('steps-95-truncated.webm', full.slice(0, full.length - 5000));
    writeFileSync(join(dir, 'steps-95-truncated.webm'), files.get('steps-95-truncated.webm')!);
    files.set('chrome-12.webm', chrome);
    writeFileSync(join(dir, 'chrome-12.webm'), chrome);
    const chromeTruncated = chrome.subarray(0, chrome.length - 1500);
    files.set('chrome-12-truncated.webm', chromeTruncated);
    writeFileSync(join(dir, 'chrome-12-truncated.webm'), chromeTruncated);
    const chromeEdited = lastBlockAsBlockGroup(undefined, withVoids());
    files.set('chrome-12-voids-blockgroup.webm', chromeEdited);
    writeFileSync(join(dir, 'chrome-12-voids-blockgroup.webm'), chromeEdited);
  }, 60_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('matches the duration ffmpeg wrote for seekable files, BlockGroup tail included', () => {
    for (const name of ['steps-95.webm', 'steps-95-small.webm']) {
      const expected = probe(join(dir, name)).durationMs;
      // Within one Opus frame: we add the last packet's real length from its TOC byte,
      // while ffprobe reports the muxer's own rounded Duration element, and how those two
      // land depends on the ffmpeg build's frame size.
      expect(Math.abs(webmDurationMs(files.get(name)!) - expected)).toBeLessThanOrEqual(60);
    }
  });

  it.each([
    { name: 'steps-95.webm', maxPartMs: 30_000, overlapMs: 5000 },
    { name: 'steps-95-small.webm', maxPartMs: 10_000, overlapMs: 2000 },
    { name: 'steps-40-live.webm', maxPartMs: 15_000, overlapMs: 3000 },
    { name: 'steps-95-truncated.webm', maxPartMs: 30_000, overlapMs: 5000 },
    { name: 'chrome-12.webm', maxPartMs: 5000, overlapMs: 1000 },
    { name: 'chrome-12-truncated.webm', maxPartMs: 5000, overlapMs: 1000 },
    { name: 'chrome-12-voids-blockgroup.webm', maxPartMs: 5000, overlapMs: 1000 },
  ])('$name → parts ≤ $maxPartMs ms that decode cleanly at the right times', ({ name, maxPartMs, overlapMs }) => {
    const data = files.get(name)!;
    const original = decode(join(dir, name)).pcm;
    const durationMs = webmDurationMs(data);
    // Decoded length ≈ timeline length (Opus pre-skip and timestamp jitter are a few ms).
    expect(Math.abs(original.length / (RATE / 1000) - durationMs)).toBeLessThanOrEqual(30);

    const parts = splitWebm(data, { maxPartMs, overlapMs });
    expectValidSplit(parts, durationMs, maxPartMs, overlapMs);

    parts.forEach((part, i) => {
      const file = join(dir, `${name}.part${i}.webm`);
      writeFileSync(file, part.data);
      const { pcm, stderr, status } = decode(file);
      expect(stderr).toBe('');
      expect(status).toBe(0);

      const lengthMs = part.endMs - part.startMs;
      expect(Math.abs(pcm.length / (RATE / 1000) - lengthMs)).toBeLessThanOrEqual(40);
      const info = probe(file);
      expect(Math.abs(info.startMs)).toBeLessThanOrEqual(50);
      expect(Math.abs(info.durationMs - lengthMs)).toBeLessThanOrEqual(2);

      for (const t of probeTimes(part)) {
        const got = toneHz(pcm, RATE, t);
        const want = toneHz(original, RATE, part.startMs / 1000 + t);
        expect(want).toBeGreaterThan(250);
        expect(Math.abs(got - want)).toBeLessThanOrEqual(8);
      }

      // No elements with absolute positions survive (SeekHead, Cues, Tags).
      for (const id of [[0x11, 0x4d, 0x9b, 0x74], [0x1c, 0x53, 0xbb, 0x6b], [0x12, 0x54, 0xc3, 0x67]]) {
        expect(indexOfBytes(part.data, id)).toBe(-1);
      }
    });
  });
});
