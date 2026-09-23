import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadCaptions } from '@lib/storage/captionStore';
import { getResult } from '@lib/storage/resultStore';
import { getActiveRecording, getSession, listSessions, watchSessions } from '@lib/storage/sessionStore';
import type { SessionStatus } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { clockTime, configure, DAY, deferred, MEET_CODE, MEET_URL, seg, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  await configure();
  m = h.createManager();
  await m.boot();
});

/** Starts recording a fresh Meet tab (for `profileId`, else the default profile) and returns its id. */
async function record(profileId?: string): Promise<number> {
  const tabId = await h.openMeetTab();
  expect(await m.start(tabId, profileId)).toEqual({ ok: true, sessionId: ID });
  return tabId;
}

/** Holds the recorder's answer to 'offscreen/recorder-start' until `release`. */
function gateRecorderStart() {
  const reached = deferred();
  const gate = deferred();
  const inner = h.offscreen.recorderStart;
  h.offscreen.recorderStart = async (req) => {
    reached.resolve();
    await gate.promise;
    return inner(req);
  };
  return { reached: reached.promise, release: gate.resolve };
}

describe('recording lifecycle', () => {
  it('records, transcribes and saves a meeting', async () => {
    const statuses: SessionStatus[] = [];
    const unwatch = watchSessions((id, meta) => {
      if (id === ID && meta && statuses.at(-1) !== meta.status) statuses.push(meta.status);
    });

    const tabId = await record('personal');
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
      profileId: 'personal',
      startedAt,
      idempotencyKey: idempotencyKey(MEET_CODE, startedAt),
      audio: { mimeType: 'audio/webm;codecs=opus', micIncluded: true, chunkCount: 0, bytes: 0 },
      captionCount: 0,
    });
    expect(meta?.audio.error).toBeUndefined();
    expect(await getActiveRecording()).toEqual({ sessionId: ID, tabId, meetCode: MEET_CODE });
    // Red dot on the icon, no badge: nothing is wrong. The tooltip names no meeting.
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('');
    expect(await h.badgeTitle()).toBe(`Recording since ${clockTime(startedAt)}`);
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
      endedAt,
      durationMs: endedAt - startedAt,
      audio: { chunkCount: 3, bytes: 12_000 },
    });
    expect(await getActiveRecording()).toBeNull();
    await m.idle();
    // Back to the idle icon; no window asks anything once the call ends.
    expect(h.icon()).toBe('idle');
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
    expect(h.windowsCreated()).toEqual([]);

    const [job] = h.offscreen.callsOf('offscreen/process');
    expect(job?.profile).toMatchObject({ id: 'personal', databaseId: 'personal-db' });
    expect(job?.meta).toMatchObject({ id: ID, status: 'processing', profileId: 'personal' });
    expect(job?.meta.route).toBeUndefined();
    expect(job?.captions).toEqual(await loadCaptions(ID));
    expect(job?.captions.map((c) => c.text)).toEqual(['Bonjour à tous', 'Hi all']);
    expect(job?.settings.notionPersonalDbId).toBe('personal-db');

    const result = await getResult(ID);
    expect(result?.title).toBe('Weekly sync');
    const [saveJob] = h.offscreen.callsOf('offscreen/save');
    expect(saveJob).toMatchObject({ profile: { id: 'personal', databaseId: 'personal-db' }, result, meta: { id: ID, status: 'saving' } });

    const saved = await getSession(ID);
    const savedAt = h.clock.now();
    expect(saved).toMatchObject({
      status: 'saved',
      profileId: 'personal',
      notion: { pageId: 'page-1', url: 'https://www.notion.so/page-1', recordedBy: 'Ilyas' },
      savedAt,
      purgeAudioAt: savedAt + 7 * DAY,
    });
    expect(saved?.stage).toBeUndefined();
    expect(saved?.error).toBeUndefined();
    expect(statuses).toEqual(['recording', 'ready', 'processing', 'processed', 'saving', 'saved']);
    expect(saved?.job).toBeUndefined();
    expect(await h.badge()).toBe('');
    expect(h.notifications()).toEqual([
      {
        id: `manet:${ID}`,
        title: 'Saved to Notion',
        message: `Your ${clockTime(startedAt)} meeting (under 1 min) is in Personal.`,
      },
    ]);
    unwatch();
  });

  it('transcribes as soon as the call ends, with auto-transcribe on', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(h.windowsCreated()).toEqual([]); // no routing window
    expect((await getSession(ID))?.status).toBe('saved');
    expect(h.offscreen.callsOf('offscreen/process')[0]?.profile.id).toBe('team');
  });

  it('waits for Transcribe with auto-transcribe off', async () => {
    await configure({ autoTranscribe: false });
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', profileId: 'team' });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    // Nothing is due, so the badge stays clear.
    expect(await h.badge()).toBe('');

    await m.setProfile(ID, 'personal');
    await m.transcribe(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')[0]?.profile.id).toBe('personal');
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('ignores a route alarm an older version left behind', async () => {
    await configure({ autoTranscribe: false });
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.onAlarm(`route:${ID}`);
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', profileId: 'team' });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
  });

  it('keeps the roll of speakers in the session, in order of first speech', async () => {
    await record();
    await m.onCaptions({
      sessionId: ID,
      segments: [seg('c2', 'Tom Martin', 6000, 'Salut'), { ...seg('c1', 'Vous', 1000, 'Bonjour'), self: true }],
    });
    await m.onCaptions({ sessionId: ID, segments: [seg('c3', 'Marie Curie', 9000, 'On commence ?'), seg('c4', 'Tom Martin', 12_000, 'Oui')] });
    expect((await getSession(ID))?.speakers).toEqual([
      { name: 'Vous', self: true, firstAt: 1000, lastAt: 3000, talkMs: 2000 },
      { name: 'Tom Martin', self: false, firstAt: 6000, lastAt: 14_000, talkMs: 4000 },
      { name: 'Marie Curie', self: false, firstAt: 9000, lastAt: 11_000, talkMs: 2000 },
    ]);
    expect((await getSession(ID))?.captionCount).toBe(4);

    // A late batch after the end still lands in the roll Meetings shows.
    await configure({ autoTranscribe: false });
    await m.stop(ID);
    await m.onCaptions({ sessionId: ID, segments: [seg('c5', 'Léa', 15_000, 'Au revoir')] });
    expect((await getSession(ID))?.speakers?.map((s) => s.name)).toEqual(['Vous', 'Tom Martin', 'Marie Curie', 'Léa']);
  });
});

describe('duplicates and failures', () => {
  async function recordAndTranscribe() {
    const tabId = await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
  }

  it('stops at the duplicate check when a teammate already saved the meeting', async () => {
    h.offscreen.process = () => ({
      status: 'duplicate',
      existing: { pageId: 'p9', url: 'https://www.notion.so/p9', recordedBy: 'Alice' },
    });
    await recordAndTranscribe();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({
      status: 'duplicate',
      notion: { pageId: 'p9', url: 'https://www.notion.so/p9', recordedBy: 'Alice' },
    });
    expect(meta?.purgeAudioAt).toBe(h.clock.now() + 7 * DAY);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
    expect(await getResult(ID)).toBeNull();
    expect(h.notifications()).toContainEqual({
      id: `manet:${ID}`,
      title: 'Already in Notion',
      message: `Alice saved the ${clockTime(T0 + 150)} meeting, so yours wasn’t added.`,
    });
  });

  it('marks a duplicate found at save time and keeps the local result', async () => {
    h.offscreen.save = () => ({
      status: 'duplicate',
      existing: { pageId: 'p7', url: 'https://www.notion.so/p7', recordedBy: 'Bob' },
    });
    await recordAndTranscribe();
    expect(await getSession(ID)).toMatchObject({ status: 'duplicate', notion: { pageId: 'p7', recordedBy: 'Bob' } });
    expect(await getResult(ID)).not.toBeNull();
    expect(h.notifications().map((n) => n.message)).toContainEqual(expect.stringMatching(/^Bob saved the /));
  });

  it('keeps the result when saving fails, then saves on retry', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion returned 502' });
    await recordAndTranscribe();
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Notion returned 502' });
    expect(await getResult(ID)).not.toBeNull();
    expect(h.notifications()).toContainEqual({
      id: `manet:${ID}`,
      title: `Couldn’t save the ${clockTime(T0 + 150)} meeting`,
      message: 'Notion returned 502.',
    });

    h.offscreen.save = () => ({ status: 'created', pageId: 'page-2', url: 'https://www.notion.so/page-2' });
    await m.save(ID);
    await m.idle();
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'saved', notion: { pageId: 'page-2' } });
    expect(meta?.error).toBeUndefined();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
  });

  it('marks the session failed when the pipeline reports an error', async () => {
    h.offscreen.process = () => ({ status: 'error', error: 'Processing failed: TypeError: turns is undefined' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordAndTranscribe();
    // A bug's words are for the console; the meeting says what happened and what to do.
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Transcribing stopped before it finished. Try again.' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[manet\] Transcribing .* failed:$/), expect.stringContaining('turns is undefined'));
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
    await expect(m.save(ID)).rejects.toThrow(/transcribe/i);
  });

  it('marks the session failed when the offscreen document throws mid-job', async () => {
    h.offscreen.process = () => {
      throw new Error('Offscreen crashed');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await recordAndTranscribe();
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'Transcribing stopped before it finished. Try again.' });
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('Offscreen crashed'));
    expect((await getSession(ID))?.stage).toBeUndefined();
  });

  it('runs one job per session', async () => {
    await configure({ autoTranscribe: false });
    const gate = deferred();
    const inner = h.offscreen.process;
    h.offscreen.process = async (job) => {
      await gate.promise;
      return inner(job);
    };
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });

    await Promise.all([m.transcribe(ID), m.transcribe(ID)]);
    await m.transcribe(ID);
    await m.save(ID);
    expect((await getSession(ID))?.status).toBe('processing');

    await m.onJobProgress({ sessionId: ID, stage: 'transcribing-timing' });
    expect((await getSession(ID))?.stage).toBe('transcribing-timing');

    gate.resolve();
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(1);
    expect((await getSession(ID))?.stage).toBeUndefined();
  });
});

