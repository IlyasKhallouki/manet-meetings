import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadCaptions } from '@lib/storage/captionStore';
import { getResult } from '@lib/storage/resultStore';
import { getActiveRecording, getSession, listSessions, watchSessions } from '@lib/storage/sessionStore';
import type { SessionStatus } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { configure, DAY, MEET_CODE, seg, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const ROUTE_DELAY = 2 * 60 * 1000;

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  await configure();
  m = h.createManager();
  await m.boot();
});

/** Starts recording a fresh Meet tab and returns its id. */
async function record(): Promise<number> {
  const tabId = await h.openMeetTab();
  expect(await m.start(tabId)).toEqual({ ok: true, sessionId: ID });
  return tabId;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('recording lifecycle', () => {
  it('records, routes, transcribes and saves a meeting', async () => {
    const statuses: SessionStatus[] = [];
    const unwatch = watchSessions((id, meta) => {
      if (id === ID && meta && statuses.at(-1) !== meta.status) statuses.push(meta.status);
    });

    const tabId = await record();
    const startedAt = T0 + 150; // the recorder's t = 0

    expect(h.createDocument).toHaveBeenCalledTimes(1);
    expect(h.createDocument.mock.calls[0]?.[0]).toMatchObject({ url: '/offscreen.html', reasons: ['USER_MEDIA', 'BLOBS'] });
    expect(h.offscreen.callsOf('offscreen/recorder-start')).toEqual([
      { sessionId: ID, streamId: `stream-${tabId}-1`, timesliceMs: 5000, includeMic: true },
    ]);
    const meta = await getSession(ID);
    expect(meta).toMatchObject({
      id: ID,
      meetCode: MEET_CODE,
      status: 'recording',
      startedAt,
      idempotencyKey: idempotencyKey(MEET_CODE, startedAt),
      audio: { mimeType: 'audio/webm;codecs=opus', micIncluded: true, chunkCount: 0, bytes: 0 },
      captionCount: 0,
    });
    expect(meta?.audio.error).toBeUndefined();
    expect(await getActiveRecording()).toEqual({ sessionId: ID, tabId, meetCode: MEET_CODE });
    expect(await h.badge()).toBe('REC');
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt } }]);

    // The content script re-attaches after a reload; other tabs are not recorded.
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE, title: 'Weekly sync' })).toEqual({ sessionId: ID, startedAt });
    expect((await getSession(ID))?.meetingTitle).toBe('Weekly sync');
    const other = await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    expect(await m.onMeetJoined(other, { meetCode: 'xyz-abcd-efg' })).toBeNull();

    h.clock.advance(5000);
    await m.onRecorderChunk({ sessionId: ID, index: 0, bytes: 4000 });
    h.clock.advance(5000);
    await m.onRecorderChunk({ sessionId: ID, index: 1, bytes: 8200 });
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 1000, 'Bonjour'), seg('c2', 'Bob', 4000, 'Hi all')] });
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 1000, 'Bonjour à tous', 1)] });
    expect(await getSession(ID)).toMatchObject({
      audio: { chunkCount: 2, bytes: 8200 },
      captionCount: 2,
      lastHeartbeat: h.clock.now(),
    });

    h.offscreen.audio.set(ID, { sessionId: ID, chunkCount: 3, bytes: 12_000 });
    const endedAt = h.clock.advance(20_000);
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });

    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toEqual([{ sessionId: ID }]);
    expect(await getSession(ID)).toMatchObject({
      status: 'awaiting-route',
      endedAt,
      durationMs: endedAt - startedAt,
      audio: { chunkCount: 3, bytes: 12_000 },
    });
    expect(await getActiveRecording()).toBeNull();
    expect(await h.badge()).toBe('');
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(h.windowsCreate.mock.calls[0]?.[0]).toMatchObject({
      type: 'popup',
      url: `chrome-extension://test-extension-id/routing.html?session=${encodeURIComponent(ID)}`,
    });
    expect((await fakeBrowser.alarms.get(`route:${ID}`))?.scheduledTime).toBe(endedAt + ROUTE_DELAY);

    await m.route(ID, 'personal');
    await m.idle();

    expect(await fakeBrowser.alarms.get(`route:${ID}`)).toBeUndefined();
    const [job] = h.offscreen.callsOf('offscreen/process');
    expect(job?.route).toBe('personal');
    expect(job?.meta).toMatchObject({ id: ID, status: 'processing', route: 'personal' });
    expect(job?.captions).toEqual(await loadCaptions(ID));
    expect(job?.captions.map((c) => c.text)).toEqual(['Bonjour à tous', 'Hi all']);
    expect(job?.settings.notionPersonalDbId).toBe('personal-db');

    const result = await getResult(ID);
    expect(result?.title).toBe('Weekly sync');
    const [saveJob] = h.offscreen.callsOf('offscreen/save');
    expect(saveJob).toMatchObject({ route: 'personal', result, meta: { id: ID, status: 'saving' } });

    const saved = await getSession(ID);
    const savedAt = h.clock.now();
    expect(saved).toMatchObject({
      status: 'saved',
      route: 'personal',
      notion: { pageId: 'page-1', url: 'https://www.notion.so/page-1', recordedBy: 'Ilyas' },
      savedAt,
      purgeAudioAt: savedAt + 7 * DAY,
    });
    expect(saved?.stage).toBeUndefined();
    expect(saved?.error).toBeUndefined();
    expect(statuses).toEqual(['recording', 'awaiting-route', 'ready', 'processing', 'processed', 'saving', 'saved']);
    expect(h.keepAlive).toEqual({ held: 0, taken: 1 });
    unwatch();
  });

  it('applies the default route when the prompt is ignored, and waits for Transcribe when auto is off', async () => {
    await configure({ autoTranscribe: false, defaultRoute: 'team' });
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });

    await m.onAlarm(`route:${ID}`);
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'team' });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);

    // Re-routing a ready session changes the destination only.
    await m.route(ID, 'personal');
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'personal' });

    await m.transcribe(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')[0]?.route).toBe('personal');
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('keeps an explicit route when the default-route alarm fires late', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.route(ID, 'personal');
    await m.onAlarm(`route:${ID}`);
    await m.idle();
    expect((await getSession(ID))?.route).toBe('personal');
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
  });

  it('refuses to route a session that is still recording', async () => {
    await record();
    await expect(m.route(ID, 'team')).rejects.toThrow(/recording/);
  });
});

