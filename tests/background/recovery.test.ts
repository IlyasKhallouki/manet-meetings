import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { putResult } from '@lib/storage/resultStore';
import { getActiveRecording, getSession, listSessions, putSession, setActiveRecording } from '@lib/storage/sessionStore';
import type { SessionMeta, SessionResult } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import { configure, DAY, MEET_CODE, MEET_URL, seg, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const STARTED = T0 + 150;
const HOUR = 60 * 60 * 1000;
const ROUTE_DELAY = 2 * 60 * 1000;

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

/** A stored transcript with something said in it. */
const TRANSCRIBED: SessionResult = {
  ...RESULT,
  transcript: { turns: [{ speaker: 'Alice', start: 0, end: 4000, text: 'Bonjour' }], source: 'audio+captions', notes: [] },
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
  it('asks where a recording cut short by a browser restart goes, then files it', async () => {
    await putSession(stored({ lastHeartbeat: STARTED + 60_000 }));
    h.offscreen.audio.set(ID, { sessionId: ID, chunkCount: 13, bytes: 52_000 });
    h.clock.set(T0 + HOUR);

    const m = h.createManager();
    await m.boot();
    await m.idle();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({
      status: 'awaiting-route',
      recovered: true,
      endedAt: STARTED + 60_000,
      durationMs: 60_000,
      audio: { chunkCount: 13, bytes: 52_000 },
    });
    expect(meta?.route).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(h.windowsCreate.mock.calls[0]?.[0]).toMatchObject({
      url: `chrome-extension://test-extension-id/routing.html?session=${encodeURIComponent(ID)}`,
    });
    expect((await fakeBrowser.alarms.get(`route:${ID}`))?.scheduledTime).toBe(T0 + HOUR + ROUTE_DELAY);
    // Pages read the same time from the meeting.
    expect(meta?.routeDeadline).toBe(T0 + HOUR + ROUTE_DELAY);

    // Nobody answers: the default route applies and auto-transcribe files it.
    await m.onAlarm(`route:${ID}`);
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'saved', route: 'team' });
    const [job] = h.offscreen.callsOf('offscreen/process');
    expect(job?.meta).toMatchObject({ id: ID, recovered: true, status: 'processing' });
  });

  it('waits for the route when auto-transcribe is off', async () => {
    await configure({ autoTranscribe: false, defaultRoute: 'personal' });
    await putSession(stored());
    const m = h.createManager();
    await m.boot();
    await m.onAlarm(`route:${ID}`);
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
    expect(await getSession(ID)).toMatchObject({ status: 'awaiting-route', recovered: true, endedAt: STARTED + 5000 });
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(await getActiveRecording()).toBeNull();
    // No longer recording; the recovered meeting waits for Team or Personal.
    expect(h.icon()).toBe('idle');
    expect(await h.badge()).toBe('1');
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
    expect(await getSession(ID)).toMatchObject({ status: 'awaiting-route', recovered: true });
  });

  it('keeps a recording whose recorder status cannot be read', async () => {
    await sameBrowserSession();
    await putSession(stored());
    const tabId = await h.openMeetTab();
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });
    offscreenStillRecording(ID);
    h.offscreen.recorderStatusError = 'Recorder status timed out';

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect((await getSession(ID))?.status).toBe('recording');
    expect(await getActiveRecording()).toEqual({ sessionId: ID, tabId, meetCode: MEET_CODE });
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('');
    expect(h.pushes).toEqual([]);
  });

  it('does not wait on the tab when it releases a dead recording', async () => {
    await sameBrowserSession();
    await putSession(stored());
    const tabId = await h.openMeetTab();
    await setActiveRecording({ sessionId: ID, tabId, meetCode: MEET_CODE });
    const m = h.createManager();
    // Like the content script: it answers only once its last caption batch was taken.
    h.hooks.onPush = async (_tab, state) => {
      if (state === null) await m.onCaptions({ sessionId: ID, segments: [seg('c9', 'Alice', 1000, 'Au revoir')] });
    };

    const outcome = await Promise.race([
      m.boot().then(() => 'booted'),
      new Promise((r) => setTimeout(() => r('stuck'), 1000)),
    ]);
    expect(outcome).toBe('booted');
    await m.idle();
    expect((await getSession(ID))?.captionCount).toBe(1);
    expect(h.pushes).toEqual([{ tabId, state: null }]);
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
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('');
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
    expect(await getSession(ID)).toMatchObject({ status: 'awaiting-route', recovered: true });
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
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('!');

    // Same state, but the tab has moved on while the worker slept: ask, don't file silently.
    await fakeBrowser.tabs.update(tabId, { url: 'https://meet.google.com/' });
    const next = h.createManager();
    await next.boot();
    await next.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'awaiting-route', recovered: true });
    expect(await getActiveRecording()).toBeNull();
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
    expect(await fakeBrowser.alarms.get(`route:${ID}`)).toBeDefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
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
  it('puts sessions whose job died back where a retry can start', async () => {
    await configure({ autoTranscribe: false });
    const a = 'aaa-bbbb-ccc_20260919T080000Z';
    const b = 'aaa-bbbb-ccc_20260919T070000Z';
    const c = 'aaa-bbbb-ccc_20260919T060000Z';
    const job = (id: string, kind: 'process' | 'save') => ({ id, kind, startedAt: T0 });
    await putSession(stored({ id: a, status: 'processing', stage: 'transcribing-text', route: 'team', job: job('ja', 'process') }));
    await putSession(stored({ id: b, status: 'saving', stage: 'saving', route: 'team', job: job('jb', 'save') }));
    await putResult(b, RESULT);
    await putSession(stored({ id: c, status: 'saving', route: 'team', job: job('jc', 'save') }));

    const m = h.createManager();
    await m.boot();
    await m.idle();
    const [sa, sb, sc] = await Promise.all([getSession(a), getSession(b), getSession(c)]);
    expect(sa).toMatchObject({ status: 'ready' });
    expect(sa?.stage).toBeUndefined();
    expect(sa?.job).toBeUndefined();
    expect(sb).toMatchObject({ status: 'processed' });
    expect(sb?.stage).toBeUndefined();
    expect(sc).toMatchObject({ status: 'ready' });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
  });

  it('runs jobs that died again when auto-transcribe is on', async () => {
    const a = 'aaa-bbbb-ccc_20260919T080000Z';
    const b = 'aaa-bbbb-ccc_20260919T070000Z';
    await putSession(
      stored({ id: a, status: 'processing', route: 'personal', attempt: 2, job: { id: 'ja', kind: 'process', startedAt: T0 } }),
    );
    await putSession(stored({ id: b, status: 'saving', route: 'team', job: { id: 'jb', kind: 'save', startedAt: T0 } }));
    await putResult(b, RESULT);

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process').map((j) => [j.meta.id, j.profile.id, j.attempt])).toEqual([
      [a, 'personal', 2],
    ]);
    expect(h.offscreen.callsOf('offscreen/save').map((j) => j.meta.id).sort()).toEqual([a, b].sort());
    expect((await getSession(a))?.status).toBe('saved');
    expect((await getSession(b))?.status).toBe('saved');
  });

  it('writes the notes again, without transcribing, when a job that only had to do that died', async () => {
    // The profile changed after transcription; the new notes were being written when the worker and document went.
    await putSession(
      stored({
        status: 'processing',
        route: 'team',
        profileId: 'personal',
        job: { id: 'ja', kind: 'process', startedAt: T0, summaryOnly: true },
      }),
    );
    await putResult(ID, { ...TRANSCRIBED, profile: { id: 'team', name: 'Team' } });

    const m = h.createManager();
    await m.boot();
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(1);
    expect(processes[0]?.reuse?.profile?.id).toBe('team');
    expect(processes[0]?.profile.id).toBe('personal');
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.profile.databaseId).toBe('personal-db');
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('keeps the transcript of a job that only had to write the notes again, when auto-transcribe is off', async () => {
    await configure({ autoTranscribe: false });
    await putSession(
      stored({
        status: 'processing',
        route: 'team',
        profileId: 'personal',
        job: { id: 'ja', kind: 'process', startedAt: T0, summaryOnly: true },
      }),
    );
    await putResult(ID, { ...TRANSCRIBED, profile: { id: 'team', name: 'Team' } });

    const m = h.createManager();
    await m.boot();
    await m.idle();
    const meta = await getSession(ID);
    // Save writes the notes for Personal first; Transcribe isn't needed again.
    expect(meta).toMatchObject({ status: 'processed' });
    expect(meta?.job).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('leaves a session alone while the offscreen document still runs its job', async () => {
    await sameBrowserSession();
    await putSession(stored({ status: 'processing', route: 'team', job: { id: 'j1', kind: 'process', startedAt: T0 } }));
    h.offscreen.start();
    h.offscreen.runningJob({ sessionId: ID, jobId: 'j1', kind: 'process' });

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/job-status')).toHaveLength(1);
    expect(await getSession(ID)).toMatchObject({ status: 'processing', job: { id: 'j1' } });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);

    // Its report still lands, in whichever worker is up.
    await m.onJobDone({ sessionId: ID, jobId: 'j1', kind: 'process', outcome: { status: 'error', error: 'Processing failed: boom' } });
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Transcribing stopped before it finished. Try again.' });
  });

  it('asks again for routes whose prompt and alarm a browser restart lost', async () => {
    const overdue = 'aaa-bbbb-ccc_20260919T080000Z';
    const pending = 'aaa-bbbb-ccc_20260919T083000Z';
    h.clock.set(T0 + HOUR);
    await putSession(stored({ id: overdue, status: 'awaiting-route', endedAt: T0 + HOUR - 10 * 60_000 }));
    await putSession(stored({ id: pending, status: 'awaiting-route', endedAt: T0 + HOUR - 30_000 }));

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(await getSession(overdue)).toMatchObject({ status: 'awaiting-route' });
    expect(await getSession(pending)).toMatchObject({ status: 'awaiting-route' });
    expect(h.windowsCreate).toHaveBeenCalledTimes(2);
    for (const id of [overdue, pending]) {
      expect((await fakeBrowser.alarms.get(`route:${id}`))?.scheduledTime).toBe(T0 + HOUR + ROUTE_DELAY);
      const meta = await getSession(id);
      expect(meta?.routeDeadline).toBe(T0 + HOUR + ROUTE_DELAY);
    }
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('applies a default route whose alarm fired while the worker was starting', async () => {
    await sameBrowserSession();
    const fired = 'aaa-bbbb-ccc_20260919T080000Z';
    const pending = 'aaa-bbbb-ccc_20260919T083000Z';
    h.clock.set(T0 + HOUR);
    await putSession(stored({ id: fired, status: 'awaiting-route', endedAt: T0 + HOUR - 10 * 60_000 }));
    await putSession(stored({ id: pending, status: 'awaiting-route', endedAt: T0 + HOUR - 30_000 }));

    const m = h.createManager();
    await m.boot();
    await m.idle();
    expect(await getSession(fired)).toMatchObject({ status: 'saved', route: 'team' });
    // Not due yet, so it never fired: it was never armed, and its prompt never showed.
    expect(await getSession(pending)).toMatchObject({ status: 'awaiting-route' });
    expect((await fakeBrowser.alarms.get(`route:${pending}`))?.scheduledTime).toBe(T0 + HOUR + ROUTE_DELAY);
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('re-arms automatic retries a browser restart lost', async () => {
    await putSession(stored({ status: 'failed', route: 'team', attempt: 1, retryAt: T0 + HOUR, error: 'Gemini is unavailable right now (503). Retrying automatically at 10:00.' }));
    const m = h.createManager();
    await m.boot();
    expect((await fakeBrowser.alarms.get(`retry:${ID}`))?.scheduledTime).toBe(T0 + HOUR);
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
      // Stored with the default route only; read with it as its profile.
      profileId: 'team',
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
