/**
 * Runs both gemini-3.5-transcribe passes over pre-cut audio parts.
 *
 * Each distinct part is uploaded once and shared by the passes that need it (a
 * recording that fits one timing part is uploaded once for both). The passes and
 * their parts run side by side and independently: a failed part costs only its own
 * span, never its siblings or the other pass. Uploads are deleted at the end (and
 * by uploadFile itself when an upload fails), best effort.
 */
import {
  createInteraction,
  deleteFile,
  isTransientError,
  uploadFile,
  type GeminiFile,
  type InteractionRequest,
  type RestOptions,
} from '../gemini/rest';
import { outputText, timedWords, type Interaction } from '../gemini/response';
import type { JobStage, TimedWord, TranscriptionResult } from '../types';
import { textPassRequest, timingPassRequest, type UploadedAudio } from './requests';
import { combinePasses, type PartOutcome, type PartSpan } from './stitch';

export { TranscriptionError } from './stitch';

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

/** Runs one part to an outcome; an 'incomplete' interaction is kept, flagged. */
async function runPart<T>(
  part: AudioPart,
  request: () => Promise<Interaction>,
  read: (interaction: Interaction) => T,
): Promise<PartOutcome<T>> {
  const span = { startMs: part.startMs, endMs: part.endMs };
  try {
    const interaction = await request();
    // 'incomplete' (e.g. an output cap): the partial output is kept and the pass warns.
    const incomplete = interaction.status === 'incomplete';
    return { ...span, ok: true, value: read(interaction), ...(incomplete ? { incomplete } : {}) };
  } catch (err) {
    return { ...span, ok: false, error: errorMessage(err), transient: isTransientError(err) };
  }
}

/**
 * Transcribes a recording given as timing-pass parts (≤ 30 min each, word
 * timestamps) and text-pass parts (≤ 60 min each, custom vocabulary). Parts of a
 * pass must cover the recording with overlaps; they may be the same objects.
 * Resolves with degraded results (pass warnings, `gaps`) when parts or a whole pass
 * fail, throws a TranscriptionError when every part of both passes failed, and
 * rethrows the abort reason when `signal` aborts.
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
  ): Promise<Interaction> => {
    const file = await upload(part);
    return requestSlots(() => {
      opts.signal?.throwIfAborted();
      return createInteraction(apiKey, build({ uri: file.uri, mimeType }), rest);
    });
  };

  const emit = (stage: JobStage) => opts.onProgress?.(stage);
  emit('transcribing-timing');
  try {
    const timing = Promise.all(
      timingParts.map((part) =>
        runPart<TimedWord[]>(
          part,
          () => transcribePart(part, (a) => timingPassRequest(a, { languageCodes: opts.languageCodes })),
          timedWords,
        ),
      ),
    );
    const text = Promise.all(
      textParts.map((part) =>
        runPart<string>(
          part,
          () =>
            transcribePart(part, (a) =>
              textPassRequest(a, { languageCodes: opts.languageCodes, customVocabulary: opts.customVocabulary }),
            ),
          outputText,
        ),
      ),
    );

    // The stage names what is still being waited on. Checked a task later: when a
    // shared upload fails, both passes settle in the same microtask flush.
    let textSettled = false;
    void text.then(() => {
      textSettled = true;
    });
    void timing.then(() =>
      setTimeout(() => {
        if (!textSettled) emit('transcribing-text');
      }, 0),
    );

    const [timingResult, textResult] = await Promise.all([timing, text]);
    opts.signal?.throwIfAborted();
    if ([...timingResult, ...textResult].some((p) => p.ok)) emit('aligning');
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