describe('duplicates and failures', () => {
  async function recordAndRoute() {
    const tabId = await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.route(ID, 'team');
    await m.idle();
  }

  it('stops at the duplicate check when a teammate already saved the meeting', async () => {
    h.offscreen.process = () => ({
      status: 'duplicate',
      existing: { pageId: 'p9', url: 'https://www.notion.so/p9', recordedBy: 'Alice' },
    });
    await recordAndRoute();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({
      status: 'duplicate',
      notion: { pageId: 'p9', url: 'https://www.notion.so/p9', recordedBy: 'Alice' },
    });
    expect(meta?.purgeAudioAt).toBe(h.clock.now() + 7 * DAY);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
    expect(await getResult(ID)).toBeNull();
    expect(h.notifications()).toContainEqual(
      expect.objectContaining({ id: `manet:${ID}`, message: 'Already in Notion — recorded by Alice' }),
    );
  });

  it('marks a duplicate found at save time and keeps the local result', async () => {
    h.offscreen.save = () => ({
      status: 'duplicate',
      existing: { pageId: 'p7', url: 'https://www.notion.so/p7', recordedBy: 'Bob' },
    });
    await recordAndRoute();
    expect(await getSession(ID)).toMatchObject({ status: 'duplicate', notion: { pageId: 'p7', recordedBy: 'Bob' } });
    expect(await getResult(ID)).not.toBeNull();
    expect(h.notifications().map((n) => n.message)).toContain('Already in Notion — recorded by Bob');
  });

  it('keeps the result when saving fails, then saves on retry', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion returned 502' });
    await recordAndRoute();
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Notion returned 502' });
    expect(await getResult(ID)).not.toBeNull();
    expect(h.notifications().map((n) => n.message)).toContain('Notion returned 502');

    h.offscreen.save = () => ({ status: 'created', pageId: 'page-2', url: 'https://www.notion.so/page-2' });
    await m.save(ID);
    await m.idle();
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'saved', notion: { pageId: 'page-2' } });
    expect(meta?.error).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
  });

  it('marks the session failed when the pipeline reports an error', async () => {
    h.offscreen.process = () => ({ status: 'error', error: 'Gemini quota exceeded' });
    await recordAndRoute();
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Gemini quota exceeded' });
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
    await expect(m.save(ID)).rejects.toThrow(/transcribe/i);
  });

  it('marks the session failed when the offscreen document throws mid-job', async () => {
    h.offscreen.process = () => {
      throw new Error('Offscreen crashed');
    };
    await recordAndRoute();
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: expect.stringContaining('Offscreen crashed') });
    expect((await getSession(ID))?.stage).toBeUndefined();
  });

  it('records without keys, then fails transcription with a clear error', async () => {
    await configure({ geminiApiKey: '', notionToken: '', displayName: '' });
    await recordAndRoute();
    const meta = await getSession(ID);
    expect(meta?.status).toBe('failed');
    expect(meta?.error).toMatch(/Gemini API key/);
    expect(meta?.error).toMatch(/Notion integration token/);
    expect(meta?.error).toMatch(/Your name/);
    expect(meta?.audio.error).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    expect(h.notifications().some((n) => n.message.includes('Gemini API key'))).toBe(true);
  });

  it('runs one job per session', async () => {
    await configure({ autoTranscribe: false });
    const gate = deferred<void>();
    const inner = h.offscreen.process;
    h.offscreen.process = async (job) => {
      await gate.promise;
      return inner(job);
    };
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.route(ID, 'team');

    await Promise.all([m.transcribe(ID), m.transcribe(ID)]);
    await m.transcribe(ID);
    await m.save(ID);
    expect((await getSession(ID))?.status).toBe('processing');
    expect(h.keepAlive.held).toBe(1);

    await m.onJobProgress({ sessionId: ID, stage: 'transcribing-timing' });
    expect((await getSession(ID))?.stage).toBe('transcribing-timing');

    gate.resolve();
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(1);
    expect(h.keepAlive.held).toBe(0);
    expect((await getSession(ID))?.stage).toBeUndefined();
  });
});

