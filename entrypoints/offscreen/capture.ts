/**
 * The offscreen document's recordings, one per session: tab (+ mic) capture → mixer →
 * recorder → chunks in OPFS. Streams come from injected openers so tests can feed
 * synthetic audio; main.ts passes openTabStream and openMicIfGranted.
 */
import type { OffscreenProtocol, RecorderStartResult } from '@lib/messages';
import type { AudioSessionInfo, AudioStore } from '@lib/types';
import { createMixer, type Mixer } from './mixer';
import { startRecording, type Recording, type RecordingStats, type RecordingStopped } from './recorder';

export type RecorderStartRequest = OffscreenProtocol['offscreen/recorder-start']['req'];

export interface CaptureDeps {
  store: AudioStore;
  openTabStream(streamId: string): Promise<MediaStream>;
  /** Null when the mic may not or cannot be used; the recording then has tab audio only. */
  openMicStream(): Promise<MediaStream | null>;
  /** Heartbeat after each persisted chunk. `bytes` is the session's total so far. */
  onChunk(chunk: { sessionId: string; index: number; bytes: number }): void;
  /** Once per started recording, whatever stopped it, after its last chunk is persisted. */
  onStopped(stopped: { sessionId: string } & RecordingStopped): void;
}

export interface CaptureHost {
  /** Idempotent per session: a second start returns the first one's result. */
  start(req: RecorderStartRequest): Promise<RecorderStartResult>;
  /**
   * Stops the session's recording and returns what was persisted. For a session that
   * is not recording here (already ended, or recorded before a restart), returns what
   * is on disk.
   */
  stop(sessionId: string): Promise<RecordingStats>;
  /** Sessions recording or starting. */
  sessionIds(): string[];
  isRecording(sessionId: string): boolean;
  scanAudio(): Promise<AudioSessionInfo[]>;
  /** Rejects while the session is recording. */
  deleteAudio(sessionId: string): Promise<void>;
}

interface Active {
  recording: Recording;
  micIncluded: boolean;
}

/** How long a suspended AudioContext gets to resume before the start fails. */
const RESUME_TIMEOUT_MS = 2000;

export function createCaptureHost(deps: CaptureDeps): CaptureHost {
  const active = new Map<string, Active>();
  const starting = new Map<string, Promise<RecorderStartResult>>();

  async function open(req: RecorderStartRequest): Promise<RecorderStartResult> {
    const { sessionId } = req;
    const streams: MediaStream[] = [];
    let mixer: Mixer | null = null;
    const release = () => {
      // Stopping the capture track is what un-mutes the tab.
      for (const s of streams) for (const t of s.getTracks()) t.stop();
      void mixer?.close();
    };

    let tab: MediaStream;
    try {
      tab = await deps.openTabStream(req.streamId);
    } catch (err) {
      return { ok: false, error: `Tab audio capture failed: ${messageOf(err)}` };
    }
    streams.push(tab);

    try {
      const mic = req.includeMic ? await deps.openMicStream() : null;
      if (mic) streams.push(mic);
      mixer = createMixer({ tabStream: tab, micStream: mic });
      await ensureRunning(mixer.context);
      const recording = await startRecording({
        sessionId,
        stream: mixer.stream,
        store: deps.store,
        timesliceMs: req.timesliceMs,
        endOnTracks: tab.getAudioTracks(),
        onChunk: (c) => deps.onChunk({ sessionId, index: c.index, bytes: c.bytes }),
        onStop: (stopped) => {
          active.delete(sessionId);
          release();
          deps.onStopped({ sessionId, ...stopped });
        },
      });
      const entry: Active = { recording, micIncluded: mic !== null };
      active.set(sessionId, entry);
      return startResult(entry);
    } catch (err) {
      release();
      return { ok: false, error: `Recording could not start: ${messageOf(err)}` };
    }
  }

  return {
    start(req) {
      const running = active.get(req.sessionId);
      if (running) return Promise.resolve(startResult(running));
      let pending = starting.get(req.sessionId);
      if (!pending) {
        pending = open(req).finally(() => starting.delete(req.sessionId));
        starting.set(req.sessionId, pending);
      }
      return pending;
    },

    async stop(sessionId) {
      // Let a start in flight finish, so this stop is not lost.
      await starting.get(sessionId);
      const entry = active.get(sessionId);
      if (!entry) return deps.store.stat(sessionId);
      const { chunkCount, bytes } = await entry.recording.stop();
      return { chunkCount, bytes };
    },

    sessionIds: () => [...new Set([...active.keys(), ...starting.keys()])],

    isRecording: (sessionId) => active.has(sessionId) || starting.has(sessionId),

    scanAudio: () => deps.store.list(),

    async deleteAudio(sessionId) {
      if (active.has(sessionId) || starting.has(sessionId)) {
        throw new Error(`Session ${sessionId} is still recording; stop it before deleting its audio`);
      }
      await deps.store.delete(sessionId);
    },
  };
}

function startResult({ recording, micIncluded }: Active): RecorderStartResult {
  return { ok: true, startedAt: recording.startedAt, micIncluded, mimeType: recording.mimeType };
}

/**
 * A suspended context would leave the tab silent for the user (capture mutes it) and
 * the recording empty, so it is a start failure rather than a quiet one.
 */
async function ensureRunning(context: AudioContext): Promise<void> {
  if (context.state !== 'running') {
    await Promise.race([context.resume(), new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
  }
  if (context.state !== 'running') throw new Error(`Audio context is ${context.state}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The tab's audio for a stream id from chrome.tabCapture.getMediaStreamId. */
export async function openTabStream(streamId: string): Promise<MediaStream> {
  // Chrome's legacy `mandatory` constraints are the only way to consume a tabCapture id.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * The mic, only if the user already granted it on the permission page. Asking from the
 * offscreen document would fail (it cannot show a prompt), so anything short of
 * 'granted' means tab audio only.
 */
export async function openMicIfGranted(): Promise<MediaStream | null> {
  try {
    const { state } = await navigator.permissions.query({ name: 'microphone' });
    if (state !== 'granted') return null;
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    console.warn('[manet] microphone unavailable, recording tab audio only', err);
    return null;
  }
}