describe('capture failures keep a captions-only session', () => {
  it('when tab capture is refused', async () => {
    h.getMediaStreamId.mockRejectedValueOnce(new Error('Extension has not been invoked for the current page'));
    const tabId = await record();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'recording', startedAt: T0, audio: { chunkCount: 0 } });
    expect(meta?.audio.error).toBe('Chrome couldn’t capture the call audio.');
    expect(h.offscreen.callsOf('offscreen/recorder-start')).toHaveLength(0);
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt: T0 } }]);
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toBe('Recording captions only — no call audio');

    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 500, 'On commence')] });
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
    expect(h.windowsCreated()).toEqual([]);
    expect(await getSession(ID)).toMatchObject({ status: 'saved', captionCount: 1 });
  });

  it('when the recorder cannot start', async () => {
    h.offscreen.recorderStart = () => ({ ok: false, error: 'NotAllowedError: Permission denied' });
    await record();
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'recording', startedAt: T0 });
    expect(meta?.audio.error).toBe('The recorder couldn’t start, so only captions are being saved.');
  });

  it('when the offscreen document cannot be created', async () => {
    // Boot opened the document; it has gone away and cannot be reopened.
    h.offscreen.close();
    h.createDocument.mockRejectedValueOnce(new Error('offscreen blocked'));
    await record();
    expect((await getSession(ID))?.audio.error).toBe('The recorder couldn’t start, so only captions are being saved.');
  });
});

