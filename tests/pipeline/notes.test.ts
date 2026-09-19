import { describe, expect, it } from 'vitest';
import { NotionError } from '@lib/notion/client';
import {
  audioProblemNote,
  audioReadFailedNote,
  duplicateCheckNote,
  isDuplicateCheckNote,
  NOTES,
  noAudioNote,
  passNotes,
  shortError,
  summaryFailedNote,
  transcriptionCause,
  transcriptionFailedNote,
} from '@lib/pipeline/notes';
import { TranscriptionError } from '@lib/transcribe/stitch';

const KEY_ERROR = 'Gemini API error 400 INVALID_ARGUMENT: API key not valid. Please pass a valid API key.';

describe('shortError', () => {
  it('uses the message of an Error, a string as is, and collapses whitespace', () => {
    expect(shortError(new Error('  one\n  two  '))).toBe('one two');
    expect(shortError('plain')).toBe('plain');
    expect(shortError({ code: 1 })).toBe('{"code":1}');
    expect(shortError(undefined)).toBe('unknown error');
  });

  it('caps long messages at 300 characters', () => {
    const s = shortError(new Error('x'.repeat(1000)));
    expect(s).toHaveLength(300);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('duplicate check notes', () => {
  it('explains a Notion failure in the Notion module’s words and can be recognised later', () => {
    const note = duplicateCheckNote(new NotionError(401, 'unauthorized', 'API token is invalid.'));
    expect(note).toBe(
      'Notion was not checked for an existing page before transcribing: ' +
        'Notion rejected the token. Copy it again in Settings.',
    );
    expect(isDuplicateCheckNote(note)).toBe(true);
    expect(isDuplicateCheckNote(NOTES.audioDeleted)).toBe(false);
  });

  it('keeps the words of an unexpected error out of the note', () => {
    const note = duplicateCheckNote(new TypeError("Cannot read properties of undefined (reading 'results')"));
    expect(note).toBe('Notion was not checked for an existing page before transcribing.');
    expect(isDuplicateCheckNote(note)).toBe(true);
  });
});

describe('audio notes', () => {
  it('says why there is no audio', () => {
    expect(noAudioNote()).toBe('No audio was recorded.');
    expect(noAudioNote('  ')).toBe('No audio was recorded.');
    expect(noAudioNote('Tab capture was refused.')).toBe('No audio was recorded: Tab capture was refused.');
    expect(NOTES.audioDeleted).toMatch(/deleted/);
  });

  it('reports unreadable audio and a capture that stopped early', () => {
    expect(audioReadFailedNote(new DOMException('file changed', 'NotReadableError'))).toBe(
      'The audio recording could not be read: file changed',
    );
    // The merge fills the rest from captions, so the note no longer says it is missing.
    expect(audioProblemNote('track ended')).toBe(
      'Audio recording stopped early (track ended); after that, the transcript relies on Meet captions.',
    );
    expect(audioProblemNote('The recorder stopped responding', 1_213_400)).toBe(
      'Audio recording stopped early at 00:20:13 (The recorder stopped responding); ' +
        'after that, the transcript relies on Meet captions.',
    );
  });

  it('embeds a cause that is a sentence without its final period', () => {
    // The background stores whole sentences (copy.ts problems.audioStopped, tabAudioEnded).
    expect(audioProblemNote('Chrome stopped the audio recording.', 1_213_400)).toBe(
      'Audio recording stopped early at 00:20:13 (Chrome stopped the audio recording); ' +
        'after that, the transcript relies on Meet captions.',
    );
    expect(audioProblemNote('The Meet tab’s audio ended. ')).toBe(
      'Audio recording stopped early (The Meet tab’s audio ended); after that, the transcript relies on Meet captions.',
    );
    // An ellipsis from shortening is kept.
    expect(audioProblemNote(`${'x'.repeat(400)}.`)).toMatch(/x…\); after that/);
    expect(audioProblemNote('')).toBe('Audio recording stopped early; after that, the transcript relies on Meet captions.');
  });

  it('says why a transcript comes from captions only when no Gemini key is set', () => {
    expect(NOTES.noGeminiKey).toBe('No Gemini key is set, so this transcript comes from Meet captions only.');
  });
});

describe('transcription notes', () => {
  it('states a shared cause once when both passes failed the same way', () => {
    expect(transcriptionFailedNote(new TranscriptionError(KEY_ERROR, KEY_ERROR))).toBe(
      `Audio transcription failed: ${KEY_ERROR}`,
    );
  });

  it('names each pass when they failed differently', () => {
    expect(transcriptionFailedNote(new TranscriptionError('timeout', 'quota'))).toBe(
      'Audio transcription failed (word-timing pass: timeout; vocabulary pass: quota).',
    );
  });

  it('reports any other error from the transcriber', () => {
    expect(transcriptionFailedNote(new Error('not a WebM file: bad header'))).toBe(
      'Audio transcription failed: not a WebM file: bad header',
    );
  });

  it('gives the cause alone, for a retry message', () => {
    const unreachable = 'Could not reach Gemini (connect ECONNREFUSED 127.0.0.1:9)';
    expect(transcriptionCause(new TranscriptionError(unreachable, unreachable, true))).toBe(unreachable);
    expect(transcriptionCause(new TranscriptionError('timeout', 'quota'))).toBe(
      'word-timing pass: timeout; vocabulary pass: quota',
    );
    expect(transcriptionCause(new Error('boom\n  again'))).toBe('boom again');
  });

  it('notes a single failed pass', () => {
    const ok = { ok: true } as const;
    expect(passNotes({ words: [], text: '', timingPass: ok, textPass: ok })).toEqual([]);
    expect(passNotes({ words: [], text: 'x', timingPass: { ok: false, error: 'boom' }, textPass: ok })).toEqual([
      'The word-timing pass failed: boom',
    ]);
    expect(passNotes({ words: [], text: 'x', timingPass: ok, textPass: { ok: false, error: 'quota' } })).toEqual([
      'The vocabulary pass failed, so names and team terms may be misspelled: quota',
    ]);
  });

  it('notes the parts a pass lost or that came back cut short', () => {
    const timingPass = { ok: true, warning: 'timing pass part 2 (25:00–55:00) failed: Gemini API error 500' } as const;
    const textPass = { ok: true, warning: 'text pass part 2 (54:30–1:50:00) was cut short' } as const;
    expect(passNotes({ words: [], text: 'x', timingPass, textPass })).toEqual([
      'The word-timing pass was partly unavailable, so some times are approximate: ' +
        'timing pass part 2 (25:00–55:00) failed: Gemini API error 500',
      'The vocabulary pass was partly unavailable, so some names and team terms may be misspelled: ' +
        'text pass part 2 (54:30–1:50:00) was cut short',
    ]);
    expect(passNotes({ words: [], text: 'x', timingPass: { ok: false, error: 'boom' }, textPass })).toEqual([
      'The word-timing pass failed: boom',
      'The vocabulary pass was partly unavailable, so some names and team terms may be misspelled: ' +
        'text pass part 2 (54:30–1:50:00) was cut short',
    ]);
  });
});

describe('summary notes', () => {
  it('explains a missing summary', () => {
    expect(summaryFailedNote(new Error(KEY_ERROR))).toBe(`The summary could not be generated: ${KEY_ERROR}`);
  });
});
