/**
 * Runs both gemini-3.5-transcribe passes over pre-cut audio parts.
 *
 * Each distinct part is uploaded once and shared by the passes that need it (a
 * recording that fits one timing part is uploaded once for both). The passes run
 * side by side and independently: a failing pass cancels its own remaining
 * requests, never the other pass. Uploads are deleted at the end, best effort.
 */
import { createInteraction, deleteFile, uploadFile, type GeminiFile, type InteractionRequest, type RestOptions } from '../gemini/rest';
import { outputText, timedWords, type Interaction } from '../gemini/response';
import type { JobStage, TranscriptionResult } from '../types';
import { textPassRequest, timingPassRequest, type UploadedAudio } from './requests';
import { combinePasses, stitchTimingParts, type PartSpan, type PassResult, type TextPart, type TimedPart } from './stitch';

export interface AudioPart extends PartSpan {
  /** A standalone audio file whose time 0 is `startMs` in the recording. */
  data: Blob | Uint8Array;
}

export interface TranscribePartsOptions {
  /** MIME type of every part; codec parameters are stripped for the API. */
  mimeType: string;
  customVocabulary: readonly string[];
  languageCodes: readonly string[];
  signal?: AbortSignal;
  onProgress?: (stage: JobStage) => void;
  /** Transcription requests in flight across both passes. */
  concurrency?: number;
  /** Transport overrides (fetch, baseUrl, retries, per-request timeout). */
  rest?: RestOptions;
}

const DEFAULT_CONCURRENCY = 3;
const UPLOAD_CONCURRENCY = 2;

/** Returns a scheduler that runs at most `n` tasks at a time, in submission order. */
export function createLimiter(n: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const pump = () => {
    while (active < n && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
}

/** Same span and same size means the same bytes of the same recording. */
export function partKey(part: AudioPart): string {
  const size = part.data instanceof Blob ? part.data.size : part.data.byteLength;
  return `${part.startMs}:${part.endMs}:${size}`;
}

/** "audio/webm;codecs=opus" → "audio/webm" (the API's AudioContent enum). */
export function baseMimeType(type: string): string {
  return type.split(';')[0]?.trim().toLowerCase() || 'audio/webm';
}

export function toBlob(data: Blob | Uint8Array, mimeType: string): Blob {
  if (data instanceof Blob) return data;
  // A view over exactly these bytes, typed for the Blob constructor, without copying.
  return new Blob([new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength)], { type: mimeType });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runPass<T>(
  outer: AbortSignal | undefined,
  parts: readonly AudioPart[],
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<PassResult<T>> {
  if (parts.length === 0) return { ok: false, error: 'no audio to transcribe' };
  const ctrl = new AbortController();
  const signal = outer ? AbortSignal.any([outer, ctrl.signal]) : ctrl.signal;
  try {
    return { ok: true, value: await fn(signal) };
  } catch (err) {
    ctrl.abort(err);
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * Transcribes a recording given as timing-pass parts (≤ 30 min each, word
 * timestamps) and text-pass parts (≤ 60 min each, custom vocabulary). Parts of a
 * pass must cover the recording with overlaps; they may be the same objects.
 * Resolves with degraded results when one pass fails, throws a TranscriptionError
 * when both do, and rethrows the abort reason when `signal` aborts.
 */
export async function transcribeParts(
  apiKey: string,
  timingParts: readonly AudioPart[],
  textParts: readonly AudioPart[],
  opts: TranscribePartsOptions,
): Promise<TranscriptionResult> {
  const mimeType = baseMimeType(opts.mimeType);
  const { signal: _ignored, ...transport }: RestOptions = opts.rest ?? {};
  const rest: RestOptions = { ...transport, ...(opts.signal ? { signal: opts.signal } : {}) };
  const requestSlots = createLimiter(opts.concurrency ?? DEFAULT_CONCURRENCY);
  const uploadSlots = createLimiter(UPLOAD_CONCURRENCY);
  const uploads = new Map<string, Promise<GeminiFile>>();

  const upload = (part: AudioPart): Promise<GeminiFile> => {
    const key = partKey(part);
    let pending = uploads.get(key);
    if (!pending) {
      pending = uploadSlots(() =>
        uploadFile(apiKey, toBlob(part.data, mimeType), {
          ...rest,
          mimeType,
          displayName: `manet-${part.startMs}-${part.endMs}`,
        }),
      );
      uploads.set(key, pending);
    }
    return pending;
  };

  const transcribePart = async (
    part: AudioPart,
    build: (audio: UploadedAudio) => InteractionRequest,
    signal: AbortSignal,
  ): Promise<Interaction> => {
    const file = await upload(part);
    return requestSlots(() => {
      signal.throwIfAborted();
      return createInteraction(apiKey, build({ uri: file.uri, mimeType }), { ...rest, signal });
    });
  };

  const emit = (stage: JobStage) => opts.onProgress?.(stage);
  emit('transcribing-timing');
  try {
    const timing = runPass(opts.signal, timingParts, async (signal) => {
      const parts = await Promise.all(
        timingParts.map(
          async (part): Promise<TimedPart> => ({
            startMs: part.startMs,
            endMs: part.endMs,
            words: timedWords(
              await transcribePart(part, (a) => timingPassRequest(a, { languageCodes: opts.languageCodes }), signal),
            ),
          }),
        ),
      );
      return stitchTimingParts(parts);
    });
    const text = runPass(opts.signal, textParts, (signal) =>
      Promise.all(
        textParts.map(
          async (part): Promise<TextPart> => ({
            startMs: part.startMs,
            endMs: part.endMs,
            text: outputText(
              await transcribePart(
                part,
                (a) =>
                  textPassRequest(a, { languageCodes: opts.languageCodes, customVocabulary: opts.customVocabulary }),
                signal,
              ),
            ),
          }),
        ),
      ),
    );

    // The stage names what is still being waited on.
    let textSettled = false;
    void text.then(() => {
      textSettled = true;
    });
    void timing.then(() => {
      if (!textSettled) emit('transcribing-text');
    });

    const [timingResult, textResult] = await Promise.all([timing, text]);
    opts.signal?.throwIfAborted();
    if (timingResult.ok || textResult.ok) emit('aligning');
    return combinePasses(timingResult, textResult);
  } finally {
    await Promise.allSettled(
      [...uploads.values()].map(async (pending) => {
        const file = await pending;
        await deleteFile(apiKey, file.name, transport);
      }),
    );
  }
}