describe('ending a recording', () => {
  beforeEach(() => configure({ autoTranscribe: false }));

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
    expect(h.windowsCreated()).toEqual([]);
    const meta = await getSession(ID);
    expect(meta?.status).toBe('ready');
    expect(meta?.audio.error).toBeUndefined();
  });

  it('ignores a requested-stop report arriving after finalize, apart from the final counts', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.onRecorderStopped({ sessionId: ID, reason: 'requested', chunkCount: 9, bytes: 36_000 });
    expect(await getSession(ID)).toMatchObject({ status: 'ready', audio: { chunkCount: 9, bytes: 36_000 } });
  });

  it('ends when the tab audio ends because the tab left the call', async () => {
    const tabId = await record();
    // The worker missed the URL change; the recorder's report is what arrives.
    await fakeBrowser.tabs.update(tabId, { url: 'https://meet.google.com/landing' });
    await m.onRecorderStopped({ sessionId: ID, reason: 'track-ended', chunkCount: 2, bytes: 8000 });
    expect(await getSession(ID)).toMatchObject({ status: 'ready', audio: { chunkCount: 2, bytes: 8000 } });
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
    expect((await getSession(ID))?.status).toBe('ready');
  });

  it('ignores a leave report from another tab', async () => {
    await record();
    const other = await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    await m.onMeetLeft(other, { meetCode: 'xyz-abcd-efg' });
    await m.onTabRemoved(other);
    expect((await getSession(ID))?.status).toBe('recording');
  });
});