describe('capture failures keep a captions-only session', () => {
  it('when tab capture is refused', async () => {
    h.getMediaStreamId.mockRejectedValueOnce(new Error('Extension has not been invoked for the current page'));
    const tabId = await record();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'recording', startedAt: T0, audio: { chunkCount: 0 } });
    expect(meta?.audio.error).toMatch(/not been invoked/);
    expect(h.offscreen.callsOf('offscreen/recorder-start')).toHaveLength(0);
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt: T0 } }]);
    expect(await h.badge()).toBe('REC');

    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 500, 'On commence')] });
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect((await getSession(ID))?.captionCount).toBe(1);
  });

  it('when the recorder cannot start', async () => {
    h.offscreen.recorderStart = () => ({ ok: false, error: 'NotAllowedError: Permission denied' });
    await record();
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'recording', startedAt: T0 });
    expect(meta?.audio.error).toMatch(/Permission denied/);
  });

  it('when the offscreen document cannot be created', async () => {
    // Boot opened the document; it has gone away and cannot be reopened.
    h.offscreen.close();
    h.createDocument.mockRejectedValueOnce(new Error('offscreen blocked'));
    await record();
    expect((await getSession(ID))?.audio.error).toMatch(/offscreen blocked/);
  });
});

describe('ending a recording', () => {
  it('finalizes once when the tab closes, the page reports leaving and the track ends together', async () => {
    const tabId = await record();
    await Promise.all([
      m.onTabRemoved(tabId),
      m.onMeetLeft(tabId, { meetCode: MEET_CODE }),
      m.onRecorderStopped({ sessionId: ID, reason: 'track-ended', chunkCount: 4, bytes: 16_000 }),
      m.stop(ID),
    ]);
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();

    expect(h.offscreen.callsOf('offscreen/recorder-stop').length).toBeLessThanOrEqual(1);
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(await h.alarmNames()).toContain(`route:${ID}`);
    const meta = await getSession(ID);
    expect(meta?.status).toBe('awaiting-route');
    expect(meta?.audio.error).toBeUndefined();
  });

  it('ignores a requested-stop report arriving after finalize, apart from the final counts', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.onRecorderStopped({ sessionId: ID, reason: 'requested', chunkCount: 9, bytes: 36_000 });
    expect(await getSession(ID)).toMatchObject({ status: 'awaiting-route', audio: { chunkCount: 9, bytes: 36_000 } });
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('ends when the recorder dies on its own', async () => {
    await record();
    await m.onRecorderStopped({ sessionId: ID, reason: 'error', error: 'MediaRecorder error', chunkCount: 2, bytes: 8000 });
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'awaiting-route', audio: { chunkCount: 2, bytes: 8000 } });
    expect(meta?.audio.error).toMatch(/MediaRecorder error/);
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
  });

  it('ends when the recording tab leaves the call URL, not on same-call URL changes', async () => {
    const tabId = await record();
    await m.onTabUrlChanged(tabId, `https://meet.google.com/${MEET_CODE}?authuser=1`);
    expect((await getSession(ID))?.status).toBe('recording');
    const other = await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    await m.onTabUrlChanged(other, 'https://example.com/');
    expect((await getSession(ID))?.status).toBe('recording');

    await m.onTabUrlChanged(tabId, 'https://meet.google.com/landing');
    expect((await getSession(ID))?.status).toBe('awaiting-route');
  });

  it('ignores a leave report from another tab', async () => {
    await record();
    const other = await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    await m.onMeetLeft(other, { meetCode: 'xyz-abcd-efg' });
    await m.onTabRemoved(other);
    expect((await getSession(ID))?.status).toBe('recording');
  });
});

