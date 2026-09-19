/**
 * MediaRecorder → AudioStore. Each timeslice is written as its own chunk the moment it
 * is produced, so a tab that closes or a browser that crashes mid-meeting loses at most
 * the slice in flight.
 */
import type { AudioStore } from '@lib/types';

export const RECORDING_MIME_TYPE = 'audio/webm;codecs=opus';
/** Plenty for speech; about 14 MB per hour. */
export const RECORDING_BITS_PER_SECOND = 32_000;

export type StopReason = 'requested' | 'track-ended' | 'error';

export interface RecordingStats {
  /** Chunks persisted so far. */
  chunkCount: number;
  /** Bytes persisted so far. */
  bytes: number;
}

/** A chunk that was just persisted, with the running totals. */
export interface ChunkInfo extends RecordingStats {
  index: number;
  /** Bytes of this chunk. */
  size: number;
}

export interface RecordingStopped extends RecordingStats {
  reason: StopReason;
  error?: string;
}

export interface RecordingOptions {
  sessionId: string;
  stream: MediaStream;
  store: AudioStore;
  timesliceMs: number;
  /**
   * Tracks whose 'ended' event stops the recording. Pass the tab capture track when
   * recording a mix of it: the mix itself never ends. Defaults to the stream's tracks.
   */
  endOnTracks?: MediaStreamTrack[];
  onChunk?: (chunk: ChunkInfo) => void;
  /** Called once, after the last chunk is persisted, whatever stopped the recording. */
  onStop?: (stopped: RecordingStopped) => void;
}

export interface Recording {
  sessionId: string;
  /** Epoch ms when MediaRecorder started: t = 0 of the recording. */
  startedAt: number;
  mimeType: string;
  stats(): RecordingStats;
  /** Stops if still running; resolves once the final chunk is persisted. Idempotent. */
  stop(): Promise<RecordingStopped>;
}

/** Starts recording `stream` into `store`. Resolves once MediaRecorder has started. */
export async function startRecording(opts: RecordingOptions): Promise<Recording> {
  const { sessionId, stream, store, timesliceMs } = opts;
  if (!Number.isFinite(timesliceMs) || timesliceMs <= 0) throw new RangeError(`Invalid timeslice: ${timesliceMs}`);
  const endOnTracks = opts.endOnTracks ?? stream.getTracks();
  if (endOnTracks.some((t) => t.readyState === 'ended')) throw new Error('The audio track has already ended');

  const recorder = new MediaRecorder(stream, {
    mimeType: RECORDING_MIME_TYPE,
    audioBitsPerSecond: RECORDING_BITS_PER_SECOND,
  });
  const stats: RecordingStats = { chunkCount: 0, bytes: 0 };
  let nextIndex = 0;
  let writes = Promise.resolve();
  let writeFailed = false;
  let started = false;
  let stopReason: StopReason | null = null;
  let stopError: string | undefined;
  let resolveStopped!: (stopped: RecordingStopped) => void;
  const stopped = new Promise<RecordingStopped>((r) => (resolveStopped = r));

  function requestStop(reason: StopReason, error?: string): void {
    if (stopReason === null) {
      stopReason = reason;
      stopError = error;
    }
    // After an error the recorder is already inactive and fires 'stop' by itself.
    if (recorder.state !== 'inactive') recorder.stop();
  }

  const onTrackEnded = () => requestStop('track-ended');
  const detachTracks = () => {
    for (const t of endOnTracks) t.removeEventListener('ended', onTrackEnded);
  };

  recorder.addEventListener('dataavailable', (e) => {
    // An empty blob can come with stop(); the store would not count it as a chunk anyway.
    if (e.data.size === 0) return;
    const index = nextIndex++;
    const data = e.data;
    writes = writes.then(async () => {
      // Writing past a lost chunk would leave a gap and shift every later timestamp.
      if (writeFailed) return;
      try {
        await store.writeChunk(sessionId, index, data);
      } catch (err) {
        writeFailed = true;
        requestStop('error', `Could not save audio chunk ${index}: ${describeError(err)}`);
        return;
      }
      stats.chunkCount = index + 1;
      stats.bytes += data.size;
      safely(() => opts.onChunk?.({ index, size: data.size, ...stats }));
    });
  });

  recorder.addEventListener('error', (e) => requestStop('error', `Recorder error: ${describeError(e.error)}`));

  recorder.addEventListener('stop', () => {
    detachTracks();
    // 'dataavailable' for the last slice fires before 'stop', so its write is queued.
    void writes.then(() => {
      // Stopping without a request means the recorded stream itself ended.
      const result: RecordingStopped = { reason: stopReason ?? 'track-ended', ...stats };
      if (stopError !== undefined) result.error = stopError;
      if (started) safely(() => opts.onStop?.(result));
      resolveStopped(result);
    });
  });

  for (const t of endOnTracks) t.addEventListener('ended', onTrackEnded);

  let startedAt: number;
  try {
    startedAt = await new Promise<number>((resolve, reject) => {
      const onStart = () => {
        cleanup();
        resolve(Date.now());
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        reject(new Error(`Recorder error: ${describeError(e.error)}`));
      };
      const cleanup = () => {
        recorder.removeEventListener('start', onStart);
        recorder.removeEventListener('error', onError);
      };
      recorder.addEventListener('start', onStart);
      recorder.addEventListener('error', onError);
      try {
        recorder.start(timesliceMs);
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  } catch (err) {
    detachTracks();
    if (recorder.state !== 'inactive') recorder.stop();
    throw err;
  }
  started = true;

  return {
    sessionId,
    startedAt,
    mimeType: recorder.mimeType || RECORDING_MIME_TYPE,
    stats: () => ({ ...stats }),
    stop() {
      requestStop('requested');
      return stopped;
    },
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** A throwing callback must not break the write chain. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[manet] recorder callback failed', err);
  }
}