describe('audio failing mid-call', () => {
  it('keeps capturing captions when the recorder fails, until the meeting ends', async () => {
    const tabId = await record();
    await m.onRecorderStopped({ sessionId: ID, reason: 'error', error: 'QuotaExceededError', chunkCount: 2, bytes: 8000 });

    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'recording', audio: { chunkCount: 2, bytes: 8000 } });
    // Under the red "Recording", never "Recording stopped"; the recorder's own error is kept.
    expect(meta?.audio.error).toBe('Chrome stopped the audio recording (QuotaExceededError).');
    expect(await getActiveRecording()).toMatchObject({ sessionId: ID, tabId });
    expect(h.icon()).toBe('recording');
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toMatch(/captions only/);
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt: T0 + 150 } }]);
    expect(h.windowsCreated()).toEqual([]);
    // The reason stays in the popup; the notification says what it means for the meeting.
    expect(h.notifications()).toEqual([
      {
        id: `manet:${ID}`,
        title: 'Recording captions only',
        message: "Call audio couldn’t be captured. Speakers and what they say are still being saved.",
      },
    ]);
    expect(await fakeBrowser.alarms.get('recorder-watchdog')).toBeUndefined();

    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 60_000, 'Toujours là')] });
    expect((await getSession(ID))?.captionCount).toBe(1);
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toHaveLength(0);
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
  });

  it('keeps capturing captions when the tab audio ends while the tab stays in the call', async () => {
    const tabId = await record();
    await m.onRecorderStopped({ sessionId: ID, reason: 'track-ended', chunkCount: 3, bytes: 12_000 });
    const meta = await getSession(ID);
    expect(meta?.status).toBe('recording');
    expect(meta?.audio.error).toBe('The Meet tab’s audio ended.');
    expect(await getActiveRecording()).toMatchObject({ sessionId: ID, tabId });
  });
});

describe('recorder watchdog', () => {
  it('runs while audio is recorded', async () => {
    await record();
    expect((await fakeBrowser.alarms.get('recorder-watchdog'))?.periodInMinutes).toBe(0.5);
    await m.stop(ID);
    expect(await fakeBrowser.alarms.get('recorder-watchdog')).toBeUndefined();
    await m.idle();
  });

  it('degrades to captions only when the offscreen document died without a word', async () => {
    const tabId = await record();
    h.clock.advance(5000);
    await m.onRecorderChunk({ sessionId: ID, index: 0, bytes: 4000 });
    expect((await getSession(ID))?.audio.lastChunkAt).toBe(h.clock.now());
    h.offscreen.close(); // a renderer crash: no 'recorder-stopped' ever comes

    h.clock.advance(10_000);
    await m.onAlarm('recorder-watchdog');
    expect((await getSession(ID))?.audio.error).toBeUndefined();

    h.clock.advance(10_000);
    await m.onAlarm('recorder-watchdog');
    const meta = await getSession(ID);
    expect(meta?.status).toBe('recording');
    expect(meta?.audio.error).toBe('Chrome stopped the audio recording.');
    expect(await h.badgeTitle()).toMatch(/captions only/);
    expect(await getActiveRecording()).toMatchObject({ sessionId: ID, tabId });
    expect(h.notifications().map((n) => n.title)).toEqual(['Recording captions only']);
  });

  it('also checks on caption batches, and trusts a recorder that still runs', async () => {
    await record();
    h.clock.advance(20_000);
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 19_000, 'Silence radio')] });
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/recorder-status')).toHaveLength(1);
    expect((await getSession(ID))?.audio.error).toBeUndefined();

    h.offscreen.recording.delete(ID); // the recorder is gone, the document is not
    h.clock.advance(5000);
    await m.onCaptions({ sessionId: ID, segments: [seg('c2', 'Bob', 24_000, 'Allô ?')] });
    await m.idle();
    expect((await getSession(ID))?.audio.error).toBe('Chrome stopped the audio recording.');
  });

  it('does not declare the recorder dead when its status cannot be read', async () => {
    await record();
    h.clock.advance(20_000);
    h.offscreen.recorderStatusError = 'busy aligning another meeting';
    await m.onAlarm('recorder-watchdog');
    expect((await getSession(ID))?.audio.error).toBeUndefined();
    expect(await h.badgeTitle()).not.toMatch(/captions only/);
  });
});

