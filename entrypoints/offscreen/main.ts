/**
 * Offscreen document: records Meet tabs and runs pipeline jobs, which the service
 * worker cannot do (no MediaStream, and it may be stopped mid-job). It only has
 * chrome.runtime, so settings, captions and session meta arrive inside the messages.
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

// Required: a message without a handler is a type error here, not a hang at runtime.
const handlers: Required<Handlers<OffscreenProtocol>> = {
  'offscreen/recorder-start': (req) => capture.start(req),
  'offscreen/recorder-stop': ({ sessionId }) => capture.stop(sessionId),
  'offscreen/recorder-status': () => ({ recordingSessionIds: capture.sessionIds() }),
  'offscreen/process': (job) => processSession(job, pipelineDeps(job.meta.id, job.settings)),
  'offscreen/save': (job) => saveSession(job, pipelineDeps(job.meta.id, job.settings)),
  'offscreen/audio-scan': () => capture.scanAudio(),
  'offscreen/audio-delete': ({ sessionId }) => capture.deleteAudio(sessionId),
};

handleMessages<OffscreenProtocol>('offscreen', handlers);
