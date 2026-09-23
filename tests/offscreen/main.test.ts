/**
 * The offscreen entry script over WXT's fake chrome.runtime and the real messages.ts.
 * Node has no getUserMedia and no OPFS, so capture fails cleanly and the pipeline runs
 * captions-only: what is checked is that each message reaches the right code and that
 * progress and job outcomes flow back to the background. Recording itself is covered in
 * real Chrome by the *.browser.test.ts files next to this one.
 *
 * Notion and Gemini are called for real with deliberately invalid credentials.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleMessages, sendToOffscreen, type BackgroundProtocol, type JobDone } from '@lib/messages';
import { DEFAULT_SETTINGS } from '@lib/settings';
import type { CaptionSegment, JobStage, SessionMeta, Settings } from '@lib/types';
import { testProfile } from '../helpers/meeting';

type Background = { [K in keyof BackgroundProtocol]: BackgroundProtocol[K] };

const SESSION = 'abc-defg-hij_20260919T101500Z';

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  geminiApiKey: 'invalid-gemini-key',
  notionToken: 'ntn_invalid_token_for_tests',
  notionTeamDbId: '0123456789abcdef0123456789abcdef',
  displayName: 'Ilyas',
};

const profile = testProfile({ databaseId: settings.notionTeamDbId });

const meta: SessionMeta = {
  id: SESSION,
  meetCode: 'abc-defg-hij',
  startedAt: Date.UTC(2026, 8, 19, 10, 15),
  durationMs: 60_000,
  status: 'processing',
  route: 'team',
  profileId: 'team',
  idempotencyKey: 'abc-defg-hij-2026-09-19',
  audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 0, bytes: 0, micIncluded: false },
  captionCount: 1,
};

const captions: CaptionSegment[] = [
  {
    id: 'c1',
    speaker: 'Ana',
    self: false,
    text: 'On valide le planning pour vendredi.',
    tStart: 1000,
    tEnd: 4000,
    rev: 2,
  },
];

const progress: { sessionId: string; stage: JobStage }[] = [];
const done: JobDone[] = [];

/** The service worker's listener; stopping it is what a worker restart looks like here. */
let stopWorker: (() => void) | null = null;

function startWorker(): void {
  stopWorker?.();
  stopWorker = handleMessages<Background>('background', {
    'offscreen/job-progress': (p) => {
      progress.push(p);
    },
    'offscreen/job-done': (d) => {
      done.push(d);
    },
  });
}

async function outcomeOf(jobId: string): Promise<JobDone> {
  return vi.waitFor(
    () => {
      const d = done.find((x) => x.jobId === jobId);
      if (!d) throw new Error(`no outcome for ${jobId} yet`);
      return d;
    },
    { timeout: 20_000, interval: 50 },
  );
}

async function processed(jobId: string) {
  expect(await sendToOffscreen('offscreen/process', { jobId, meta, captions, settings, profile })).toEqual({
    accepted: true,
  });
  const d = await outcomeOf(jobId);
  if (d.kind !== 'process' || d.outcome.status !== 'processed') throw new Error(`process failed: ${JSON.stringify(d)}`);
  return d.outcome.result;
}

beforeAll(async () => {
  fakeBrowser.reset();
  startWorker();
  await import('@/entrypoints/offscreen/main');
});

beforeEach(() => {
  progress.length = 0;
  done.length = 0;
  startWorker();
});

afterEach(async () => {
  // A job left running would take the session for the next test.
  await vi.waitFor(async () => expect((await sendToOffscreen('offscreen/job-status', {})).jobs).toEqual([]), {
    timeout: 20_000,
  });
}, 25_000);

describe('offscreen document messaging', () => {
  it('reports no recordings before any start', async () => {
    expect(await sendToOffscreen('offscreen/recorder-status', {})).toEqual({ recordingSessionIds: [] });
  });

  it('answers a start it cannot honour with a failure, not a thrown error', async () => {
    const res = await sendToOffscreen('offscreen/recorder-start', {
      sessionId: SESSION,
      streamId: 'stream-1',
      timesliceMs: 5000,
      includeMic: true,
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^Tab audio capture failed: /) });
    expect(await sendToOffscreen('offscreen/recorder-status', {})).toEqual({ recordingSessionIds: [] });
  });
});

