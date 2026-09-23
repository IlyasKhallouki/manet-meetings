import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getResult } from '@lib/storage/resultStore';
import { getSession } from '@lib/storage/sessionStore';
import type { ProcessJob, SessionResult } from '@lib/types';
import { errorText } from '@lib/ui/sessionView';
import { sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import {
  clockTime,
  configure,
  DAY,
  deferred,
  MEET_CODE,
  resultFor,
  seg,
  setupHarness,
  T0,
  type Harness,
} from './harness';

const ID = sessionId(MEET_CODE, T0);
const MINUTE = 60_000;

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  await configure();
  m = h.createManager();
  await m.boot();
});

/** Records a meeting with one caption for the default profile (Team) and ends it. */
async function recordMeeting(): Promise<void> {
  const tabId = await h.openMeetTab();
  await m.start(tabId);
  await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Alice', 0, 'Salut')] });
  await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
  await m.idle();
}

function processed(job: ProcessJob, patch: Partial<SessionResult> = {}) {
  return { status: 'processed' as const, result: { ...resultFor(job, h.clock.now()), ...patch } };
}

const CAPTIONS_ONLY: Partial<SessionResult> = {
  transcript: { turns: [{ speaker: 'Alice', start: 0, end: 2000, text: 'Salut' }], source: 'captions-only', notes: [] },
  transcription: {
    timingPass: { ok: false, error: 'Gemini quota exceeded' },
    textPass: { ok: false, error: 'Gemini quota exceeded' },
  },
};

describe('jobs run in the offscreen document and report back', () => {
  it('keeps a job that outlives the worker, and takes its report in the next worker', async () => {
    await configure({ autoTranscribe: false });
    const gate = deferred();
    const inner = h.offscreen.process;
    h.offscreen.process = async (job) => {
      await gate.promise;
      return inner(job);
    };
    await recordMeeting();
    await m.transcribe(ID);
    expect((await getSession(ID))?.status).toBe('processing');

    // Chrome replaces the worker mid-job (e.g. its 5-minute cap); the document keeps going.
    await fakeBrowser.storage.session.set({ bootScanned: true });
    const next = h.createManager();
    await next.boot();
    expect((await getSession(ID))?.status).toBe('processing');

    gate.resolve();
    await next.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'saved', notion: { pageId: 'page-1' } });
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
  });

  it('ignores a report for a job that is not the session’s current one', async () => {
    await configure({ autoTranscribe: false });
    await recordMeeting();
    const before = await getSession(ID);
    await m.onJobDone({
      sessionId: ID,
      jobId: 'someone-else',
      kind: 'save',
      outcome: { status: 'created', pageId: 'p0', url: 'https://www.notion.so/p0' },
    });
    expect(await getSession(ID)).toEqual(before);
  });

  it('fails the session when the offscreen document cannot take the job', async () => {
    await configure({ autoTranscribe: false });
    await recordMeeting();
    h.offscreen.close();
    h.createDocument.mockRejectedValueOnce(new Error('offscreen blocked'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await m.transcribe(ID);
    const meta = await getSession(ID);
    // Chrome's words go to the console; the meeting says what didn't happen and what to do.
    expect(meta).toMatchObject({ status: 'failed', error: 'Transcribing didn’t start. Try again.' });
    expect(meta?.job).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/process job/), expect.stringContaining('offscreen blocked'));
  });
});

