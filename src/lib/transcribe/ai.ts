/**
 * MeetingAI backed by Gemini: two-pass transcription and structured summary.
 */
import { splitWebm, webmDurationMs } from '../audio/webm';
import type { RestOptions } from '../gemini/rest';
import type { JobStage, MeetingAI } from '../types';
import { TranscriptionError } from './stitch';
import { summarize as summarizeTranscript } from './summary';
import { transcribeParts, type AudioPart } from './transcribe';

export interface SplitLimits {
  /** Timing pass (word timestamps): the API caps these requests at 30 min. */
  timingMaxPartMs: number;
  /** Text pass (custom vocabulary): the API caps these requests at 60 min. */
  textMaxPartMs: number;
  overlapMs: number;
}

export const DEFAULT_SPLIT_LIMITS: SplitLimits = {
  timingMaxPartMs: 28 * 60_000,
  textMaxPartMs: 55 * 60_000,
  overlapMs: 30_000,
};

export interface GeminiMeetingAIOptions {
  limits?: Partial<SplitLimits>;
  /** Transcription requests in flight across both passes (default 3). */
  concurrency?: number;
  /** Called with every stage, in addition to TranscribeOptions.onProgress. */
  onProgress?: (stage: JobStage) => void;
  /** Transport overrides (fetch, baseUrl, retries, per-request timeout). */
  rest?: RestOptions;
}

export interface PartPlan {
  durationMs: number;
  timingParts: AudioPart[];
  textParts: AudioPart[];
}

/**
 * Parts for each pass. A pass whose limit fits the whole recording gets the
 * original Blob as its single part (the same object for both passes, so it is
 * uploaded once); longer recordings are cut with overlapping WebM parts.
 */
export async function planParts(audio: Blob, limits: SplitLimits, durationMs?: number): Promise<PartPlan> {
  let bytes: Uint8Array | undefined;
  const read = async () => (bytes ??= new Uint8Array(await audio.arrayBuffer()));
  const total = durationMs ?? webmDurationMs(await read());
  const whole: AudioPart = { data: audio, startMs: 0, endMs: total };
  const cut = async (maxPartMs: number): Promise<AudioPart[]> =>
    total <= maxPartMs ? [whole] : splitWebm(await read(), { maxPartMs, overlapMs: limits.overlapMs });
  return {
    durationMs: total,
    timingParts: await cut(limits.timingMaxPartMs),
    textParts: await cut(limits.textMaxPartMs),
  };
}

function withDefaults(overrides: Partial<SplitLimits> = {}): SplitLimits {
  const limits = { ...DEFAULT_SPLIT_LIMITS };
  for (const key of Object.keys(limits) as (keyof SplitLimits)[]) {
    const value = overrides[key];
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

export function createGeminiMeetingAI(apiKey: string, opts: GeminiMeetingAIOptions = {}): MeetingAI {
  const key = apiKey.trim();
  const limits = withDefaults(opts.limits);
  return {
    async transcribe(audio, t) {
      t.signal?.throwIfAborted();
      if (audio.size === 0) throw new TranscriptionError('no audio recorded', 'no audio recorded');
      const { timingParts, textParts } = await planParts(audio, limits, t.durationMs);
      return transcribeParts(key, timingParts, textParts, {
        mimeType: audio.type,
        customVocabulary: t.customVocabulary,
        languageCodes: t.languageCodes,
        onProgress: (stage) => {
          opts.onProgress?.(stage);
          t.onProgress?.(stage);
        },
        ...(t.signal ? { signal: t.signal } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        ...(opts.rest ? { rest: opts.rest } : {}),
      });
    },
    summarize(transcriptText, s) {
      return summarizeTranscript(key, transcriptText, s, opts.rest);
    },
  };
}
