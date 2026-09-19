import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  clearActiveRecording,
  deleteSession,
  getActiveRecording,
  getSession,
  listSessions,
  putSession,
  setActiveRecording,
  updateSession,
  watchSessions,
} from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';

function meta(id: string, startedAt: number, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt,
    status: 'recording',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

// storage.local.getKeys (Chrome 130+) is not implemented by fakeBrowser.
function stubGetKeys() {
  return vi
    .spyOn(fakeBrowser.storage.local, 'getKeys')
    .mockImplementation((async () => Object.keys(await fakeBrowser.storage.local.get(null))) as never);
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('sessionStore', () => {
  it('stores each session under session:<id> in storage.local', async () => {
    const m = meta('abc-defg-hij_20260919T100000Z', 1000);
    await putSession(m);
    expect(await fakeBrowser.storage.local.get('session:abc-defg-hij_20260919T100000Z')).toEqual({
      'session:abc-defg-hij_20260919T100000Z': m,
    });
    expect(await getSession(m.id)).toEqual(m);
  });

  it('returns null for an unknown session', async () => {
    expect(await getSession('nope')).toBeNull();
  });

  it('lists sessions newest first and ignores other keys', async () => {
    const getKeys = stubGetKeys();
    await putSession(meta('a', 1000));
    await putSession(meta('c', 3000));
    await putSession(meta('b', 2000));
    await fakeBrowser.storage.local.set({ 'captions:a': { x: 1 }, 'result:a': { y: 2 }, settings: {} });

    const list = await listSessions();
    expect(list.map((m) => m.id)).toEqual(['c', 'b', 'a']);
    expect(getKeys).toHaveBeenCalled();
  });

  it('falls back to reading everything when storage.local.getKeys is unavailable', async () => {
    // fakeBrowser's getKeys throws "not implemented", like a missing API would.
    await putSession(meta('a', 1000));
    await putSession(meta('b', 2000));
    await fakeBrowser.storage.local.set({ 'captions:a': { x: 1 } });
    expect((await listSessions()).map((m) => m.id)).toEqual(['b', 'a']);
  });

  it('applies a patch or an updater function and returns the new value', async () => {
    await putSession(meta('a', 1000));
    const patched = await updateSession('a', { status: 'awaiting-route', endedAt: 5000 });
    expect(patched).toMatchObject({ status: 'awaiting-route', endedAt: 5000, startedAt: 1000 });

    const updated = await updateSession('a', (m) => ({ ...m, captionCount: m.captionCount + 3 }));
    expect(updated?.captionCount).toBe(3);
    expect(await getSession('a')).toEqual(updated);
  });

  it('removes optional fields patched to undefined', async () => {
    await putSession(meta('a', 1000, { stage: 'aligning', error: 'x' }));
    const m = await updateSession('a', { stage: undefined, error: undefined });
    expect(m).not.toHaveProperty('stage');
    expect(await getSession('a')).not.toHaveProperty('error');
  });

  it('skips the write when an updater returns the session unchanged', async () => {
    await putSession(meta('a', 1000));
    const writes: string[] = [];
    const stop = watchSessions((id) => writes.push(id));
    const same = await updateSession('a', (m) => m);
    stop();
    expect(same).toEqual(meta('a', 1000));
    expect(writes).toEqual([]);
  });

  it('does not create a session when updating an unknown id', async () => {
    expect(await updateSession('ghost', { status: 'ready' })).toBeNull();
    expect(await getSession('ghost')).toBeNull();
  });

  it('serializes concurrent updates to the same session', async () => {
    await putSession(meta('a', 1000));
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? updateSession('a', (m) => ({ ...m, captionCount: m.captionCount + 1 }))
          : updateSession('a', (m) => ({ ...m, audio: { ...m.audio, chunkCount: m.audio.chunkCount + 1 } })),
      ),
    );
    const m = await getSession('a');
    expect(m?.captionCount).toBe(20);
    expect(m?.audio.chunkCount).toBe(20);
  });

  it('keeps the queue alive after an updater throws', async () => {
    await putSession(meta('a', 1000));
    await expect(
      updateSession('a', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await updateSession('a', { captionCount: 7 }))?.captionCount).toBe(7);
  });

  it('deletes a session, and updates queued behind the delete do not resurrect it', async () => {
    await putSession(meta('a', 1000));
    const del = deleteSession('a');
    const upd = updateSession('a', { captionCount: 9 });
    await del;
    expect(await upd).toBeNull();
    expect(await getSession('a')).toBeNull();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('notifies watchers of puts and deletes until unsubscribed', async () => {
    const seen: [string, string | null][] = [];
    const stop = watchSessions((id, m) => seen.push([id, m?.status ?? null]));
    await putSession(meta('a', 1000));
    await updateSession('a', { status: 'ready' });
    await fakeBrowser.storage.local.set({ 'captions:a': { x: 1 } });
    await deleteSession('a');
    stop();
    await putSession(meta('b', 2000));
    expect(seen).toEqual([
      ['a', 'recording'],
      ['a', 'ready'],
      ['a', null],
    ]);
  });
});

describe('active recording pointer', () => {
  it('lives in storage.session and can be cleared', async () => {
    expect(await getActiveRecording()).toBeNull();
    const pointer = { sessionId: 'a', tabId: 12, meetCode: 'abc-defg-hij' };
    await setActiveRecording(pointer);
    expect(await getActiveRecording()).toEqual(pointer);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
    expect(Object.values(await fakeBrowser.storage.session.get(null))).toEqual([pointer]);

    await clearActiveRecording();
    expect(await getActiveRecording()).toBeNull();
  });
});