describe('offscreen jobs', () => {
  it('accepts a process job at once and sends its outcome as offscreen/job-done', async () => {
    const reply = await sendToOffscreen('offscreen/process', { jobId: 'p-1', meta, captions, settings, profile });
    expect(reply).toEqual({ accepted: true });
    // The reply does not wait for the job: Notion has not even answered yet.
    expect(done).toEqual([]);
    expect(await sendToOffscreen('offscreen/job-status', {})).toEqual({
      jobs: [{ sessionId: SESSION, jobId: 'p-1', kind: 'process' }],
    });

    const d = await outcomeOf('p-1');
    expect(d).toMatchObject({ sessionId: SESSION, jobId: 'p-1', kind: 'process', outcome: { status: 'processed' } });
    if (d.kind !== 'process' || d.outcome.status !== 'processed') return;
    // No audio can be read here, so the captions carry the meeting.
    expect(d.outcome.result.transcript.source).toBe('captions-only');
    expect(d.outcome.result.transcript.turns.map((t) => t.speaker)).toEqual(['Ana']);
    expect(progress).toContainEqual({ sessionId: SESSION, stage: 'checking-duplicate' });
    expect(progress).toContainEqual({ sessionId: SESSION, stage: 'loading-audio' });
    expect(progress.every((p) => p.sessionId === SESSION)).toBe(true);
    expect(done).toHaveLength(1);
    expect(await sendToOffscreen('offscreen/job-status', {})).toEqual({ jobs: [] });
  });

  it('accepts a save job and sends its outcome as offscreen/job-done', async () => {
    const result = await processed('p-2');
    progress.length = 0;

    const reply = await sendToOffscreen('offscreen/save', { jobId: 's-2', meta, result, settings, profile });
    expect(reply).toEqual({ accepted: true });
    // The token is invalid, so Notion refuses it; that still comes back as an outcome.
    expect(await outcomeOf('s-2')).toEqual({
      sessionId: SESSION,
      jobId: 's-2',
      kind: 'save',
      outcome: { status: 'error', error: expect.stringMatching(/\S/) },
    });
    expect(progress).toContainEqual({ sessionId: SESSION, stage: 'saving' });
  });

  it('delivers the outcome to whichever worker is alive when the job ends', async () => {
    // The worker that sent the job is stopped right after (Chrome's 5-minute cap, an update, a crash).
    const reply = sendToOffscreen('offscreen/process', { jobId: 'p-3', meta, captions, settings, profile });
    stopWorker?.();
    stopWorker = null;
    expect(await reply).toEqual({ accepted: true });

    // A new worker instance, woken later, still learns the outcome.
    await new Promise((r) => setTimeout(r, 300));
    startWorker();
    const d = await outcomeOf('p-3');
    expect(d).toMatchObject({ sessionId: SESSION, kind: 'process', outcome: { status: 'processed' } });
  });

  it('refuses a second job for a session whose job is still running', async () => {
    await sendToOffscreen('offscreen/process', { jobId: 'p-4', meta, captions, settings, profile });
    await expect(
      sendToOffscreen('offscreen/process', { jobId: 'p-5', meta, captions, settings, profile }),
    ).rejects.toThrow(`Session ${SESSION} already has a process job running (p-4)`);
    // The same job sent again (its reply was lost) is not run twice.
    const resent = await sendToOffscreen('offscreen/process', { jobId: 'p-4', meta, captions, settings, profile });
    expect(resent).toEqual({ accepted: true });
    await outcomeOf('p-4');
    await vi.waitFor(async () => expect((await sendToOffscreen('offscreen/job-status', {})).jobs).toEqual([]));
    expect(done.map((d) => d.jobId)).toEqual(['p-4']);
  });

  it('rejects a malformed job instead of accepting it', async () => {
    const bad = [
      { meta, captions, settings, profile },
      { jobId: '', meta, captions, settings, profile },
      { jobId: 'x', meta: { ...meta, id: undefined }, captions, settings, profile },
      { jobId: 'x', meta, captions: undefined, settings, profile },
      { jobId: 'x', meta, captions, settings: undefined, profile },
      { jobId: 'x', meta, captions, settings, profile: { id: 'team' } },
    ];
    for (const job of bad) {
      await expect(sendToOffscreen('offscreen/process', job as never)).rejects.toThrow(/^Invalid process job: /);
    }
    await expect(sendToOffscreen('offscreen/process', { jobId: 'x', meta, captions, settings } as never)).rejects.toThrow(
      'Invalid process job: profile is missing',
    );
    await expect(
      sendToOffscreen('offscreen/save', { jobId: 'x', meta, settings, profile } as never),
    ).rejects.toThrow(/^Invalid save job: result/);
    expect(await sendToOffscreen('offscreen/job-status', {})).toEqual({ jobs: [] });
  });
});
