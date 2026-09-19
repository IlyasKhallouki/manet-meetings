import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { webmDurationMs } from '@lib/audio/webm';
import { createFileAudioStore } from './fileAudioStore';
import { fixtureBytes, seedAudio, SPEECH_MIXED } from './fixtures';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'manet-audio-'));
  roots.push(root);
  return root;
}

const bytesOf = async (blob: Blob | null) => (blob ? new Uint8Array(await blob.arrayBuffer()) : null);
const chunk = (...values: number[]) => new Blob([new Uint8Array(values)]);

describe('file-backed AudioStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await newRoot();
  });

  it('concatenates chunks in numeric index order, whatever the write order', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('s1', 10, chunk(10, 11));
    await store.writeChunk('s1', 2, chunk(2));
    await store.writeChunk('s1', 0, chunk(0, 1));
    const audio = await store.readAudio('s1');
    expect(audio?.type).toBe('audio/webm');
    expect(await bytesOf(audio)).toEqual(new Uint8Array([0, 1, 2, 10, 11]));
    expect(await store.stat('s1')).toEqual({ chunkCount: 3, bytes: 5 });
  });

  it('uses the OPFS layout: sessions/<id>/audio/<index padded to 6>.webm', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('abc-defg-hij_20260919T101500Z', 42, chunk(1));
    expect(await readdir(join(root, 'sessions', 'abc-defg-hij_20260919T101500Z', 'audio'))).toEqual(['000042.webm']);
  });

  it('replaces a rewritten index instead of appending', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('s1', 0, chunk(1, 2, 3));
    await store.writeChunk('s1', 0, chunk(9));
    expect(await bytesOf(await store.readAudio('s1'))).toEqual(new Uint8Array([9]));
  });

  it('returns null and zero counts for a session without chunks', async () => {
    const store = createFileAudioStore(root);
    expect(await store.readAudio('missing')).toBeNull();
    expect(await store.stat('missing')).toEqual({ chunkCount: 0, bytes: 0 });
  });

  it('ignores empty chunk files, swap files and foreign names, like the OPFS store', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('s1', 1, chunk(7));
    const dir = join(root, 'sessions', 's1', 'audio');
    await writeFile(join(dir, '000000.webm'), new Uint8Array());
    await writeFile(join(dir, '000002.webm.crswap'), new Uint8Array([1]));
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect(await store.stat('s1')).toEqual({ chunkCount: 1, bytes: 1 });
    expect(await bytesOf(await store.readAudio('s1'))).toEqual(new Uint8Array([7]));
  });

  it('lists sessions with committed chunks, sorted by id', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('b-session', 0, chunk(1, 2));
    await store.writeChunk('a-session', 0, chunk(1));
    await store.writeChunk('a-session', 1, chunk(1));
    await mkdir(join(root, 'sessions', 'empty-session', 'audio'), { recursive: true });
    await mkdir(join(root, 'sessions', '.hidden'), { recursive: true });
    expect(await store.list()).toEqual([
      { sessionId: 'a-session', chunkCount: 2, bytes: 2 },
      { sessionId: 'b-session', chunkCount: 1, bytes: 2 },
    ]);
  });

  it('lists nothing before anything was written', async () => {
    expect(await createFileAudioStore(root).list()).toEqual([]);
  });

  it('deletes the audio but keeps files other modules put in the session directory', async () => {
    const store = createFileAudioStore(root);
    await store.writeChunk('s1', 0, chunk(1));
    await store.writeChunk('s2', 0, chunk(1));
    await writeFile(join(root, 'sessions', 's2', 'captions.json'), '[]');
    await store.delete('s1');
    await store.delete('s2');
    await store.delete('never-written');
    expect(await store.readAudio('s1')).toBeNull();
    expect(await readdir(join(root, 'sessions'))).toEqual(['s2']);
    expect(await readdir(join(root, 'sessions', 's2'))).toEqual(['captions.json']);
  });

  it('commits overlapping writes to one session in call order', async () => {
    const store = createFileAudioStore(root);
    await Promise.all([1, 2, 3].map((v) => store.writeChunk('s1', 0, chunk(v))));
    expect(await bytesOf(await store.readAudio('s1'))).toEqual(new Uint8Array([3]));
  });

  it('rejects invalid session ids and indices before touching the disk', async () => {
    const store = createFileAudioStore(root);
    await expect(store.writeChunk('../escape', 0, chunk(1))).rejects.toThrow(TypeError);
    await expect(store.writeChunk('s1', -1, chunk(1))).rejects.toThrow(RangeError);
    await expect(store.writeChunk('s1', 1.5, chunk(1))).rejects.toThrow(RangeError);
    await expect(store.readAudio('a/b')).rejects.toThrow(TypeError);
    await expect(store.delete('')).rejects.toThrow(TypeError);
    expect(await readdir(root)).toEqual([]);
  });

  it('round-trips a real recording split into chunks', async () => {
    const store = createFileAudioStore(root);
    const chunks = await seedAudio(store, 'speech', SPEECH_MIXED, 16_384);
    expect(chunks).toBeGreaterThan(5);
    const audio = await bytesOf(await store.readAudio('speech'));
    // Buffer.equals: deep equality on 350 KB of bytes takes seconds.
    expect(Buffer.from(audio!).equals(fixtureBytes(SPEECH_MIXED))).toBe(true);
    expect(webmDurationMs(audio!)).toBeGreaterThan(80_000);
  });
});
