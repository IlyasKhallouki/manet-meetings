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
        'Notion says the token is invalid. Copy the integration secret again into the options.',
    );
    expect(isDuplicateCheckNote(note)).toBe(true);
    expect(isDuplicateCheckNote(NOTES.audioDeleted)).toBe(false);
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
    expect(audioProblemNote('track ended')).toBe(
      'Audio recording stopped early (track ended); later parts of the meeting may be missing from the transcript.',
    );
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
});

describe('summary notes', () => {
  it('explains a missing summary', () => {
    expect(summaryFailedNote(new Error(KEY_ERROR))).toBe(`The summary could not be generated: ${KEY_ERROR}`);
  });
});
