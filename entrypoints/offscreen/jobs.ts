/**
 * Pipeline jobs run fire-and-forget. A transcription can take far longer than Chrome
 * lets one service-worker request live, so the worker that asked may be gone by the
 * end: each outcome is sent as its own 'offscreen/job-done' message, which wakes
 * whichever worker instance is alive, and an outcome that cannot be delivered is kept
 * until a worker asks for the job status.
 */
import { errorMessage, type JobDone } from '@lib/messages';

export type JobKind = JobDone['kind'];
export type JobOutcome<K extends JobKind> = Extract<JobDone, { kind: K }>['outcome'];

export interface JobInfo {
  sessionId: string;
  jobId: string;
  kind: JobKind;
}

export interface JobRunnerOptions {
  /** Hands an outcome to the worker. Rejects when it did not get there (worker stopped or waking). */
  deliver(done: JobDone): Promise<void>;
  /** Pauses between delivery attempts. After the last one, the outcome waits for the next status(). */
  retryDelaysMs?: readonly number[];
}

export interface JobRunner {
  /**
   * Starts `work` and returns without waiting for it. Its outcome is delivered when it
   * settles; a throw becomes { status: 'error' }. Throws if another job of the session
   * is still running. The same job id again (a resent request) does not run twice.
   */
  start<K extends JobKind>(job: JobInfo & { kind: K }, work: () => Promise<JobOutcome<K>>): void;
  /**
   * Jobs still running, and finished ones whose outcome has not reached a worker yet, so
   * a restarted worker waits for them instead of resetting their sessions. The caller is
   * a live worker, so undelivered outcomes are sent again.
   */
  status(): JobInfo[];
}

/** Wakes a stopped worker within a second; the longer waits cover an update or a stuck boot. */
export const DELIVERY_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 10_000, 30_000];

const FAILED: Record<JobKind, string> = { process: 'Processing failed', save: 'Saving to Notion failed' };

interface Entry {
  info: JobInfo;
  done: JobDone | null;
  delivering: boolean;
}

export function createJobRunner(opts: JobRunnerOptions): JobRunner {
  const retryDelaysMs = opts.retryDelaysMs ?? DELIVERY_RETRY_DELAYS_MS;
  // One per session: a session runs one job at a time.
  const jobs = new Map<string, Entry>();
  const isCurrent = (entry: Entry) => jobs.get(entry.info.sessionId) === entry;

  async function deliver(entry: Entry): Promise<void> {
    const done = entry.done;
    if (!done || entry.delivering) return;
    entry.delivering = true;
    try {
      for (let attempt = 0; isCurrent(entry); attempt++) {
        try {
          await opts.deliver(done);
          if (isCurrent(entry)) jobs.delete(entry.info.sessionId);
          return;
        } catch (err) {
          const delay = retryDelaysMs[attempt];
          if (delay === undefined) {
            const reason = errorMessage(err);
            console.warn(`[manet] outcome of job ${done.jobId} not delivered, kept until a status request: ${reason}`);
            return;
          }
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      entry.delivering = false;
    }
  }

  async function run<K extends JobKind>(entry: Entry, work: () => Promise<JobOutcome<K>>): Promise<void> {
    let outcome: JobOutcome<JobKind>;
    try {
      outcome = await work();
    } catch (err) {
      outcome = { status: 'error', error: `${FAILED[entry.info.kind]}: ${errorMessage(err)}` };
    }
    entry.done = { ...entry.info, outcome } as JobDone;
    await deliver(entry);
  }

  return {
    start(job, work) {
      const { sessionId, jobId, kind } = job;
      const existing = jobs.get(sessionId);
      if (existing?.info.jobId === jobId) {
        void deliver(existing);
        return;
      }
      if (existing && !existing.done) {
        const { kind: running, jobId: runningId } = existing.info;
        throw new Error(`Session ${sessionId} already has a ${running} job running (${runningId}); wait for its outcome`);
      }
      // A finished job whose outcome never arrived is superseded: the worker moved on without it.
      const entry: Entry = { info: { sessionId, jobId, kind }, done: null, delivering: false };
      jobs.set(sessionId, entry);
      void run(entry, work);
    },

    status() {
      const list: JobInfo[] = [];
      for (const entry of jobs.values()) {
        list.push({ ...entry.info });
        // After the status reply has gone out.
        if (entry.done) setTimeout(() => void deliver(entry), 0);
      }
      return list;
    },
  };
}