describe('starting', () => {
  it('stops the recorder that started when Stop arrives during the start', async () => {
    const tabId = await h.openMeetTab();
    const recorder = gateRecorderStart();
    const started = m.start(tabId);
    await recorder.reached;
    const stopped = m.toggle(tabId);
    recorder.release();
    await started;
    await stopped;

    expect(h.offscreen.recording.size).toBe(0);
    expect(await getActiveRecording()).toBeNull();
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'saved', startedAt: T0 + 150 });
    expect(h.icon()).toBe('idle');
    expect(await h.badge()).toBe('');
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
    expect(h.windowsCreated()).toEqual([]);
  });

  it('answers meet/joined with nothing until the recorder has set t = 0', async () => {
    const tabId = await h.openMeetTab();
    const recorder = gateRecorderStart();
    const started = m.start(tabId);
    await recorder.reached;
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE })).toBeNull();
    recorder.release();
    await started;
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt: T0 + 150 } }]);
    expect(await m.onMeetJoined(tabId, { meetCode: MEET_CODE })).toEqual({ sessionId: ID, startedAt: T0 + 150 });
  });

  it('pushes the state again when the page did not answer the first time', async () => {
    const tabId = await h.openMeetTab();
    let answered = false;
    h.hooks.onPush = () => {
      if (answered) return;
      answered = true;
      throw new Error('Tab push timed out');
    };
    await m.start(tabId);
    const state = { sessionId: ID, startedAt: T0 + 150 };
    expect(h.pushes).toEqual([
      { tabId, state },
      { tabId, state },
    ]);
    expect(h.executeScript).not.toHaveBeenCalled();
  });

  it('does not hang on a page that never answers', async () => {
    const tabId = await h.openMeetTab();
    h.hooks.onPush = () => new Promise<void>(() => undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const started = m.start(tabId);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await started).toEqual({ ok: true, sessionId: ID });
    } finally {
      vi.useRealTimers();
    }
    expect((await getSession(ID))?.status).toBe('recording');
  });

  it('injects the content script into a Meet tab opened before the install', async () => {
    const tabId = await h.openMeetTab(MEET_URL, { contentScript: false });
    await m.start(tabId);
    expect(h.executeScript).toHaveBeenCalledWith({ target: { tabId }, files: ['content-scripts/content.js'] });
    expect(h.pushes).toEqual([{ tabId, state: { sessionId: ID, startedAt: T0 + 150 } }]);
    expect((await getSession(ID))?.captionsError).toBeUndefined();
  });

  it('flags a recording whose tab cannot get a content script, until captions arrive', async () => {
    const tabId = await h.openMeetTab(MEET_URL, { contentScript: false });
    h.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    await m.start(tabId);
    expect((await getSession(ID))?.status).toBe('recording');
    expect((await getSession(ID))?.captionsError).toMatch(/reload the Meet tab/i);

    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    expect((await getSession(ID))?.captionsError).toBeUndefined();
  });


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
    expect((await getSession(ID))?.endedAt).toBeDefined();
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('never reuses the id of an earlier session started in the same second', async () => {
    const tabId = await record();
    await m.stop(ID);
    const res = await m.start(tabId);
    expect(res.ok).toBe(true);
    const second = res.ok ? res.sessionId : '';
    expect(second).not.toBe(ID);
    expect(second).toBe(sessionId(MEET_CODE, T0 + 1000));
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
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
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');

    await m.remove(ID);
    expect(h.offscreen.callsOf('offscreen/audio-delete')).toEqual([{ sessionId: ID }]);
    expect(await getSession(ID)).toBeNull();
    expect(await loadCaptions(ID)).toEqual([]);
    expect(await getResult(ID)).toBeNull();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({ settings: expect.anything() });
  });

  it('stops a recording before deleting it, without transcribing it', async () => {
    const tabId = await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await m.remove(ID);

    expect(h.offscreen.callsOf('offscreen/recorder-stop')).toEqual([{ sessionId: ID }]);
    expect(await getActiveRecording()).toBeNull();
    await m.idle();
    expect(h.icon()).toBe('idle');
    expect(await h.badge()).toBe('');
    expect(h.pushes.at(-1)).toEqual({ tabId, state: null });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    expect(await getSession(ID)).toBeNull();

    // Late messages for the deleted session do not bring it back.
    await m.onCaptions({ sessionId: ID, segments: [seg('c2', 'Bob', 10, 'Late')] });
    await m.onRecorderStopped({ sessionId: ID, reason: 'requested', chunkCount: 1, bytes: 10 });
    await m.onTabRemoved(tabId);
    expect(await fakeBrowser.storage.local.get(null)).toEqual({ settings: expect.anything() });
  });

  it('drops caption batches that arrive while the session is being deleted', async () => {
    await configure({ autoTranscribe: false });
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

  it('keeps a recording whose recorder cannot be stopped', async () => {
    const tabId = await record();
    h.offscreen.recorderStopError = 'Recorder stop timed out';
    await expect(m.remove(ID)).rejects.toThrow('Couldn’t stop the recording, so it wasn’t deleted. Try again.');
    expect((await getSession(ID))?.status).toBe('recording');
    expect(await getActiveRecording()).toMatchObject({ sessionId: ID, tabId });
    expect(h.offscreen.recording.has(ID)).toBe(true);
  });

  it('keeps the session when its audio cannot be deleted', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    h.offscreen.audioDeleteError = 'OPFS unavailable';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The raw reason is for the console; Meetings shows words, next to the Delete used.
    await expect(m.remove(ID)).rejects.toThrow('Chrome didn’t respond. Try again.');
    expect(warn).toHaveBeenCalledWith('[manet] Could not delete:', expect.stringContaining('OPFS unavailable'));
    expect(await getSession(ID)).not.toBeNull();
  });
});

