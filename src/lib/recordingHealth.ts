/**
 * What is wrong with a running recording, by one set of rules. The popup's Speakers and
 * Audio facts (popupView), the Meetings row (sessionView.recordingCautions), the toolbar's
 * "!" (background actionState) and the recorder watchdog (sessionManager) all read them
 * from here, so a problem one surface reports is never hidden on another. Only the words
 * differ per surface; the thresholds and conditions live nowhere else.
 *
 * Pure: the caller passes the clock. The input is the part of SessionMeta the rules read,
 * so a SessionMeta, or the popup's recording state, can be passed as it is.
 */
import type { SessionMeta, SpeakerInfo } from './types';

/** The recorder stores a chunk every 5 s (sessionManager starts it with this timeslice). */
export const AUDIO_CHUNK_MS = 5000;
/** Three chunks missing: audio has stalled, and the recorder watchdog checks the recorder. */
export const AUDIO_STALL_MS = 3 * AUDIO_CHUNK_MS;
/** Meet shows the first caption within seconds of speech; this long without one, CC is likely off. */
export const NO_CAPTIONS_AFTER_MS = 20_000;
/** No caption for this long: the popup says when the last one came (not a problem yet). */
export const CAPTIONS_QUIET_NOTE_MS = 2 * 60_000;
/** No caption for this long while people are named: captions were probably turned off. */
export const CAPTIONS_QUIET_WARN_MS = 5 * 60_000;

export type AudioProblem =
  /** The call audio is lost; only captions are recorded. `reason` is the recorder's error. */
  | { kind: 'lost'; reason: string }
  /** No chunk for `silentMs`, though the recorder was not declared dead. */
  | { kind: 'stalled'; silentMs: number };

export type CaptionsProblem =
  /** The tab can't deliver captions; `reason` says what to do. */
  | { kind: 'blocked'; reason: string }
  /** Nothing captioned 20 s into the recording: CC is probably off in Meet. */
  | { kind: 'none-yet' }
  /** Speakers were named, but no caption for `quietMs` (over 5 min). */
  | { kind: 'quiet'; quietMs: number };

export interface RecordingHealth {
  audio: AudioProblem | null;
  captions: CaptionsProblem | null;
  /**
   * Not a problem yet: speakers were named and the last caption came `quietMs` ago, over
   * 2 min and at most 5. Absent otherwise (and whenever `captions` is set).
   */
  captionsNote?: { quietMs: number };
}

/** What the rules read. SessionMeta satisfies it. */
export interface HealthInput {
  /** Recording start, epoch ms. */
  startedAt: number;
  audio: Pick<SessionMeta['audio'], 'error' | 'lastChunkAt'>;
  captionCount: number;
  speakers?: readonly Pick<SpeakerInfo, 'lastAt'>[] | undefined;
  captionsError?: string | undefined;
}

/** Both halves are checked on their own: a recording can lose audio and captions at once. */
export function recordingHealth(meta: HealthInput, now: number): RecordingHealth {
  const elapsed = now - meta.startedAt;

  let audio: AudioProblem | null = null;
  if (meta.audio.error) {
    audio = { kind: 'lost', reason: meta.audio.error };
  } else {
    const silent = now - (meta.audio.lastChunkAt ?? meta.startedAt);
    if (silent > AUDIO_STALL_MS) audio = { kind: 'stalled', silentMs: silent };
  }

  const health: RecordingHealth = { audio, captions: null };
  const speakers = meta.speakers ?? [];
  if (meta.captionsError) {
    health.captions = { kind: 'blocked', reason: meta.captionsError };
  } else if (speakers.length > 0) {
    // lastAt is ms since the start of the recording.
    const quiet = elapsed - Math.max(...speakers.map((s) => s.lastAt));
    if (quiet > CAPTIONS_QUIET_WARN_MS) health.captions = { kind: 'quiet', quietMs: quiet };
    else if (quiet > CAPTIONS_QUIET_NOTE_MS) health.captionsNote = { quietMs: quiet };
  } else if (meta.captionCount === 0 && elapsed >= NO_CAPTIONS_AFTER_MS) {
    health.captions = { kind: 'none-yet' };
  }
  return health;
}

/** "3 min", "1 h 12 min". Floors, so "6 min" only shows once six full minutes passed. */
export function minutesText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/** "20 s" in 5 s steps under a minute (the line changes calmly), then minutes. */
export function silenceText(ms: number): string {
  if (ms >= 60_000) return minutesText(ms);
  return `${Math.floor(ms / 5000) * 5} s`;
}
