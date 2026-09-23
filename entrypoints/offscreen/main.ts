/**
 * Offscreen document: records Meet tabs and runs pipeline jobs, which the service
 * worker cannot do (no MediaStream, and it may be stopped mid-job). It only has
 * chrome.runtime, so settings, captions and session meta arrive inside the messages.
 * Jobs are accepted at once and report back with 'offscreen/job-done' (see jobs.ts).
 */
import {
  errorMessage,
  handleMessages,
  sendToBackground,
  type BackgroundProtocol,
  type Handlers,
  type OffscreenProtocol,
} from '@lib/messages';
import { createPipelineDeps, processSession, saveSession, type PipelineDeps } from '@lib/pipeline';
import { createOpfsAudioStore } from '@lib/storage/opfsAudioStore';
import type { Settings } from '@lib/types';
import { createCaptureHost, openMicIfGranted, openTabStream } from './capture';
import { createJobRunner, type JobKind } from './jobs';

const store = createOpfsAudioStore();

/** Fire and forget: an undelivered notice must never disturb a recording or a job. */
function notify<K extends keyof BackgroundProtocol & string>(type: K, payload: BackgroundProtocol[K]['req']): void {
  sendToBackground(type, payload).catch((err: unknown) => {
    console.warn(`[manet] ${type} not delivered: ${errorMessage(err)}`);
  });
}

const capture = createCaptureHost({
  store,
  openTabStream,
  openMicStream: openMicIfGranted,
  onChunk: (chunk) => notify('offscreen/recorder-chunk', chunk),
  onStopped: (stopped) => notify('offscreen/recorder-stopped', stopped),
});

function pipelineDeps(sessionId: string, settings: Settings): PipelineDeps {
  return createPipelineDeps(settings, store, (stage) => notify('offscreen/job-progress', { sessionId, stage }));
}

const jobs = createJobRunner({ deliver: (done) => sendToBackground('offscreen/job-done', done) });

/**
 * A malformed job fails its request, while the worker is still waiting on the reply,
 * instead of an outcome that may never find it.
 */
function checkJob(kind: JobKind, req: object, field: 'captions' | 'result'): void {
  const job = req as Record<string, unknown>;
  const problem = (what: string) => new Error(`Invalid ${kind} job: ${what}`);
  if (typeof job.jobId !== 'string' || job.jobId === '') throw problem('jobId must be a non-empty string');
  const meta = job.meta as { id?: unknown } | undefined;
  if (typeof meta !== 'object' || meta === null || typeof meta.id !== 'string') throw problem('meta.id is missing');
  if (typeof job.settings !== 'object' || job.settings === null) throw problem('settings are missing');
  const profile = job.profile as { id?: unknown; databaseId?: unknown; sections?: unknown } | undefined;
  if (typeof profile !== 'object' || profile === null || typeof profile.id !== 'string') throw problem('profile is missing');
  if (typeof profile.databaseId !== 'string' || !Array.isArray(profile.sections)) throw problem('profile is incomplete');
  const value = job[field];
  const ok = field === 'captions' ? Array.isArray(value) : typeof value === 'object' && value !== null;
  if (!ok) throw problem(`${field} ${field === 'captions' ? 'must be an array' : 'is missing'}`);
}

// Required: a message without a handler is a type error here, not a hang at runtime.
const handlers: Required<Handlers<OffscreenProtocol>> = {
  'offscreen/recorder-start': (req) => capture.start(req),
  'offscreen/recorder-stop': ({ sessionId }) => capture.stop(sessionId),
  'offscreen/recorder-status': () => ({ recordingSessionIds: capture.sessionIds() }),
  'offscreen/process': (req) => {
    checkJob('process', req, 'captions');
    const { jobId, ...job } = req;
    const sessionId = job.meta.id;
    jobs.start({ sessionId, jobId, kind: 'process' }, async () =>
      processSession(job, pipelineDeps(sessionId, job.settings)),
    );
    return { accepted: true };
  },
  'offscreen/save': (req) => {
    checkJob('save', req, 'result');
    const { jobId, ...job } = req;
    const sessionId = job.meta.id;
    jobs.start({ sessionId, jobId, kind: 'save' }, async () => saveSession(job, pipelineDeps(sessionId, job.settings)));
    return { accepted: true };
  },
  'offscreen/job-status': () => ({ jobs: jobs.status() }),
  'offscreen/audio-scan': () => capture.scanAudio(),
  'offscreen/audio-delete': ({ sessionId }) => capture.deleteAudio(sessionId),
};

handleMessages<OffscreenProtocol>('offscreen', handlers);
