/**
 * Turns a recorded session into a speaker-labelled transcript and a summary.
 *
 * Every stage degrades instead of failing, so a meeting is never lost: an unreachable
 * Notion skips the duplicate check, missing or untranscribable audio leaves the
 * captions, a failed summary leaves the transcript. Each degradation adds a note. Only
 * an unexpected error (a bug) ends in 'error', and the session can then be retried.
 */
import { formatTranscript, mergeTranscript } from '../merge';
import { buildVocabulary } from '../transcribe/requests';
import { TranscriptionError } from '../transcribe/stitch';
import type {
  AudioStore,
  MeetingSummary,
  ProcessJob,
  ProcessOutcome,
  SessionMeta,
  SessionResult,
  TranscriptionResult,
} from '../types';
import { localDate } from '../util/ids';
import { stageReporter, type PipelineDeps } from './deps';
import {
  audioProblemNote,
  audioReadFailedNote,
  duplicateCheckNote,
  NOTES,
  noAudioNote,
  passNotes,
  shortError,
  summaryFailedNote,
  transcriptionFailedNote,
} from './notes';
import { meetingTitle, routeDatabaseId, sessionAttendees, transcribeDurationMs } from './session';

export async function processSession(job: ProcessJob, deps: PipelineDeps): Promise<ProcessOutcome> {
  try {
    return await runPipeline(job, deps);
  } catch (err) {
    return { status: 'error', error: `Processing failed: ${shortError(err)}` };
  }
}

async function runPipeline(job: ProcessJob, deps: PipelineDeps): Promise<ProcessOutcome> {
  const { meta, captions, settings, route } = job;
  const stage = stageReporter(deps.onStage);
  const notes: string[] = [];

  // Before spending any Gemini call: a teammate may have filed this meeting already.
  stage('checking-duplicate');
  try {
    const existing = await deps.store.findByKey(routeDatabaseId(settings, route), meta.idempotencyKey);
    if (existing) return { status: 'duplicate', existing };
  } catch (err) {
    notes.push(duplicateCheckNote(err));
  }

  const selfName = settings.displayName.trim();
  const attendees = sessionAttendees(captions, selfName);

  stage('loading-audio');
  const audio = await loadAudio(meta, deps.audio, notes);

  let transcription: TranscriptionResult | null = null;
  let passes: SessionResult['transcription'] = null;
  if (audio) {
    const durationMs = transcribeDurationMs(meta);
    try {
      transcription = await deps.ai.transcribe(audio, {
        customVocabulary: buildVocabulary(settings.customVocabulary, attendees),
        languageCodes: settings.languageCodes,
        ...(durationMs !== undefined ? { durationMs } : {}),
        onProgress: stage,
      });
      passes = { timingPass: transcription.timingPass, textPass: transcription.textPass };
      notes.push(...passNotes(transcription));
    } catch (err) {
      passes = failedPasses(err);
      notes.push(transcriptionFailedNote(err));
    }
  }

  stage('merging');
  const merged = mergeTranscript({
    words: transcription?.words ?? [],
    text: transcription?.text ?? '',
    captions,
    selfName,
    notes,
  });

  let summary: MeetingSummary | null = null;
  const summaryNotes: string[] = [];
  if (merged.turns.length > 0) {
    stage('summarizing');
    try {
      summary = await deps.ai.summarize(formatTranscript(merged), {
        attendees,
        meetingDate: localDate(meta.startedAt),
      });
    } catch (err) {
      summaryNotes.push(summaryFailedNote(err));
    }
  }

  return {
    status: 'processed',
    result: {
      title: meetingTitle(summary, meta),
      attendees,
      transcript: { ...merged, notes: [...merged.notes, ...summaryNotes] },
      summary,
      transcription: passes,
      createdAt: Date.now(),
    },
  };
}

/** The recording, or null (with a note saying why) when there is none to transcribe. */
async function loadAudio(meta: SessionMeta, store: AudioStore, notes: string[]): Promise<Blob | null> {
  if (meta.audio.deletedAt !== undefined) {
    notes.push(NOTES.audioDeleted);
    return null;
  }
  let audio: Blob | null;
  try {
    audio = await store.readAudio(meta.id);
  } catch (err) {
    notes.push(audioReadFailedNote(err));
    return null;
  }
  if (!audio || audio.size === 0) {
    notes.push(noAudioNote(meta.audio.error));
    return null;
  }
  if (meta.audio.error) notes.push(audioProblemNote(meta.audio.error));
  return audio;
}

function failedPasses(err: unknown): NonNullable<SessionResult['transcription']> {
  if (err instanceof TranscriptionError) {
    return {
      timingPass: { ok: false, error: shortError(err.timingError) },
      textPass: { ok: false, error: shortError(err.textError) },
    };
  }
  const error = shortError(err);
  return { timingPass: { ok: false, error }, textPass: { ok: false, error } };
}
