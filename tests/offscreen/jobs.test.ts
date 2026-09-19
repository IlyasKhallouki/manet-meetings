/**
 * The job runner behind 'offscreen/process' and 'offscreen/save', delivering outcomes
 * with the real sendToBackground over WXT's fake chrome.runtime. Jobs are plain promises
 * the test settles, so each case can end a job exactly while no worker is listening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleMessages, sendToBackground, type BackgroundProtocol, type JobDone } from '@lib/messages';
import type { ProcessOutcome, SaveOutcome } from '@lib/types';
import { createJobRunner, type JobRunner } from '../../entrypoints/offscreen/jobs';

type Background = { [K in keyof BackgroundProtocol]: BackgroundProtocol[K] };

const A = 'abc-defg-hij_20260919T101500Z';
const B = 'xyz-abcd-efg_20260919T111500Z';

const RETRY_MS = 40;
const received: JobDone[] = [];
let stopWorker: (() => void) | null = null;

function startWorker(): void {
  stopWorker?.();
  stopWorker = handleMessages<Background>('background', {
    'offscreen/job-done': (d) => {
      received.push(d);
    },
  });
}

function killWorker(): void {
  stopWorker?.();
  stopWorker = null;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let attempts = 0;
function runner(retryDelaysMs: number[] = [RETRY_MS, RETRY_MS]): JobRunner {
  return createJobRunner({
    deliver: (done) => {
      attempts++;
      return sendToBackground('offscreen/job-done', done);
    },
    retryDelaysMs,
  });
}

const failed: ProcessOutcome = { status: 'error', error: 'Processing failed: boom' };
const created: SaveOutcome = { status: 'created', pageId: 'page-1', url: 'https://www.notion.so/page-1' };

beforeEach(() => {
  fakeBrowser.reset();
  received.length = 0;
  attempts = 0;
  startWorker();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  killWorker();
  vi.restoreAllMocks();
});

describe('createJobRunner', () => {
  it('returns before the job ends, lists it while it runs, and delivers its outcome once', async () => {
    const jobs = runner();
    const work = deferred<SaveOutcome>();
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'save' }, () => work.promise);
    expect(jobs.status()).toEqual([{ sessionId: A, jobId: 'j1', kind: 'save' }]);

    work.resolve(created);
    await vi.waitFor(() => expect(received).toEqual([{ sessionId: A, jobId: 'j1', kind: 'save', outcome: created }]));
    expect(jobs.status()).toEqual([]);
    await sleep(RETRY_MS * 3);
    expect(received).toHaveLength(1);
  });

  it('turns a job that throws, even before its first await, into an error outcome', async () => {
    const jobs = runner();
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'process' }, () => {
      throw new Error('no settings');
    });
    jobs.start({ sessionId: B, jobId: 'j2', kind: 'save' }, () => Promise.reject(new Error('offline')));
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toContainEqual({
      sessionId: A,
      jobId: 'j1',
      kind: 'process',
      outcome: { status: 'error', error: 'Processing failed: no settings' },
    });
    expect(received).toContainEqual({
      sessionId: B,
      jobId: 'j2',
      kind: 'save',
      outcome: { status: 'error', error: 'Saving to Notion failed: offline' },
    });
  });

  it('refuses a second job for a busy session, runs other sessions side by side, and ignores a resent job', () => {
    const jobs = runner();
    const work = vi.fn(() => new Promise<ProcessOutcome>(() => undefined));
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'process' }, work);
    expect(() => jobs.start({ sessionId: A, jobId: 'j2', kind: 'process' }, work)).toThrow(
      `Session ${A} already has a process job running (j1)`,
    );
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'process' }, work);
    jobs.start({ sessionId: B, jobId: 'j3', kind: 'process' }, work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(jobs.status()).toEqual([
      { sessionId: A, jobId: 'j1', kind: 'process' },
      { sessionId: B, jobId: 'j3', kind: 'process' },
    ]);
  });

  it('keeps retrying while the worker is down and delivers to the worker that comes back', async () => {
    const jobs = runner([RETRY_MS, RETRY_MS, 10 * RETRY_MS]);
    const work = deferred<ProcessOutcome>();
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'process' }, () => work.promise);
    killWorker();
    work.resolve(failed);
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(received).toEqual([]);
    // Still reported, so a restarted worker waits for it instead of resetting the session.
    expect(jobs.status()).toEqual([{ sessionId: A, jobId: 'j1', kind: 'process' }]);

    startWorker();
    await vi.waitFor(() => expect(received).toEqual([{ sessionId: A, jobId: 'j1', kind: 'process', outcome: failed }]));
    expect(jobs.status()).toEqual([]);
  });

  it('keeps an outcome no worker took and sends it again when a worker asks for the status', async () => {
    const jobs = runner();
    killWorker();
    jobs.start({ sessionId: A, jobId: 'j1', kind: 'save' }, async () => created);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/job j1 not delivered/)));
    expect(attempts).toBe(3);
    await sleep(RETRY_MS * 3);
    expect(attempts).toBe(3);

    startWorker();
    expect(jobs.status()).toEqual([{ sessionId: A, jobId: 'j1', kind: 'save' }]);
    await vi.waitFor(() => expect(received).toEqual([{ sessionId: A, jobId: 'j1', kind: 'save', outcome: created }]));
    expect(jobs.status()).toEqual([]);
  });

  it('drops an undelivered outcome once a new job for the session starts', async () => {
    const jobs = runner();
    killWorker();
    jobs.start({ sessionId: A, jobId: 'old', kind: 'process' }, async () => failed);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());

    startWorker();
    const work = deferred<ProcessOutcome>();
    jobs.start({ sessionId: A, jobId: 'new', kind: 'process' }, () => work.promise);
    expect(jobs.status()).toEqual([{ sessionId: A, jobId: 'new', kind: 'process' }]);
    work.resolve(failed);
    await vi.waitFor(() => expect(received.map((d) => d.jobId)).toEqual(['new']));
    await sleep(RETRY_MS * 3);
    expect(received.map((d) => d.jobId)).toEqual(['new']);
  });
});
