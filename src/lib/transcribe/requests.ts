/**
 * Request bodies for the two gemini-3.5-transcribe passes.
 *
 * The API rejects custom_vocabulary together with word timestamps or diarization,
 * so the passes are split: the timing pass gets timestamps and no vocabulary, the
 * text pass gets the vocabulary and nothing else. Timestamps go inside the verbatim
 * `mode` object (the top-level fields are deprecated).
 */
import { TRANSCRIBE_MODEL } from '../gemini/models';
import type { InteractionRequest, TranscriptionConfig } from '../gemini/rest';

/** API limit. The docs note recognition is best with ≤ 100 terms. */
export const MAX_VOCABULARY = 1000;

export interface UploadedAudio {
  uri: string;
  mimeType: string;
}

/**
 * Settings terms first, then attendee names: trimmed, blanks dropped, deduplicated
 * case-insensitively (first spelling wins), capped at MAX_VOCABULARY in order.
 */
export function buildVocabulary(terms: readonly string[], attendees: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...terms, ...attendees]) {
    const term = raw.trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length === MAX_VOCABULARY) break;
  }
  return out;
}

/** Throws when a config combines features the API refuses together. */
export function assertTranscriptionConfig(config: TranscriptionConfig): void {
  // Also inspect the deprecated top-level placements.
  const legacy = config as TranscriptionConfig & { timestamp_granularities?: unknown[]; diarization_mode?: unknown };
  const mode = typeof config.mode === 'object' ? config.mode : undefined;
  const verbatim = mode?.type === 'verbatim' ? mode : undefined;
  const timestamps = (verbatim?.timestamp_granularities?.length ?? 0) > 0 || (legacy.timestamp_granularities?.length ?? 0) > 0;
  const diarization = Boolean(verbatim?.diarization_mode || legacy.diarization_mode);
  const vocabulary = config.custom_vocabulary?.length ?? 0;
  const smart = config.mode === 'smart' || mode?.type === 'smart';

  if (vocabulary > 0 && (timestamps || diarization)) {
    throw new Error('custom_vocabulary cannot be combined with word timestamps or diarization');
  }
  if (smart && (timestamps || diarization)) {
    throw new Error('smart transcription cannot be combined with word timestamps or diarization');
  }
  if (vocabulary > MAX_VOCABULARY) {
    throw new Error(`custom_vocabulary is limited to ${MAX_VOCABULARY} terms`);
  }
}

function request(audio: UploadedAudio, config: TranscriptionConfig): InteractionRequest {
  assertTranscriptionConfig(config);
  return {
    model: TRANSCRIBE_MODEL,
    input: [{ type: 'audio', uri: audio.uri, mime_type: audio.mimeType }],
    generation_config: { transcription_config: config },
    store: false,
  };
}

function languageHints(languageCodes: readonly string[]): Pick<TranscriptionConfig, 'language_codes'> {
  const codes = languageCodes.map((c) => c.trim()).filter(Boolean);
  return codes.length > 0 ? { language_codes: codes } : {};
}

/** Verbatim with word timestamps. No vocabulary, no diarization. Audio ≤ 30 min. */
export function timingPassRequest(audio: UploadedAudio, opts: { languageCodes: readonly string[] }): InteractionRequest {
  return request(audio, {
    mode: { type: 'verbatim', timestamp_granularities: ['word'] },
    ...languageHints(opts.languageCodes),
  });
}

/** Default (verbatim) mode biased toward the vocabulary. No timestamps. Audio ≤ 60 min. */
export function textPassRequest(
  audio: UploadedAudio,
  opts: { languageCodes: readonly string[]; customVocabulary: readonly string[] },
): InteractionRequest {
  const vocabulary = buildVocabulary(opts.customVocabulary);
  return request(audio, {
    ...(vocabulary.length > 0 ? { custom_vocabulary: vocabulary } : {}),
    ...languageHints(opts.languageCodes),
  });
}
