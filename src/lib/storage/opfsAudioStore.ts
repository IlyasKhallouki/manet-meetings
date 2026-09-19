import type { AudioSessionInfo, AudioStore } from '../types';

const SESSIONS_DIR = 'sessions';
const AUDIO_DIR = 'audio';
const AUDIO_MIME_TYPE = 'audio/webm';
/** `000042.webm`. Anything else (e.g. Chrome's `<name>.crswap` swap files) is not a chunk. */
const CHUNK_NAME = /^(\d{6,})\.webm$/;
/** Session ids become directory names: `abc-defg-hij_20260919T101500Z`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Web Lock name prefix; locks are shared by every context of the extension origin. */
const LOCK_PREFIX = 'manet-meetings:audio:';

// The repo's TS lib set has no DOM.AsyncIterable, so directory iteration is typed locally.
type IterableDir = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

interface Chunk {
  index: number;
  file: File;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new TypeError(`Invalid session id: ${JSON.stringify(sessionId)}`);
}

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`Invalid chunk index: ${index}`);
}

function chunkName(index: number): string {
  return `${String(index).padStart(6, '0')}.webm`;
}

function isMissing(e: unknown): boolean {
  return e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');
}

async function openDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

async function removeEntry(parent: FileSystemDirectoryHandle, name: string, recursive: boolean): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive });
  } catch (e) {
    if (isMissing(e)) return;
    // Non-recursive removal of a directory that still has content.
    if (e instanceof DOMException && e.name === 'InvalidModificationError') return;
    throw e;
  }
}

/**
 * Committed chunks, sorted by index. A zero-byte chunk file is a write that never
 * committed: getFileHandle({ create: true }) makes the file empty and the data only
 * lands in it on close(), so it is either in flight or was lost to a crash.
 */
async function readChunks(audioDir: FileSystemDirectoryHandle): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  try {
    for await (const [name, handle] of (audioDir as IterableDir).entries()) {
      const match = CHUNK_NAME.exec(name);
      if (!match?.[1] || handle.kind !== 'file') continue;
      let file: File;
      try {
        file = await (handle as FileSystemFileHandle).getFile();
      } catch (e) {
        if (isMissing(e)) continue;
        throw e;
      }
      if (file.size > 0) chunks.push({ index: Number(match[1]), file });
    }
  } catch (e) {
    // The directory was deleted while we listed it.
    if (isMissing(e)) return [];
    throw e;
  }
  return chunks.sort((a, b) => a.index - b.index);
}

/**
 * Runs `task` holding the session's exclusive Web Lock. Requests are granted in call
 * order, so overlapping writes commit in the order they were made, including writes
 * from another page or the offscreen document.
 */
async function withSessionLock(sessionId: string, task: () => Promise<void>): Promise<void> {
  await navigator.locks.request(LOCK_PREFIX + sessionId, task);
}

function summarize(chunks: Chunk[]): { chunkCount: number; bytes: number } {
  return { chunkCount: chunks.length, bytes: chunks.reduce((n, c) => n + c.file.size, 0) };
}

/**
 * Audio chunks in the Origin Private File System under
 * `sessions/<sessionId>/audio/<index padded to 6>.webm`, one file per MediaRecorder
 * timeslice. `getRoot` defaults to the origin's OPFS root; tests pass a subdirectory.
 */
export function createOpfsAudioStore(
  getRoot: () => Promise<FileSystemDirectoryHandle> = () => navigator.storage.getDirectory(),
): AudioStore {
  async function sessionsDir(): Promise<FileSystemDirectoryHandle | null> {
    return openDir(await getRoot(), SESSIONS_DIR);
  }

  async function audioDir(sessionId: string): Promise<FileSystemDirectoryHandle | null> {
    const sessions = await sessionsDir();
    const session = sessions && (await openDir(sessions, sessionId));
    return session && openDir(session, AUDIO_DIR);
  }

  async function sessionChunks(sessionId: string): Promise<Chunk[]> {
    const dir = await audioDir(sessionId);
    return dir ? readChunks(dir) : [];
  }

  return {
    async writeChunk(sessionId, index, data) {
      assertSessionId(sessionId);
      assertIndex(index);
      await withSessionLock(sessionId, async () => {
        let dir = await getRoot();
        for (const name of [SESSIONS_DIR, sessionId, AUDIO_DIR]) {
          dir = await dir.getDirectoryHandle(name, { create: true });
        }
        const handle = await dir.getFileHandle(chunkName(index), { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        // close() is the atomic commit: until then the data only exists in the swap file,
        // which Chrome discards if the write fails.
        await writable.close();
      });
    },

    async readAudio(sessionId) {
      assertSessionId(sessionId);
      const chunks = await sessionChunks(sessionId);
      if (chunks.length === 0) return null;
      // File-backed: nothing is read into memory until the blob is consumed.
      return new Blob(chunks.map((c) => c.file), { type: AUDIO_MIME_TYPE });
    },

    async stat(sessionId) {
      assertSessionId(sessionId);
      return summarize(await sessionChunks(sessionId));
    },

    async list() {
      const sessions = await sessionsDir();
      if (!sessions) return [];
      const found: AudioSessionInfo[] = [];
      for await (const [name, handle] of (sessions as IterableDir).entries()) {
        if (handle.kind !== 'directory' || !SESSION_ID.test(name)) continue;
        const dir = await openDir(handle as FileSystemDirectoryHandle, AUDIO_DIR);
        const info = summarize(dir ? await readChunks(dir) : []);
        if (info.chunkCount > 0) found.push({ sessionId: name, ...info });
      }
      return found.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    },

    async delete(sessionId) {
      assertSessionId(sessionId);
      await withSessionLock(sessionId, async () => {
        const sessions = await sessionsDir();
        const session = sessions && (await openDir(sessions, sessionId));
        if (!sessions || !session) return;
        await removeEntry(session, AUDIO_DIR, true);
        // The session directory goes too, unless something else lives in it.
        await removeEntry(sessions, sessionId, false);
      });
    },
  };
}

/** Origin-wide storage estimate (OPFS, IndexedDB, caches...), in bytes. */
export async function storageUsage(): Promise<{ usage: number; quota: number }> {
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
