/**
 * Pure pieces of the pipeline: who attended, what the meeting is called, how long it
 * lasted, and the Notion page input built from a processed session.
 */
import { attendeesFrom } from '../merge';
import type {
  CaptionSegment,
  MeetingPageInput,
  MeetingSummary,
  MeetingTranscript,
  Route,
  SaveJob,
  SessionMeta,
  Settings,
} from '../types';
import { isDuplicateCheckNote } from './notes';

/**
 * Same as databaseIdFor in settings.ts. The pipeline runs in the offscreen document,
 * which has no chrome.storage, and importing settings.ts there defines a storage item
 * that reads chrome.storage on load.
 */
export function routeDatabaseId(settings: Settings, route: Route): string {
  return route === 'team' ? settings.notionTeamDbId : settings.notionPersonalDbId;
}

/** Caption speakers in order of appearance, plus the local user even if they never spoke. */
export function sessionAttendees(captions: CaptionSegment[], selfName: string): string[] {
  const self = selfName.trim();
  const names = attendeesFrom(captions, self);
  const known = new Set(names.map((n) => n.toLocaleLowerCase()));
  return self && !known.has(self.toLocaleLowerCase()) ? [...names, self] : names;
}

export function meetingTitle(
  summary: MeetingSummary | null,
  meta: Pick<SessionMeta, 'meetingTitle' | 'meetCode'>,
): string {
  return summary?.title.trim() || meta.meetingTitle?.trim() || `Meeting ${meta.meetCode}`;
}

/**
 * Duration to hand the transcriber, which uses it to decide whether to split. Only a
 * session that stopped normally knows it; recovered sessions estimate their end (from
 * the last heartbeat or the chunk count, possibly 0), and an underestimate would send
 * a part longer than the API accepts. Undefined lets the transcriber measure the WebM.
 */
export function transcribeDurationMs(meta: Pick<SessionMeta, 'durationMs' | 'recovered'>): number | undefined {
  if (meta.recovered) return undefined;
  return meta.durationMs !== undefined && meta.durationMs > 0 ? meta.durationMs : undefined;
}

/** Meeting length for Notion: the recorded duration, or the last turn's end when later. */
export function meetingDurationMs(meta: Pick<SessionMeta, 'durationMs'>, transcript: MeetingTranscript): number {
  const lastEnd = transcript.turns.reduce((max, turn) => Math.max(max, turn.end), 0);
  return Math.round(Math.max(0, meta.durationMs ?? 0, lastEnd));
}

export function buildMeetingPageInput({ meta, result, settings }: SaveJob): MeetingPageInput {
  return {
    key: meta.idempotencyKey,
    title: result.title.trim() || meetingTitle(null, meta),
    startedAt: meta.startedAt,
    durationMs: meetingDurationMs(meta, result.transcript),
    attendees: result.attendees,
    meetCode: meta.meetCode,
    recordedBy: settings.displayName.trim(),
    source: result.transcript.source,
    summary: result.summary,
    transcript: {
      ...result.transcript,
      notes: result.transcript.notes.filter((note) => !isDuplicateCheckNote(note)),
    },
  };
}
