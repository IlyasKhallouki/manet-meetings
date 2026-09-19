/**
 * Degradation notes: one short sentence per thing that went wrong, shown on the
 * Notion page (and the dashboard) so a reader knows why a transcript is rougher
 * than usual. The merge adds its own notes about the transcript it could build.
 */
import { explainError } from '../notion/errors';
import { TranscriptionError } from '../transcribe/stitch';
import type { TranscriptionResult } from '../types';

const MAX_ERROR_LENGTH = 300;
const DUPLICATE_CHECK = 'Notion was not checked for an existing page before transcribing';

export const NOTES = {
  audioDeleted: 'The audio recording had already been deleted, so it could not be transcribed.',
} as const;

/** An error as one line of at most 300 characters. */
export function shortError(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : err === undefined ? '' : JSON.stringify(err);
  const line = (raw ?? '').replace(/\s+/g, ' ').trim() || 'unknown error';
  return line.length > MAX_ERROR_LENGTH ? `${line.slice(0, MAX_ERROR_LENGTH - 1)}…` : line;
}

export function duplicateCheckNote(err: unknown): string {
  return `${DUPLICATE_CHECK}: ${shortError(explainError(err))}`;
}

/** The save runs its own check, so this note no longer applies once the page exists. */
export function isDuplicateCheckNote(note: string): boolean {
  return note.startsWith(DUPLICATE_CHECK);
}

export function noAudioNote(captureError?: string): string {
  const cause = captureError?.trim();
  return cause ? `No audio was recorded: ${shortError(cause)}` : 'No audio was recorded.';
}

export function audioReadFailedNote(err: unknown): string {
  return `The audio recording could not be read: ${shortError(err)}`;
}

export function audioProblemNote(captureError: string): string {
  return (
    `Audio recording stopped early (${shortError(captureError)}); ` +
    'later parts of the meeting may be missing from the transcript.'
  );
}

export function transcriptionFailedNote(err: unknown): string {
  if (err instanceof TranscriptionError) {
    const timing = shortError(err.timingError);
    const text = shortError(err.textError);
    if (timing === text) return `Audio transcription failed: ${timing}`;
    return `Audio transcription failed (word-timing pass: ${timing}; vocabulary pass: ${text}).`;
  }
  return `Audio transcription failed: ${shortError(err)}`;
}

/** Notes for a transcription that succeeded with one pass missing. */
export function passNotes(result: TranscriptionResult): string[] {
  const notes: string[] = [];
  if (!result.timingPass.ok) notes.push(`The word-timing pass failed: ${shortError(result.timingPass.error)}`);
  if (!result.textPass.ok) {
    const error = shortError(result.textPass.error);
    notes.push(`The vocabulary pass failed, so names and team terms may be misspelled: ${error}`);
  }
  return notes;
}

export function summaryFailedNote(err: unknown): string {
  return `The summary could not be generated: ${shortError(err)}`;
}
