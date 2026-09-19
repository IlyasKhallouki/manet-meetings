import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { putResult } from '@lib/storage/resultStore';
import { getActiveRecording, getSession, listSessions, putSession, setActiveRecording } from '@lib/storage/sessionStore';
import type { SessionMeta, SessionResult } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import { configure, DAY, MEET_CODE, MEET_URL, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const STARTED = T0 + 150;
const HOUR = 60 * 60 * 1000;

let h: Harness;

beforeEach(async () => {
  h = setupHarness();
  await configure();
});

function stored(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: ID,
    meetCode: MEET_CODE,
    startedAt: STARTED,
    status: 'recording',
    idempotencyKey: idempotencyKey(MEET_CODE, STARTED),
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 12, bytes: 48_000, micIncluded: true },
    captionCount: 3,
    ...patch,
  };
}

const RESULT: SessionResult = {
  title: 'Sync',
  attendees: ['Alice'],
  transcript: { turns: [], source: 'captions-only', notes: [] },
  summary: null,
  transcription: null,
  createdAt: T0,
};

/** State a previous worker left behind: the offscreen document survived and is still recording. */
function offscreenStillRecording(...ids: string[]) {
  h.offscreen.start();
  for (const id of ids) h.offscreen.recording.add(id);
}

/** A worker restart inside the same browser session (storage.session survived). */
async function sameBrowserSession() {
  await fakeBrowser.storage.session.set({ bootScanned: true });
}

describe('recovering interrupted recordings', () => {
  it('recovers a recording cut short by a browser restart and transcribes it', async () => {
    await putSession(stored({ lastHeartbeat: STARTED + 60_000 }));
    h.offscreen.audio.set(ID, { sessionId: ID, chunkCount: 13, bytes: 52_000 });
    h.clock.set(T0 + HOUR);

    const m = h.createManager();
    await m.boot();
    await m.idle();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({
      recovered: true,
      endedAt: STARTED + 60_000,
      durationMs: 60_000,
      route: 'team',
      audio: { chunkCount: 13, bytes: 52_000 },
      status: 'saved',
    });
    const [job] = h.offscreen.callsOf('offscreen/process');
    expect(job?.meta).toMatchObject({ id: ID, recovered: true, status: 'processing' });
    expect(h.windowsCreate).not.toHaveBeenCalled();
  });

  it('leaves the recovered session ready when auto-transcribe is off', async () => {
    await configure({ autoTranscribe: false, defaultRoute: 'personal' });
    await putSession(stored());
    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(await getSession(ID)).toMatchObject({
      status: 'ready',
      recovered: true,
      endedAt: STARTED,
      durationMs: 0,
      route: 'personal',
    });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('recovers when the pointer survived but the offscreen document is gone', async () => {
    await configure({ autoTranscribe: false });
    await sameBrowserSession();
    await putSession(stored({ lastHeartbeat: STARTED + 5000 }));
    const tabId = await h.openMeetTab();
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });
    await fakeBrowser.action.setBadgeText({ text: 'REC' });

    const m = h.createManager();
    await m.boot();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', recovered: true, endedAt: STARTED + 5000 });
    expect(await getActiveRecording()).toBeNull();
    expect(await h.badge()).toBe('');
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE })).toBeNull();
  });

  it('recovers when the offscreen document no longer lists the recording', async () => {
    await configure({ autoTranscribe: false });
    await sameBrowserSession();
    await putSession(stored());
    const tabId = await h.openMeetTab();
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });
    offscreenStillRecording();

    const m = h.createManager();
    await m.boot();
    expect(h.offscreen.callsOf('offscreen/recorder-status')).toHaveLength(1);
    expect(await getSession(ID)).toMatchObject({ status: 'ready', recovered: true });
  });

  it('leaves a live recording alone after a worker restart', async () => {
    await sameBrowserSession();
    await putSession(stored());
    const tabId = await h.openMeetTab();
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });
    offscreenStillRecording(ID);

    const m = h.createManager();
    await m.boot();
    await m.idle();
    const meta = await getSession(ID);
    expect(meta?.status).toBe('recording');
    expect(meta?.recovered).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
    expect(await getActiveRecording()).toEqual({ sessionId: ID, tabId, meetCode: MEET_CODE });
    expect(await h.badge()).toBe('REC');
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE })).toEqual({ sessionId: ID, startedAt: STARTED });
  });

  it('stops a recorder that no session points at', async () => {
    await configure({ autoTranscribe: false });
    await sameBrowserSession();
    await putSession(stored());
    offscreenStillRecording(ID);

    const m = h.createManager();
    await m.boot();
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toEqual([{ sessionId: ID }]);
    expect(h.offscreen.recording.size).toBe(0);
    expect(await getSession(ID)).toMatchObject({ status: 'ready', recovered: true });
  });

  it('keeps a captions-only recording while its tab is still in the call', async () => {
    await sameBrowserSession();
    const audio = { mimeType: '', chunkCount: 0, bytes: 0, micIncluded: false, error: 'Tab audio capture failed' };
    await putSession(stored({ audio }));
    const tabId = await h.openMeetTab(`${MEET_URL}?authuser=0`);
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });

    const m = h.createManager();
    await m.boot();
    expect((await getSession(ID))?.status).toBe('recording');
    expect(await h.badge()).toBe('REC');

    // Same state, but the tab has moved on.
    await fakeBrowser.tabs.update(tabId, { url: 'https://meet.google.com/' });
    await h.createManager().boot();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', recovered: true });
    expect(await getActiveRecording()).toBeNull();
  });

  it('does not treat a session being started as orphaned', async () => {
    const tabId = await h.openMeetTab();
    const m = h.createManager();
    await m.boot();

    let reached!: () => void;
    const atRecorder = new Promise<void>((r) => {
      reached = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const inner = h.offscreen.recorderStart;
    h.offscreen.recorderStart = async (req) => {
      reached();
      await gate;
      return inner(req);
    };

    const started = m.start(tabId);
    await atRecorder;
    // An onStartup boot runs to completion while the recorder has not answered yet.
    await m.boot({ full: true });
    expect((await getSession(ID))?.status).toBe('recording');
    expect(await getActiveRecording()).toMatchObject({ sessionId: ID, tabId });

    release();
    expect(await started).toEqual({ ok: true, sessionId: ID });
    expect((await getSession(ID))?.status).toBe('recording');
  });
});

