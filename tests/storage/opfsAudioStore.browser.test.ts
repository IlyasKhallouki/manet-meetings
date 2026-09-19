import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpfsAudioStore, storageUsage } from '@lib/storage/opfsAudioStore';
import type { AudioStore } from '@lib/types';
import { sessionId } from '@lib/util/ids';

// The repo's TS lib set has no DOM.AsyncIterable, so directory iteration is typed locally.
type IterableDir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

async function names(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const out: string[] = [];
  for await (const [name] of (dir as IterableDir).entries()) out.push(name);
  return out.sort();
}

async function dirAt(root: FileSystemDirectoryHandle, ...path: string[]): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const name of path) dir = await dir.getDirectoryHandle(name, { create: true });
  return dir;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function readText(store: AudioStore, id: string): Promise<string | null> {
  const audio = await store.readAudio(id);
  return audio ? audio.text() : null;
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  // getRandomValues fills at most 64 KiB per call.
  for (let i = 0; i < n; i += 65_536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65_536)));
  return out;
}

function shuffled<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ID = sessionId('abc-defg-hij', Date.UTC(2026, 8, 19, 10, 15, 0));
const OTHER = sessionId('xyz-abcd-efg', Date.UTC(2026, 8, 19, 14, 0, 0));

describe('OPFS audio store (real Chrome OPFS)', () => {
  let opfs: FileSystemDirectoryHandle;
  let rootName: string;
  let root: FileSystemDirectoryHandle;
  let store: AudioStore;

  beforeEach(async () => {
    opfs = await navigator.storage.getDirectory();
    rootName = `opfs-audio-test-${crypto.randomUUID()}`;
    root = await opfs.getDirectoryHandle(rootName, { create: true });
    store = createOpfsAudioStore(async () => root);
  });

  afterEach(async () => {
    await opfs.removeEntry(rootName, { recursive: true });
  });

  it('lays chunks out as sessions/<id>/audio/<6-digit index>.webm', async () => {
    await store.writeChunk(ID, 0, new Blob(['a']));
    await store.writeChunk(ID, 7, new Blob(['b']));
    await store.writeChunk(ID, 123_456, new Blob(['c']));
    expect(await names(root)).toEqual(['sessions']);
    expect(await names(await dirAt(root, 'sessions'))).toEqual([ID]);
    expect(await names(await dirAt(root, 'sessions', ID))).toEqual(['audio']);
    expect(await names(await dirAt(root, 'sessions', ID, 'audio'))).toEqual([
      '000000.webm',
      '000007.webm',
      '123456.webm',
    ]);
  });

  it('reads chunks back in numeric index order, well beyond 10 chunks', async () => {
    const indices = Array.from({ length: 25 }, (_, i) => i);
    for (const i of shuffled(indices)) await store.writeChunk(ID, i, new Blob([`<${i}>`]));
    // Past the zero padding, name order and numeric order disagree.
    await store.writeChunk(ID, 1_000_000, new Blob(['<1000000>']));
    await store.writeChunk(ID, 999_999, new Blob(['<999999>']));

    const audio = await store.readAudio(ID);
    expect(audio?.type).toBe('audio/webm');
    expect(await audio?.text()).toBe(indices.map((i) => `<${i}>`).join('') + '<999999><1000000>');
  });

  it('round-trips binary chunks byte for byte', async () => {
    const parts = [randomBytes(1), randomBytes(4_099), randomBytes(300_000), randomBytes(65_536)];
    for (const [i, part] of parts.entries()) await store.writeChunk(ID, i, new Blob([part]));

    const audio = await store.readAudio(ID);
    expect(audio).not.toBeNull();
    expect(await bytesOf(audio as Blob)).toEqual(await bytesOf(new Blob(parts)));
    expect(audio?.size).toBe(parts.reduce((n, p) => n + p.length, 0));
  });

  it('overwrites a chunk rewritten at the same index', async () => {
    await store.writeChunk(ID, 0, new Blob(['first version, longer']));
    await store.writeChunk(ID, 0, new Blob(['second']));
    expect(await readText(store, ID)).toBe('second');
    expect(await store.stat(ID)).toEqual({ chunkCount: 1, bytes: 6 });
  });

  it('reports chunk count and bytes with stat', async () => {
    await store.writeChunk(ID, 0, new Blob([randomBytes(1000)]));
    await store.writeChunk(ID, 1, new Blob([randomBytes(2500)]));
    await store.writeChunk(ID, 2, new Blob([randomBytes(7)]));
    expect(await store.stat(ID)).toEqual({ chunkCount: 3, bytes: 3507 });
  });

  it('treats a session with no audio as empty: null audio, zero stat, not listed', async () => {
    expect(await store.readAudio(ID)).toBeNull();
    expect(await store.stat(ID)).toEqual({ chunkCount: 0, bytes: 0 });
    expect(await store.list()).toEqual([]);
    await expect(store.delete(ID)).resolves.toBeUndefined();

    // Directories that exist but hold no chunk are still "no audio".
    await dirAt(root, 'sessions', ID, 'audio');
    expect(await store.readAudio(ID)).toBeNull();
    expect(await store.stat(ID)).toEqual({ chunkCount: 0, bytes: 0 });
    expect(await store.list()).toEqual([]);
  });

  it('ignores stale .crswap files, crash-emptied chunks and other stray entries', async () => {
    await store.writeChunk(ID, 0, new Blob(['aa']));
    await store.writeChunk(ID, 1, new Blob(['bbb']));
    const audioDir = await dirAt(root, 'sessions', ID, 'audio');
    // What Chrome leaves after dying mid-write: the swap file with the data, and the
    // target created empty by getFileHandle({ create: true }) but never committed.
    await writeFile(audioDir, '000002.webm.crswap', 'uncommitted swap data');
    await audioDir.getFileHandle('000002.webm', { create: true });
    await writeFile(audioDir, '000001.webm.crswap', 'older swap data');
    await writeFile(audioDir, 'notes.txt', 'not audio');
    await writeFile(audioDir, '12.webm', 'unpadded name');
    await dirAt(audioDir, '000003.webm');

    expect(await readText(store, ID)).toBe('aabbb');
    expect(await store.stat(ID)).toEqual({ chunkCount: 2, bytes: 5 });
    expect(await store.list()).toEqual([{ sessionId: ID, chunkCount: 2, bytes: 5 }]);

    // A session whose only entries are crash leftovers has no audio.
    const leftovers = await dirAt(root, 'sessions', OTHER, 'audio');
    await writeFile(leftovers, '000000.webm.crswap', 'junk');
    await leftovers.getFileHandle('000000.webm', { create: true });
    expect(await store.readAudio(OTHER)).toBeNull();
    expect(await store.stat(OTHER)).toEqual({ chunkCount: 0, bytes: 0 });
    expect(await store.list()).toEqual([{ sessionId: ID, chunkCount: 2, bytes: 5 }]);
  });

  it('lists every session directory that has at least one chunk, sorted by id', async () => {
    await store.writeChunk(OTHER, 0, new Blob(['1234']));
    await store.writeChunk(ID, 0, new Blob(['12']));
    await store.writeChunk(ID, 1, new Blob(['345']));
    await dirAt(root, 'sessions', 'empty-session', 'audio');
    await dirAt(root, 'sessions', 'not a session id', 'audio');
    await writeFile(await dirAt(root, 'sessions'), 'stray.txt', 'x');

    expect(await store.list()).toEqual([
      { sessionId: ID, chunkCount: 2, bytes: 5 },
      { sessionId: OTHER, chunkCount: 1, bytes: 4 },
    ]);
  });

  it('deletes one session’s audio and leaves the others alone', async () => {
    await store.writeChunk(ID, 0, new Blob(['a']));
    await store.writeChunk(ID, 1, new Blob(['b']));
    await store.writeChunk(OTHER, 0, new Blob(['c']));

    await store.delete(ID);
    expect(await store.readAudio(ID)).toBeNull();
    expect(await store.stat(ID)).toEqual({ chunkCount: 0, bytes: 0 });
    expect(await store.list()).toEqual([{ sessionId: OTHER, chunkCount: 1, bytes: 1 }]);
    expect(await names(await dirAt(root, 'sessions'))).toEqual([OTHER]);
    expect(await readText(store, OTHER)).toBe('c');

    // Deleting again, or writing afterwards, both still work.
    await store.delete(ID);
    await store.writeChunk(ID, 0, new Blob(['new']));
    expect(await readText(store, ID)).toBe('new');
  });

  it('deletes only the audio when the session directory holds other files', async () => {
    await store.writeChunk(ID, 0, new Blob(['a']));
    await writeFile(await dirAt(root, 'sessions', ID), 'other-module.json', '{}');

    await store.delete(ID);
    expect(await store.readAudio(ID)).toBeNull();
    expect(await names(await dirAt(root, 'sessions', ID))).toEqual(['other-module.json']);
  });

  it('serializes overlapping writeChunk calls so every chunk lands, in call order', async () => {
    const writes = shuffled(Array.from({ length: 40 }, (_, i) => i)).map((i) =>
      store.writeChunk(ID, i, new Blob([`[${i}]`])),
    );
    await Promise.all(writes);
    expect(await readText(store, ID)).toBe(Array.from({ length: 40 }, (_, i) => `[${i}]`).join(''));

    // Same index, a slow large write then a quick small one: without serialization the
    // small one commits first and the large one overwrites it.
    const big = new Blob([randomBytes(8 * 1024 * 1024)]);
    const both = [store.writeChunk(OTHER, 0, big), store.writeChunk(OTHER, 0, new Blob(['last write wins']))];
    await Promise.all(both);
    expect(await readText(store, OTHER)).toBe('last write wins');

    // Serialization holds across store instances (e.g. two extension pages) too.
    const second = createOpfsAudioStore(async () => root);
    const crossed = [store.writeChunk(OTHER, 1, big), second.writeChunk(OTHER, 1, new Blob(['second store']))];
    await Promise.all(crossed);
    expect((await store.stat(OTHER)).bytes).toBe('last write wins'.length + 'second store'.length);
  });

  it('keeps accepting writes after one fails, and a failed write leaves no chunk or swap file', async () => {
    // A File snapshot whose file changed after getFile() cannot be read: a real write failure.
    const source = await dirAt(root, 'source');
    await writeFile(source, 'input.bin', 'original');
    const stale = await (await source.getFileHandle('input.bin')).getFile();
    await writeFile(source, 'input.bin', 'modified afterwards');

    await store.writeChunk(ID, 0, new Blob(['ok']));
    await expect(store.writeChunk(ID, 1, stale)).rejects.toThrow();
    await store.writeChunk(ID, 2, new Blob(['!']));

    expect(await readText(store, ID)).toBe('ok!');
    expect(await store.stat(ID)).toEqual({ chunkCount: 2, bytes: 3 });
    const leftovers = await names(await dirAt(root, 'sessions', ID, 'audio'));
    expect(leftovers.filter((n) => n.endsWith('.crswap'))).toEqual([]);
  });

  it('keeps accepting writes after the root could not be opened', async () => {
    let calls = 0;
    const flaky = createOpfsAudioStore(async () => {
      if (calls++ === 0) throw new DOMException('storage unavailable', 'InvalidStateError');
      return root;
    });
    await expect(flaky.writeChunk(ID, 0, new Blob(['lost']))).rejects.toThrow('storage unavailable');
    await flaky.writeChunk(ID, 1, new Blob(['kept']));
    expect(await readText(flaky, ID)).toBe('kept');
  });

  it('rejects session ids that are not safe directory names', async () => {
    const bad = ['', '.', '..', '../escape', 'a/b', 'a\\b', 'has space', '-leading', 'x'.repeat(129), 'é'];
    for (const id of bad) {
      await expect(store.writeChunk(id, 0, new Blob(['x'])), id).rejects.toThrow(TypeError);
      await expect(store.readAudio(id), id).rejects.toThrow(TypeError);
      await expect(store.stat(id), id).rejects.toThrow(TypeError);
      await expect(store.delete(id), id).rejects.toThrow(TypeError);
    }
    expect(await names(root)).toEqual([]);
    for (const id of ['s1', 'A_b-9', ID, 'x'.repeat(128)]) {
      await store.writeChunk(id, 0, new Blob(['x']));
      expect(await store.stat(id)).toEqual({ chunkCount: 1, bytes: 1 });
    }
  });

  it('rejects chunk indices that are not non-negative integers', async () => {
    for (const index of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      await expect(store.writeChunk(ID, index, new Blob(['x'])), String(index)).rejects.toThrow(RangeError);
    }
    expect(await names(root)).toEqual([]);
  });

  it('writes a real MediaRecorder recording chunk by chunk and reads it back as decodable WebM', async () => {
    const ctx = new AudioContext();
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();

    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const recorded: Blob[] = [];
    const writes: Promise<void>[] = [];
    rec.ondataavailable = (e) => {
      // Like the offscreen recorder: fire-and-forget from the event, the store keeps order.
      writes.push(store.writeChunk(ID, recorded.length, e.data));
      recorded.push(e.data);
    };
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(200);
    await sleep(2_600);
    rec.stop();
    await stopped;
    osc.stop();
    await Promise.all(writes);
    expect(recorded.length).toBeGreaterThan(10);

    const audio = await store.readAudio(ID);
    expect(audio).not.toBeNull();
    const bytes = await bytesOf(audio as Blob);
    expect(bytes).toEqual(await bytesOf(new Blob(recorded)));
    expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic

    const decoded = await ctx.decodeAudioData(await (audio as Blob).arrayBuffer());
    expect(decoded.duration).toBeGreaterThan(2);
    expect(decoded.duration).toBeLessThan(4);
    const samples = decoded.getChannelData(0);
    let sumSq = 0;
    for (const s of samples) sumSq += s * s;
    expect(Math.sqrt(sumSq / samples.length)).toBeGreaterThan(0.3); // the tone, not silence

    // The first second alone (what survives a crash right after it) is valid audio too.
    const firstSecond = recorded.slice(0, 5);
    for (const [i, chunk] of firstSecond.entries()) await store.writeChunk(OTHER, i, chunk);
    const prefix = await store.readAudio(OTHER);
    const prefixDecoded = await ctx.decodeAudioData(await (prefix as Blob).arrayBuffer());
    expect(prefixDecoded.duration).toBeGreaterThan(0.5);
    expect(prefixDecoded.duration).toBeLessThan(1.6);
    await ctx.close();
  });
});

describe('OPFS audio store defaults (real Chrome OPFS)', () => {
  it('uses the origin’s OPFS root when no root is given', async () => {
    const id = `default-root-test-${crypto.randomUUID()}`;
    const store = createOpfsAudioStore();
    const opfs = await navigator.storage.getDirectory();
    try {
      await store.writeChunk(id, 0, new Blob(['hello']));
      const chunk = await (await dirAt(opfs, 'sessions', id, 'audio')).getFileHandle('000000.webm');
      expect(await (await chunk.getFile()).text()).toBe('hello');
      expect(await store.list()).toContainEqual({ sessionId: id, chunkCount: 1, bytes: 5 });
    } finally {
      await store.delete(id);
    }
    const sessions = await opfs.getDirectoryHandle('sessions');
    expect(await names(sessions)).not.toContain(id);
    // Only succeeds if no other test left sessions behind; OPFS is shared by the origin.
    await opfs.removeEntry('sessions').catch(() => undefined);
  });

  it('reports storage usage and quota', async () => {
    const { usage, quota } = await storageUsage();
    expect(Number.isFinite(usage)).toBe(true);
    expect(usage).toBeGreaterThanOrEqual(0);
    expect(quota).toBeGreaterThan(0);
  });
});
