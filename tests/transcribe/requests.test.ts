import { describe, expect, it } from 'vitest';
import {
  assertTranscriptionConfig,
  buildVocabulary,
  MAX_VOCABULARY,
  textPassRequest,
  timingPassRequest,
} from '@lib/transcribe/requests';
import type { TranscriptionConfig } from '@lib/gemini/rest';

const FILE = { uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc', mimeType: 'audio/webm' };

/** Every key that appears anywhere in a JSON value. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe('buildVocabulary', () => {
  it('puts settings terms first, then attendee names, trimmed and in order', () => {
    expect(buildVocabulary([' Lumind ', 'Manet'], ['Ilya K.', 'Claire Dupont '])).toEqual([
      'Lumind',
      'Manet',
      'Ilya K.',
      'Claire Dupont',
    ]);
  });

  it('drops blanks and case-insensitive duplicates, keeping the first spelling', () => {
    expect(buildVocabulary(['Lumind', '', '  ', 'lumind', 'OKR'], ['Claire', 'claire', 'okr', 'Paul'])).toEqual([
      'Lumind',
      'OKR',
      'Claire',
      'Paul',
    ]);
  });

  it('caps at 1000 terms, keeping the earliest', () => {
    const terms = Array.from({ length: 1200 }, (_, i) => `term${i}`);
    const vocab = buildVocabulary(terms, ['Late Attendee']);
    expect(MAX_VOCABULARY).toBe(1000);
    expect(vocab).toHaveLength(1000);
    expect(vocab[0]).toBe('term0');
    expect(vocab.at(-1)).toBe('term999');
  });
});

describe('timingPassRequest', () => {
  it('asks gemini-3.5-transcribe for verbatim word timestamps on the uploaded file', () => {
    expect(timingPassRequest(FILE, { languageCodes: [] })).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: FILE.uri, mime_type: 'audio/webm' }],
      generation_config: {
        transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } },
      },
      store: false,
    });
  });

  it('passes language hints through and omits them when empty (auto-detect + code-switching)', () => {
    const req = timingPassRequest(FILE, { languageCodes: ['fr-FR', 'en-US'] });
    expect(req.generation_config?.transcription_config?.language_codes).toEqual(['fr-FR', 'en-US']);
    expect(keysDeep(timingPassRequest(FILE, { languageCodes: [] }))).not.toContain('language_codes');
  });

  it('never carries custom vocabulary or diarization', () => {
    const keys = keysDeep(timingPassRequest(FILE, { languageCodes: ['fr-FR'] }));
    for (const banned of ['custom_vocabulary', 'adaptation_phrases', 'diarization_mode']) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe('textPassRequest', () => {
  it('biases toward the vocabulary without timestamps or diarization', () => {
    const req = textPassRequest(FILE, { languageCodes: [], customVocabulary: ['Lumind', 'Manet'] });
    expect(req).toEqual({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: FILE.uri, mime_type: 'audio/webm' }],
      generation_config: { transcription_config: { custom_vocabulary: ['Lumind', 'Manet'] } },
      store: false,
    });
    const keys = keysDeep(req);
    for (const banned of ['timestamp_granularities', 'diarization_mode', 'adaptation_phrases', 'mode']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('omits an empty vocabulary and passes language hints', () => {
    const req = textPassRequest(FILE, { languageCodes: ['fr-FR'], customVocabulary: [] });
    expect(req.generation_config?.transcription_config).toEqual({ language_codes: ['fr-FR'] });
  });

  it('normalizes and caps the vocabulary it is given', () => {
    const many = Array.from({ length: 1500 }, (_, i) => ` t${i} `);
    const vocab = textPassRequest(FILE, { languageCodes: [], customVocabulary: many }).generation_config
      ?.transcription_config?.custom_vocabulary;
    expect(vocab).toHaveLength(1000);
    expect(vocab?.[0]).toBe('t0');
  });
});

describe('assertTranscriptionConfig', () => {
  it('rejects custom vocabulary combined with word timestamps or diarization', () => {
    const bad: TranscriptionConfig[] = [
      { custom_vocabulary: ['x'], mode: { type: 'verbatim', timestamp_granularities: ['word'] } },
      { custom_vocabulary: ['x'], mode: { type: 'verbatim', diarization_mode: 'speaker' } },
      // Deprecated top-level placements count too.
      { custom_vocabulary: ['x'], timestamp_granularities: ['word'] } as TranscriptionConfig,
      { custom_vocabulary: ['x'], diarization_mode: 'speaker' } as TranscriptionConfig,
    ];
    for (const config of bad) expect(() => assertTranscriptionConfig(config)).toThrow(/custom_vocabulary/);
  });

  it('rejects smart mode with timestamps and more than 1000 terms', () => {
    expect(() =>
      assertTranscriptionConfig({ mode: 'smart', timestamp_granularities: ['word'] } as TranscriptionConfig),
    ).toThrow(/smart/);
    expect(() =>
      assertTranscriptionConfig({ custom_vocabulary: Array.from({ length: 1001 }, (_, i) => `t${i}`) }),
    ).toThrow(/1000/);
  });

  it('accepts each pass configuration on its own', () => {
    expect(() => assertTranscriptionConfig({ mode: { type: 'verbatim', timestamp_granularities: ['word'] } })).not.toThrow();
    expect(() => assertTranscriptionConfig({ custom_vocabulary: ['x'], language_codes: ['fr-FR'] })).not.toThrow();
    expect(() => assertTranscriptionConfig({ custom_vocabulary: [], mode: { type: 'verbatim', timestamp_granularities: ['word'] } })).not.toThrow();
  });
});
