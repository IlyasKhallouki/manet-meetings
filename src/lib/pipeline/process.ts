/**
 * Turns a recorded session into a speaker-labelled transcript and a summary.
 *
 * Every stage degrades instead of failing, so a meeting is never lost: an unreachable
 * Notion skips the duplicate check, missing or untranscribable audio (or no Gemini
 * key) leaves the captions, a failed summary leaves the transcript. Each degradation
 * adds a note. Two outcomes are not final: Gemini unreachable before the last attempt
 * ('retry-later'), and an unexpected error (a bug, 'error', worded as STOPPED.process);
 * the session can be retried.
 */
import { webmDurationMs } from '../audio/webm';
import { formatTranscript, mergeTranscript, type MergeInput } from '../merge';
import { buildVocabulary } from '../transcribe/requests';
import { TranscriptionError } from '../transcribe/stitch';
import {
  MAX_TRANSCRIBE_ATTEMPTS,
  type AudioStore,
  type JobStage,
  type MeetingSummary,
  type MeetingTranscript,
  type ProcessJob,
  type ProcessOutcome,
  type SessionMeta,
  type SessionResult,
  type TranscriptionResult,
} from '../types';
import { localDate } from '../util/ids';
import { stageReporter, type PipelineDeps } from './deps';
import {
  audioProblemNote,
  audioReadFailedNote,
  duplicateCheckNote,
  isDuplicateCheckNote,
  isSummaryFailedNote,
  NOTES,
  noAudioNote,
  passNotes,
  shortError,
  STOPPED,
  summaryFailedNote,
  transcriptionCause,
  transcriptionFailedNote,
} from './notes';
import { meetingTitle, sessionAttendees, transcribeDurationMs } from './session';

/** Never throws. An unexpected error (a bug) ends as STOPPED.process, its words in the console. */
export async function processSession(job: ProcessJob, deps: PipelineDeps): Promise<ProcessOutcome> {
  try {
    return await runPipeline(job, deps);
  } catch (err) {
    console.warn('[manet] Transcribing stopped:', err);
    return { status: 'error', error: STOPPED.process };
  }
}