describe('transient Gemini failures', () => {
  it('retries later, twice, instead of filing a degraded transcript', async () => {
    // Chrome replaces a notification that reuses its id, so keep every one shown.
    const notified: { title: string; message: string }[] = [];
    const create = fakeBrowser.notifications.create.bind(fakeBrowser.notifications);
    vi.spyOn(fakeBrowser.notifications, 'create').mockImplementation(((id: string, o: { title: string; message: string }) => {
      notified.push({ title: o.title, message: o.message });
      return create(id, o as never);
    }) as never);
    h.offscreen.process = () => ({ status: 'retry-later', error: 'Could not reach Gemini' });
    await recordMeeting();

    const first = h.clock.now() + 10 * MINUTE;
    let meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'failed', attempt: 1, retryAt: first });
    // No status code to give: no parenthesis. Meetings drops the suffix and shows the time on its own line.
    expect(meta?.error).toBe(`Gemini is unavailable right now. Retrying automatically at ${clockTime(first)}.`);
    expect((await fakeBrowser.alarms.get(`retry:${ID}`))?.scheduledTime).toBe(first);
    expect(h.offscreen.callsOf('offscreen/process').map((j) => j.attempt)).toEqual([1]);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);

    h.clock.set(first);
    await m.onAlarm(`retry:${ID}`);
    await m.idle();
    const second = h.clock.now() + 30 * MINUTE;
    meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'failed', attempt: 2, retryAt: second });
    expect(h.offscreen.callsOf('offscreen/process').map((j) => j.attempt)).toEqual([1, 2]);

    // The last attempt degrades inside the pipeline if Gemini is still away; here it is back.
    h.offscreen.process = (job) => processed(job);
    h.clock.set(second);
    await m.onAlarm(`retry:${ID}`);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process').map((j) => j.attempt)).toEqual([1, 2, 3]);
    meta = await getSession(ID);
    expect(meta?.status).toBe('saved');
    expect(meta?.retryAt).toBeUndefined();

    // One notification for the outage (the second retry only moved the time), then the outcome.
    expect(notified).toEqual([
      {
        title: `Couldn’t transcribe the ${clockTime(T0 + 150)} meeting`,
        message: `Gemini is unavailable right now. Trying again at ${clockTime(first)}.`,
      },
      // recordMeeting() takes no time, so the length is unknown and left out.
      { title: 'Saved to Notion', message: `Your ${clockTime(T0 + 150)} meeting is in Team.` },
    ]);
  });

  it('gives up after the last attempt and says so', async () => {
    h.offscreen.process = () => ({ status: 'retry-later', error: 'Could not reach Gemini' });
    await recordMeeting();
    for (let attempt = 2; attempt <= 3; attempt++) {
      h.clock.set((await getSession(ID))!.retryAt!);
      await m.onAlarm(`retry:${ID}`);
      await m.idle();
    }
    const meta = await getSession(ID);
    const gaveUp = 'Gemini is still unavailable after 3 tries. Try again later.';
    expect(meta).toMatchObject({ status: 'failed', attempt: 3, error: gaveUp });
    expect(meta?.retryAt).toBeUndefined();
    expect(h.notifications().at(-1)).toEqual({
      id: `manet:${ID}`,
      title: `Couldn’t transcribe the ${clockTime(T0 + 150)} meeting`,
      message: gaveUp,
    });
  });

  it('starts over at attempt 1 on a manual Transcribe, and drops the scheduled retry', async () => {
    h.offscreen.process = () => ({ status: 'retry-later', error: 'Could not reach Gemini' });
    await recordMeeting();
    h.offscreen.process = (job) => processed(job);

    await m.transcribe(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process').map((j) => j.attempt)).toEqual([1, 1]);
    expect(await fakeBrowser.alarms.get(`retry:${ID}`)).toBeUndefined();
    expect((await getSession(ID))?.status).toBe('saved');

    // A retry alarm that fires late finds nothing to do.
    await m.onAlarm(`retry:${ID}`);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(2);
  });
});

describe('duplicates', () => {
  it('keeps the audio of a meeting you already saved part of, and files it on "Transcribe anyway"', async () => {
    h.offscreen.process = (job) =>
      job.force
        ? processed(job)
        : { status: 'duplicate', existing: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: ' ilyas ' } };
    await recordMeeting();

    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'duplicate', notion: { pageId: 'p1', recordedBy: ' ilyas ' } });
    expect(meta?.purgeAudioAt).toBeUndefined();
    expect(h.notifications()).toEqual([
      {
        id: `manet:${ID}`,
        title: 'Already in Notion',
        message: `Part of the ${clockTime(T0 + 150)} meeting is already in Notion from your earlier recording. This one is kept in Meetings.`,
      },
    ]);

    // Its notification leads to the dashboard, where the recording can be saved.
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await m.onNotificationClicked(`manet:${ID}`);
    expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://test-extension-id/dashboard.html' });

    await m.transcribe(ID, { force: true });
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process').at(-1)?.force).toBe(true);
    // Without force the save would find the same page again.
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.force).toBe(true);
    expect(await getSession(ID)).toMatchObject({ status: 'saved', notion: { pageId: 'page-1', recordedBy: 'Ilyas' } });
  });

  it('files a duplicate found at save time with "Save anyway", without transcribing again', async () => {
    h.offscreen.save = (job) =>
      job.force
        ? { status: 'created', pageId: 'page-2', url: 'https://www.notion.so/page-2' }
        : { status: 'duplicate', existing: { pageId: 'p7', url: 'https://www.notion.so/p7', recordedBy: 'Bob' } };
    await recordMeeting();
    expect(await getSession(ID)).toMatchObject({ status: 'duplicate', purgeAudioAt: h.clock.now() + 7 * DAY });

    await m.save(ID, { force: true });
    await m.idle();
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'saved', notion: { pageId: 'page-2' } });
    expect(meta?.purgeAudioAt).toBe(h.clock.now() + 7 * DAY);
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
  });

  it('can transcribe a teammate duplicate anyway, and keeps its audio while it does', async () => {
    let calls = 0;
    h.offscreen.process = (job) =>
      calls++ === 0
        ? { status: 'duplicate', existing: { pageId: 'p9', url: 'https://www.notion.so/p9', recordedBy: 'Alice' } }
        : processed(job);
    await recordMeeting();
    expect((await getSession(ID))?.purgeAudioAt).toBeDefined();

    const gate = deferred();
    const inner = h.offscreen.process;
    h.offscreen.process = async (job) => {
      await gate.promise;
      return inner(job);
    };
    await m.transcribe(ID, { force: true });
    expect((await getSession(ID))?.purgeAudioAt).toBeUndefined();
    gate.resolve();
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
  });
});