describe('what a page hears when a request can’t be carried out', () => {
  /** Words the direction keeps out of the UI (copyVoice › Glossary), and Chrome's "options". */
  const JARGON = /\b(session|route|job|stage|pipeline|opfs|offscreen|duplicate|force|options)\b/i;

  /** The reason `request` failed with, checked against the glossary and the house style. */
  async function reason(request: Promise<unknown>): Promise<string> {
    const err = await request.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toMatch(JARGON);
    expect(message).not.toMatch(/'/);
    expect(message).toMatch(/^[A-Z].*\.$/);
    return message;
  }

  it('says what state the meeting is in and what to do next', async () => {
    await configure({ autoTranscribe: false });
    expect(await reason(m.setProfile('abc-defg-hij_20260101T000000Z', 'team'))).toBe('This meeting was deleted.');
    expect(await reason(m.transcribe('abc-defg-hij_20260101T000000Z'))).toBe('This meeting was deleted.');
    expect(await reason(m.save('abc-defg-hij_20260101T000000Z'))).toBe('This meeting was deleted.');

    const tabId = await record();
    expect(await reason(m.transcribe(ID))).toBe('Stop recording first, then transcribe it.');
    expect(await reason(m.save(ID))).toBe('Stop recording first, then transcribe it.');

    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    expect(await reason(m.save(ID))).toBe('Transcribe this meeting first, then save it.');

    await m.transcribe(ID);
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
    expect(await reason(m.setProfile(ID, 'personal'))).toBe('This meeting is already in Notion.');
    expect(await reason(m.transcribe(ID))).toBe('This meeting is already in Notion.');
    expect(await reason(m.save(ID))).toBe('This meeting is already in Notion.');
  });

  it('keeps what Chrome said for the console', async () => {
    await configure({ autoTranscribe: false });
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fakeBrowser.alarms, 'clear').mockRejectedValue(new Error('Invalid alarm name'));
    expect(await reason(m.transcribe(ID))).toBe('Chrome didn’t respond. Try again.');
    expect(warn).toHaveBeenCalledWith('[manet] Could not transcribe:', 'Invalid alarm name');
  });

  it('flags a tab without captions in the product’s name, with the fix', async () => {
    const tabId = await h.openMeetTab(MEET_URL, { contentScript: false });
    h.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    await m.start(tabId);
    expect((await getSession(ID))?.captionsError).toBe(
      'Manet Meetings can’t read this tab’s captions. Reload the Meet tab to capture who said what.',
    );
  });
});