describe('recovery racing a finalize', () => {
  it('leaves a session that is being finalized to the finalize', async () => {
    const tabId = await h.openMeetTab();
    const m = h.createManager();
    await m.boot();
    await m.start(tabId);

    // Hold the recorder's answer to the stop request; it has already stopped recording.
    let reached!: () => void;
    const atStop = new Promise<void>((r) => {
      reached = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.offscreen.onRecorderStop = async () => {
      reached();
      await gate;
    };

    const left = m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await atStop;
    await m.boot({ full: true });
    release();
    await left;
    await m.idle();

    const meta = await getSession(ID);
    expect(meta?.status).toBe('awaiting-route');
    expect(meta?.recovered).toBeUndefined();
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });
});

describe('interrupted jobs and alarms', () => {
  it('puts sessions stuck in processing or saving back where a retry can start', async () => {
    const a = 'aaa-bbbb-ccc_20260919T080000Z';
    const b = 'aaa-bbbb-ccc_20260919T070000Z';
    const c = 'aaa-bbbb-ccc_20260919T060000Z';
    await putSession(stored({ id: a, status: 'processing', stage: 'transcribing-text', route: 'team' }));
    await putSession(stored({ id: b, status: 'saving', stage: 'saving', route: 'team' }));
    await putResult(b, RESULT);
    await putSession(stored({ id: c, status: 'saving', route: 'team' }));

    const m = h.createManager();
    await m.boot();
    await m.idle();
    const [sa, sb, sc] = await Promise.all([getSession(a), getSession(b), getSession(c)]);
    expect(sa).toMatchObject({ status: 'ready' });
    expect(sa?.stage).toBeUndefined();
    expect(sb).toMatchObject({ status: 'processed' });
    expect(sb?.stage).toBeUndefined();
    expect(sc).toMatchObject({ status: 'ready' });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('applies overdue default routes and re-arms pending route alarms', async () => {
    const overdue = 'aaa-bbbb-ccc_20260919T080000Z';
    const pending = 'aaa-bbbb-ccc_20260919T083000Z';
    h.clock.set(T0 + HOUR);
    await putSession(stored({ id: overdue, status: 'awaiting-route', endedAt: T0 + HOUR - 10 * 60_000 }));
    await putSession(stored({ id: pending, status: 'awaiting-route', endedAt: T0 + HOUR - 30_000 }));

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(await getSession(overdue)).toMatchObject({ status: 'saved', route: 'team' });
    expect(await getSession(pending)).toMatchObject({ status: 'awaiting-route' });
    expect((await fakeBrowser.alarms.get(`route:${pending}`))?.scheduledTime).toBe(T0 + HOUR - 30_000 + 2 * 60_000);
  });

  it('creates the periodic retention alarm once', async () => {
    const create = vi.spyOn(fakeBrowser.alarms, 'create');
    const m = h.createManager();
    await m.boot();
    await m.boot();
    const alarm = await fakeBrowser.alarms.get('retention');
    expect(alarm?.periodInMinutes).toBe(360);
    expect(create.mock.calls.filter((c) => c[0] === 'retention')).toHaveLength(1);
  });
});

describe('orphaned audio', () => {
  it('creates a session for audio in OPFS that has none', async () => {
    const orphan = 'xyz-abcd-efg_20260918T140502Z';
    await putSession(stored({ status: 'saved' }));
    h.offscreen.audio.set(orphan, { sessionId: orphan, chunkCount: 24, bytes: 96_000 });
    h.offscreen.audio.set(ID, { sessionId: ID, chunkCount: 12, bytes: 48_000 });
    h.offscreen.audio.set('not-a-session', { sessionId: 'not-a-session', chunkCount: 3, bytes: 10 });
    h.offscreen.audio.set('aaa-bbbb-ccc_20260918T100000Z', {
      sessionId: 'aaa-bbbb-ccc_20260918T100000Z',
      chunkCount: 0,
      bytes: 0,
    });

    const m = h.createManager();
    await m.boot();
    await m.idle();

    const startedAt = Date.UTC(2026, 8, 18, 14, 5, 2);
    expect(await getSession(orphan)).toEqual({
      id: orphan,
      meetCode: 'xyz-abcd-efg',
      startedAt,
      endedAt: startedAt + 120_000,
      durationMs: 120_000,
      status: 'ready',
      route: 'team',
      recovered: true,
      idempotencyKey: idempotencyKey('xyz-abcd-efg', startedAt),
      audio: { mimeType: 'audio/webm', chunkCount: 24, bytes: 96_000, micIncluded: false },
      captionCount: 0,
    });
    expect((await listSessions()).map((s) => s.id).sort()).toEqual([ID, orphan].sort());
    // Orphans wait for an explicit Transcribe.
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('scans once per browser session, and again when the browser starts', async () => {
    await h.createManager().boot();
    expect(h.offscreen.callsOf('offscreen/audio-scan')).toHaveLength(1);

    // Worker restart in the same browser session.
    const m = h.createManager();
    await m.boot();
    expect(h.offscreen.callsOf('offscreen/audio-scan')).toHaveLength(1);

    await m.boot({ full: true });
    await m.boot({ full: true });
    expect(h.offscreen.callsOf('offscreen/audio-scan')).toHaveLength(2);
  });
});

describe('audio retention', () => {
  const due = 'aaa-bbbb-ccc_20260919T080000Z';
  const later = 'aaa-bbbb-ccc_20260919T070000Z';
  const gone = 'aaa-bbbb-ccc_20260919T060000Z';
  const unsaved = 'aaa-bbbb-ccc_20260919T050000Z';

  beforeEach(async () => {
    const audio = stored().audio;
    await putSession(stored({ id: due, status: 'saved', savedAt: T0, purgeAudioAt: T0 + 7 * DAY }));
    await putSession(stored({ id: later, status: 'saved', savedAt: T0 + 2 * DAY, purgeAudioAt: T0 + 9 * DAY }));
    await putSession(
      stored({ id: gone, status: 'saved', purgeAudioAt: T0, audio: { ...audio, deletedAt: T0 + 1000 } }),
    );
    await putSession(stored({ id: unsaved, status: 'ready' }));
  });

  it('deletes audio whose retention has passed when the alarm fires', async () => {
    const m = h.createManager();
    await m.boot();
    expect(h.offscreen.callsOf('offscreen/audio-delete')).toEqual([]);

    h.clock.set(T0 + 7 * DAY);
    await m.onAlarm('retention');
    expect(h.offscreen.callsOf('offscreen/audio-delete')).toEqual([{ sessionId: due }]);
    expect((await getSession(due))?.audio.deletedAt).toBe(T0 + 7 * DAY);
    expect((await getSession(later))?.audio.deletedAt).toBeUndefined();
    expect((await getSession(unsaved))?.audio.deletedAt).toBeUndefined();

    await m.sweepRetention();
    expect(h.offscreen.callsOf('offscreen/audio-delete')).toHaveLength(1);
  });

  it('sweeps at boot', async () => {
    h.clock.set(T0 + 10 * DAY);
    await h.createManager().boot();
    expect(h.offscreen.callsOf('offscreen/audio-delete').map((c) => c.sessionId).sort()).toEqual([due, later].sort());
  });

  it('retries a deletion that failed', async () => {
    h.clock.set(T0 + 8 * DAY);
    h.offscreen.audioDeleteError = 'OPFS busy';
    const m = h.createManager();
    await m.boot();
    expect((await getSession(due))?.audio.deletedAt).toBeUndefined();

    h.offscreen.audioDeleteError = null;
    await m.onAlarm('retention');
    expect((await getSession(due))?.audio.deletedAt).toBe(T0 + 8 * DAY);
  });
});