describe('starting', () => {
  it('records one meeting at a time and treats a second click on the same tab as a no-op', async () => {
    const tabId = await record();
    expect(await m.start(tabId)).toEqual({ ok: true, sessionId: ID });
    const other = await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    const res = await m.start(other);
    expect(res.ok).toBe(false);
    expect(await listSessions()).toHaveLength(1);
    expect(h.offscreen.callsOf('offscreen/recorder-start')).toHaveLength(1);
  });

  it('starts once when clicked twice concurrently', async () => {
    const tabId = await h.openMeetTab();
    const [a, b] = await Promise.all([m.start(tabId), m.start(tabId)]);
    expect(a).toEqual({ ok: true, sessionId: ID });
    expect(b).toEqual(a);
    expect(h.offscreen.callsOf('offscreen/recorder-start')).toHaveLength(1);
  });

  it('rejects tabs that are not a Meet call', async () => {
    const tab = await fakeBrowser.tabs.create({ url: 'https://meet.google.com/landing' });
    expect(await m.start(tab.id!)).toEqual({ ok: false, error: expect.stringMatching(/Meet/) });
    expect(await m.start(9999)).toMatchObject({ ok: false });
    expect(await listSessions()).toEqual([]);
  });

  it('uses the title the page reported before recording started', async () => {
    const tabId = await h.openMeetTab();
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE, title: 'Point produit' })).toBeNull();
    await m.start(tabId);
    expect((await getSession(ID))?.meetingTitle).toBe('Point produit');
  });

  it('toggles recording from the keyboard command', async () => {
    const tabId = await h.openMeetTab();
    await m.toggle(tabId);
    expect((await getSession(ID))?.status).toBe('recording');
    await m.toggle();
    expect((await getSession(ID))?.status).toBe('awaiting-route');
  });

  it('never reuses the id of an earlier session started in the same second', async () => {
    const tabId = await record();
    await m.stop(ID);
    const res = await m.start(tabId);
    expect(res.ok).toBe(true);
    const second = res.ok ? res.sessionId : '';
    expect(second).not.toBe(ID);
    expect(second).toBe(sessionId(MEET_CODE, T0 + 1000));
    expect((await getSession(ID))?.status).toBe('awaiting-route');
    expect((await getSession(second))?.status).toBe('recording');
  });

  it('honours includeMic = false', async () => {
    await configure({ includeMic: false });
    await record();
    expect(h.offscreen.callsOf('offscreen/recorder-start')[0]?.includeMic).toBe(false);
    expect((await getSession(ID))?.audio.micIncluded).toBe(false);
  });
});

describe('deleting', () => {
  it('removes a saved session with its audio, captions and result', async () => {
    const tabId = await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.route(ID, 'team');
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');

    await m.remove(ID);
    expect(h.offscreen.callsOf('offscreen/audio-delete')).toEqual([{ sessionId: ID }]);
    expect(await getSession(ID)).toBeNull();
    expect(await loadCaptions(ID)).toEqual([]);
    expect(await getResult(ID)).toBeNull();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({ settings: expect.anything() });
  });

  it('stops a recording before deleting it, without asking for a route', async () => {
    const tabId = await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await m.remove(ID);

    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toEqual([{ sessionId: ID }]);
    expect(await getActiveRecording()).toBeNull();
    expect(await h.badge()).toBe('');
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
    expect(h.windowsCreate).not.toHaveBeenCalled();
    expect(await getSession(ID)).toBeNull();

    // Late messages for the deleted session do not bring it back.
    await m.onCaptions({ sessionId: ID, segments: [seg('c2', 'Bob', 10, 'Late')] });
    await m.onRecorderStopped({ sessionId: ID, reason: 'requested', chunkCount: 1, bytes: 10 });
    await m.onTabRemoved(tabId);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({ settings: expect.anything() });
  });

  it('drops caption batches that arrive while the session is being deleted', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    const local = fakeBrowser.storage.local;
    const remove = local.remove.bind(local);
    let late: Promise<void> | undefined;
    vi.spyOn(local, 'remove').mockImplementation((async (keys: string | string[]) => {
      await remove(keys);
      // The content script's last flush lands right after the captions were removed.
      if (keys === `captions:${ID}`) late = m.onCaptions({ sessionId: ID, segments: [seg('c9', 'Bob', 0, 'Late')] });
    }) as never);
    await m.remove(ID);
    await late;
    expect(await local.get(null)).toEqual({ settings: expect.anything() });
  });

  it('keeps the session when its audio cannot be deleted', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    h.offscreen.audioDeleteError = 'OPFS unavailable';
    await expect(m.remove(ID)).rejects.toThrow('OPFS unavailable');
    expect(await getSession(ID)).not.toBeNull();
  });
});