describe('empty recordings', () => {
  it('does not file a recording with nothing in it', async () => {
    h.offscreen.process = (job) =>
      processed(job, { transcript: { turns: [], source: 'captions-only', notes: ['Nothing was captured'] } });
    await recordMeeting();

    const meta = await getSession(ID);
    expect(meta?.status).toBe('empty');
    expect(meta?.purgeAudioAt).toBe(h.clock.now() + 7 * DAY);
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(0);
    expect(h.notifications()).toEqual([
      {
        id: `manet:${ID}`,
        title: 'Nothing to save',
        message: `No speech or captions were captured in the ${clockTime(T0 + 150)} meeting.`,
      },
    ]);

    // It stays transcribable, e.g. after the audio turned out to hold something.
    h.offscreen.process = (job) => processed(job);
    await m.transcribe(ID);
    await m.idle();
    expect((await getSession(ID))?.status).toBe('saved');
  });
});

describe('transcribing again', () => {
  it('keeps an audio transcript when the new run could only produce captions', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion returned 502' });
    await recordMeeting();
    const good = await getResult(ID);
    expect(good?.transcript.source).toBe('audio+captions');

    h.offscreen.process = (job) => processed(job, CAPTIONS_ONLY);
    h.offscreen.save = () => ({ status: 'created', pageId: 'page-1', url: 'https://www.notion.so/page-1' });
    await m.transcribe(ID);
    await m.idle();

    expect(await getResult(ID)).toEqual(good);
    const meta = await getSession(ID);
    expect(meta?.status).toBe('failed');
    // The pass's raw error goes to the console; the meeting says what happened and what to do.
    expect(meta?.error).toBe('Transcribing again didn’t work, so the earlier transcript was kept. Save it, or try again later.');
    expect(h.offscreen.callsOf('offscreen/save')).toHaveLength(1);
  });

  it('takes a captions-only result when there was nothing better before', async () => {
    h.offscreen.process = (job) => processed(job, CAPTIONS_ONLY);
    await recordMeeting();
    expect((await getResult(ID))?.transcript.source).toBe('captions-only');
    expect((await getSession(ID))?.status).toBe('saved');
  });
});

describe('settings', () => {
  it('files the meeting without a Gemini key (the pipeline falls back to captions)', async () => {
    await configure({ geminiApiKey: '' });
    await recordMeeting();
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(1);
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('still needs Notion and a name to save', async () => {
    await configure({ geminiApiKey: '', notionToken: '', displayName: '' });
    await recordMeeting();
    const meta = await getSession(ID);
    expect(meta?.status).toBe('failed');
    expect(meta?.error).toMatch(/a Notion token/);
    expect(meta?.error).toMatch(/your name/);
    expect(meta?.error).not.toMatch(/Gemini/);
    expect(h.offscreen.callsOf('offscreen/process')).toHaveLength(0);
    // Meetings words the stored record itself; the notification says the same sentence.
    expect(errorText(meta!.error!)).toBe('Add your name and a Notion token in Settings, then try again.');
    expect(h.notifications()).toEqual([
      {
        id: `manet:${ID}`,
        title: `Couldn’t transcribe the ${clockTime(T0 + 150)} meeting`,
        message: 'Add your name and a Notion token in Settings, then try again.',
      },
    ]);
  });

  it('names the save, not the transcription, when saving is what the settings block', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion returned 502' });
    await recordMeeting();
    expect((await getSession(ID))?.status).toBe('failed');
    await configure({ notionToken: '' });
    await m.save(ID);
    const meta = await getSession(ID);
    expect(meta).toMatchObject({ status: 'failed', error: expect.stringMatching(/a Notion token/) });
    expect(h.notifications().at(-1)).toMatchObject({ title: `Couldn’t save the ${clockTime(T0 + 150)} meeting` });
  });
});
