/**
 * AudioStore on the local filesystem, for Node tests: Node has no OPFS. It is a second
 * real implementation of the interface, not a stand-in, and follows the OPFS store's
 * rules: layout <root>/sessions/<id>/audio/<index padded to 6>.webm, a chunk counts
 * only once committed and non-empty, writes to one session commit in call order, and
 * delete leaves files other modules keep in the session directory.
 */
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioSessionInfo, AudioStore } from '@lib/types';

const CHUNK_NAME = /^(\d{6,})\.webm$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface Chunk {
  index: number;
  path: string;
  bytes: number;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new TypeError(`Invalid session id: ${JSON.stringify(sessionId)}`);
}

function assertIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`Invalid chunk index: ${index}`);
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function missingAsEmpty(err: unknown): never[] {
  if (errorCode(err) === 'ENOENT') return [];
  throw err;
}

export function createFileAudioStore(root: string): AudioStore {
  const sessionsDir = join(root, 'sessions');
  const sessionDir = (id: string) => join(sessionsDir, id);
  const audioDir = (id: string) => join(sessionDir(id), 'audio');
  const queues = new Map<string, Promise<void>>();

  function serialized<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const result = (queues.get(sessionId) ?? Promise.resolve()).then(task);
    queues.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async function chunks(sessionId: string): Promise<Chunk[]> {
    const names = await readdir(audioDir(sessionId)).catch(missingAsEmpty);
    const out: Chunk[] = [];
    for (const name of names) {
      const match = CHUNK_NAME.exec(name);
      if (!match) continue;
      const path = join(audioDir(sessionId), name);
      const info = await stat(path);
      if (info.isFile() && info.size > 0) out.push({ index: Number(match[1]), path, bytes: info.size });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  const totals = (list: Chunk[]) => ({ chunkCount: list.length, bytes: list.reduce((sum, c) => sum + c.bytes, 0) });

  return {
    async writeChunk(sessionId, index, data) {
      assertSessionId(sessionId);
      assertIndex(index);
      const bytes = new Uint8Array(await data.arrayBuffer());
      await serialized(sessionId, async () => {
        await mkdir(audioDir(sessionId), { recursive: true });
        const target = join(audioDir(sessionId), `${String(index).padStart(6, '0')}.webm`);
        // Write then rename, so a reader never sees a half-written chunk.
        const temp = `${target}.tmp`;
        await writeFile(temp, bytes);
        await rename(temp, target);
      });
    },

    async readAudio(sessionId) {
      assertSessionId(sessionId);
      const list = await chunks(sessionId);
      if (list.length === 0) return null;
      const parts = await Promise.all(list.map(async (c) => new Uint8Array(await readFile(c.path))));
      return new Blob(parts, { type: 'audio/webm' });
    },

    async stat(sessionId) {
      assertSessionId(sessionId);
      return totals(await chunks(sessionId));
    },

    async list() {
      const entries = await readdir(sessionsDir, { withFileTypes: true }).catch(missingAsEmpty);
      const out: AudioSessionInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
        const info = totals(await chunks(entry.name));
        if (info.chunkCount > 0) out.push({ sessionId: entry.name, ...info });
      }
      return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
    },

    async delete(sessionId) {
      assertSessionId(sessionId);
      await serialized(sessionId, async () => {
        await rm(audioDir(sessionId), { recursive: true, force: true });
        try {
          await rmdir(sessionDir(sessionId));
        } catch (err) {
          if (errorCode(err) !== 'ENOENT' && errorCode(err) !== 'ENOTEMPTY') throw err;
        }
      });
    },
  };
}