async function runPipeline(job: ProcessJob, deps: PipelineDeps): Promise<ProcessOutcome> {
  const { meta, captions, settings, profile } = job;
  const stage = stageReporter(deps.onStage);
  const notes: string[] = [];

  // Before spending any Gemini call: a teammate may have filed this meeting already.
  // "Save a second copy" (force) means the user has seen that page and wants their own.
  if (!job.force) {
    stage('checking-duplicate');
    try {
      const existing = await deps.store.findByKey(profile.databaseId, meta.idempotencyKey);
      if (existing) return { status: 'duplicate', existing };
    } catch (err) {
      notes.push(duplicateCheckNote(err));
    }
  }
  if (job.reuse) return summarizeAgain(job, job.reuse, deps, notes, stage);

  const selfName = settings.displayName.trim();
  const attendees = sessionAttendees(captions, selfName);
  const hasGemini = settings.geminiApiKey.trim() !== '';

  let transcription: TranscriptionResult | null = null;
  let passes: SessionResult['transcription'] = null;
  let audioEnd: number | undefined;
  if (!hasGemini) {
    notes.push(NOTES.noGeminiKey);
  } else {
    stage('loading-audio');
    const audio = await loadAudio(meta, deps.audio, notes);
    if (audio) {
      audioEnd = await audioEndMs(meta, audio);
      if (meta.audio.error) notes.push(audioProblemNote(meta.audio.error, audioEnd));
      const durationMs = audioEnd ?? transcribeDurationMs(meta);
      try {
        transcription = await deps.ai.transcribe(audio, {
          customVocabulary: buildVocabulary([...settings.customVocabulary, ...profile.vocabulary], attendees),
          languageCodes: settings.languageCodes,
          ...(durationMs !== undefined ? { durationMs } : {}),
          onProgress: stage,
        });
        passes = { timingPass: transcription.timingPass, textPass: transcription.textPass };
        notes.push(...passNotes(transcription));
      } catch (err) {
        // Gemini unreachable is worth another try later; captions only would be final.
        if (retryLater(err, job.attempt)) return { status: 'retry-later', error: transcriptionCause(err) };
        passes = failedPasses(err);
        notes.push(transcriptionFailedNote(err));
      }
    }
  }

  stage('merging');
  const merged = mergeTranscript(mergeInputFor(job, transcription, audioEnd, notes));

  let summary: MeetingSummary | null = null;
  const summaryNotes: string[] = [];
  if (hasGemini && merged.turns.length > 0) {
    stage('summarizing');
    try {
      summary = await deps.ai.summarize(formatTranscript(merged), {
        attendees,
        meetingDate: localDate(meta.startedAt),
        profile,
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
      profile: { id: profile.id, name: profile.name },
      createdAt: Date.now(),
    },
  };
}

/**
 * The stored transcript summarized again for the meeting's new profile. No audio is read
 * and nothing is transcribed; notes about an earlier summary or duplicate check are
 * replaced by this run's.
 */
async function summarizeAgain(
  job: ProcessJob,
  reuse: SessionResult,
  deps: PipelineDeps,
  notes: string[],
  stage: (s: JobStage) => void,
): Promise<ProcessOutcome> {
  const { meta, settings, profile } = job;
  const kept = reuse.transcript.notes.filter((n) => !isSummaryFailedNote(n) && !isDuplicateCheckNote(n));
  const transcript: MeetingTranscript = { ...reuse.transcript, notes: [...notes, ...kept] };
  let summary: MeetingSummary | null = null;
  if (settings.geminiApiKey.trim() !== '' && transcript.turns.length > 0) {
    stage('summarizing');
    try {
      summary = await deps.ai.summarize(formatTranscript(transcript), {
        attendees: reuse.attendees,
        meetingDate: localDate(meta.startedAt),
        profile,
      });
    } catch (err) {
      transcript.notes.push(summaryFailedNote(err));
    }
  }
  return {
    status: 'processed',
    result: {
      ...reuse,
      title: meetingTitle(summary, meta),
      transcript,
      summary,
      profile: { id: profile.id, name: profile.name },
      createdAt: Date.now(),
    },
  };
}

/**
 * What the merge needs to know about the recording besides the words: whether the
 * recorder's mic is in it, which ranges no transcription part covered, and where the
 * audio ends when it stopped early. Captions fill in all three.
 */
export function mergeInputFor(
  job: Pick<ProcessJob, 'meta' | 'captions' | 'settings'>,
  transcription: TranscriptionResult | null,
  audioEnd: number | undefined,
  notes: string[],
): MergeInput {
  return {
    words: transcription?.words ?? [],
    text: transcription?.text ?? '',
    captions: job.captions,
    selfName: job.settings.displayName.trim(),
    notes,
    micIncluded: job.meta.audio.micIncluded,
    ...(transcription?.gaps?.length ? { gaps: transcription.gaps } : {}),
    ...(audioEnd !== undefined ? { audioEndMs: audioEnd } : {}),
  };
}

/**
 * Where the recorded audio ends (ms from recording start) when the recorder stopped
 * before the meeting did, else undefined. Measured from the WebM; if that cannot be
 * parsed, the time of the last persisted chunk.
 */
export async function audioEndMs(meta: SessionMeta, audio: Blob): Promise<number | undefined> {
  if (!meta.audio.error) return undefined;
  try {
    const measured = webmDurationMs(new Uint8Array(await audio.arrayBuffer()));
    if (measured > 0) return measured;
  } catch {
    // Not a parsable WebM: fall back to the chunk heartbeat.
  }
  const last = meta.audio.lastChunkAt;
  return last !== undefined && last > meta.startedAt ? last - meta.startedAt : undefined;
}

/** A transient Gemini failure before the last attempt. */
function retryLater(err: unknown, attempt = 1): boolean {
  return err instanceof TranscriptionError && err.transient && attempt < MAX_TRANSCRIBE_ATTEMPTS;
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
