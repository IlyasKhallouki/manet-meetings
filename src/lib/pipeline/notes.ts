/**
 * Degradation notes: one short sentence per thing that went wrong, shown on the
 * Notion page (and the dashboard) so a reader knows why a transcript is rougher
 * than usual. The merge adds its own notes about the transcript it could build.
 */
import { explainError } from '../notion/errors';
import { TranscriptionError } from '../transcribe/stitch';
import type { TranscriptionResult } from '../types';
import { formatClock } from '../util/time';

const MAX_ERROR_LENGTH = 300;
const DUPLICATE_CHECK = 'Notion was not checked for an existing page before transcribing';

export const NOTES = {
  audioDeleted: 'The audio recording had already been deleted, so it could not be transcribed.',
  noGeminiKey: 'No Gemini key is set, so this transcript comes from Meet captions only.',
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

/** `audioEndMs`: where the recorded audio ends, when known. The merge fills the rest from captions. */
export function audioProblemNote(captureError: string, audioEndMs?: number): string {
  const at = audioEndMs !== undefined ? ` at ${formatClock(audioEndMs)}` : '';
  const cause = shortError(captureError);
  return `Audio recording stopped early${at} (${cause}); after that, the transcript relies on Meet captions.`;
}

/** Each pass's error, or null when both failed the same way (or the error is not per pass). */
function passErrors(err: unknown): { timing: string; text: string } | null {
  if (!(err instanceof TranscriptionError)) return null;
  const timing = shortError(err.timingError);
  const text = shortError(err.textError);
  return timing === text ? null : { timing, text };
}

/** Why the transcription failed, in one line (no final period). */
export function transcriptionCause(err: unknown): string {
  const passes = passErrors(err);
  if (passes) return `word-timing pass: ${passes.timing}; vocabulary pass: ${passes.text}`;
  return shortError(err instanceof TranscriptionError ? err.timingError : err);
}

export function transcriptionFailedNote(err: unknown): string {
  const cause = transcriptionCause(err);
  return passErrors(err) ? `Audio transcription failed (${cause}).` : `Audio transcription failed: ${cause}`;
}

/** Notes for a transcription that succeeded with a pass missing, or with failed or cut-short parts. */
export function passNotes(result: TranscriptionResult): string[] {
  const notes: string[] = [];
  const { timingPass, textPass } = result;
  if (!timingPass.ok) notes.push(`The word-timing pass failed: ${shortError(timingPass.error)}`);
  else if (timingPass.warning) {
    const warning = shortError(timingPass.warning);
    notes.push(`The word-timing pass was partly unavailable, so some times are approximate: ${warning}`);
  }
  if (!textPass.ok) {
    const error = shortError(textPass.error);
    notes.push(`The vocabulary pass failed, so names and team terms may be misspelled: ${error}`);
  } else if (textPass.warning) {
    const warning = shortError(textPass.warning);
    notes.push(
      `The vocabulary pass was partly unavailable, so some names and team terms may be misspelled: ${warning}`,
    );
  }
  return notes;
}

export function summaryFailedNote(err: unknown): string {
  return `The summary could not be generated: ${shortError(err)}`;
}
