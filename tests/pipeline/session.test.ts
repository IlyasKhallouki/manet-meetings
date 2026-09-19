import { describe, expect, it } from 'vitest';
import { NotionError } from '@lib/notion/client';
import { duplicateCheckNote } from '@lib/pipeline/notes';
import {
  buildMeetingPageInput,
  meetingDurationMs,
  meetingTitle,
  routeDatabaseId,
  sessionAttendees,
  transcribeDurationMs,
} from '@lib/pipeline/session';
import type { MeetingSummary, MeetingTranscript, SessionResult } from '@lib/types';
import { MEET_CODE, mixedSpeechCaptions, revisions, sessionMeta, testSettings } from '../helpers/meeting';

const summary: MeetingSummary = {
  title: 'Budget review',
  summary: 'We reviewed the budget.',
  keyPoints: ['Budget is on track'],
  decisions: [],
  actionItems: [{ task: 'Send the deck', owner: 'Camille Martin' }],
  language: 'en-US',
};

describe('sessionAttendees', () => {
  it('lists caption speakers in order of appearance with the local user under their name', () => {
    expect(sessionAttendees(mixedSpeechCaptions(), 'Ilyas')).toEqual(['Camille Martin', 'Ilyas']);
  });

  it('adds the local user even when they never spoke', () => {
    const captions = revisions('c1', 'Camille Martin', 0, 2000, ['Bonjour à tous']);
    expect(sessionAttendees(captions, ' Ilyas ')).toEqual(['Camille Martin', 'Ilyas']);
    expect(sessionAttendees([], 'Ilyas')).toEqual(['Ilyas']);
  });

  it('does not add the local user twice, nor a blank name', () => {
    const captions = revisions('c1', 'ILYAS', 0, 2000, ['Hello']);
    expect(sessionAttendees(captions, 'Ilyas')).toEqual(['ILYAS']);
    expect(sessionAttendees(mixedSpeechCaptions(), '  ')).toEqual(['Camille Martin', 'You']);
  });
});

describe('meetingTitle', () => {
  it('prefers the summary title, then the Meet title, then the meet code', () => {
    expect(meetingTitle(summary, sessionMeta())).toBe('Budget review');
    expect(meetingTitle(null, sessionMeta({ meetingTitle: 'Weekly sync' }))).toBe('Weekly sync');
    expect(meetingTitle({ ...summary, title: '  ' }, sessionMeta({ meetingTitle: '  ' }))).toBe(`Meeting ${MEET_CODE}`);
    expect(meetingTitle(null, sessionMeta({ meetingTitle: undefined }))).toBe(`Meeting ${MEET_CODE}`);
  });
});

describe('transcribeDurationMs', () => {
  it('trusts the duration of a session that stopped normally', () => {
    expect(transcribeDurationMs(sessionMeta({ durationMs: 80_408 }))).toBe(80_408);
  });

  it('lets the transcriber measure the audio when the duration is an estimate or unknown', () => {
    // Recovered sessions date their end from the last heartbeat or a chunk count.
    expect(transcribeDurationMs(sessionMeta({ recovered: true, durationMs: 60_000 }))).toBeUndefined();
    expect(transcribeDurationMs(sessionMeta({ durationMs: 0 }))).toBeUndefined();
    expect(transcribeDurationMs(sessionMeta({ durationMs: undefined }))).toBeUndefined();
  });
});

describe('meetingDurationMs', () => {
  const transcript = (end: number): MeetingTranscript => ({
    turns: [{ speaker: 'Camille Martin', start: 0, end, text: 'Bonjour' }],
    source: 'captions-only',
    notes: [],
  });

  it('is the recorded duration, or the end of the last turn when that is later', () => {
    expect(meetingDurationMs(sessionMeta({ durationMs: 80_408 }), transcript(79_000))).toBe(80_408);
    expect(meetingDurationMs(sessionMeta({ recovered: true, durationMs: 0 }), transcript(95_500.4))).toBe(95_500);
    const empty: MeetingTranscript = { turns: [], source: 'captions-only', notes: [] };
    expect(meetingDurationMs(sessionMeta({ durationMs: undefined }), empty)).toBe(0);
  });
});

describe('routeDatabaseId', () => {
  it('picks the database of the route', () => {
    const settings = testSettings({ notionTeamDbId: 'team-db', notionPersonalDbId: 'personal-db' });
    expect(routeDatabaseId(settings, 'team')).toBe('team-db');
    expect(routeDatabaseId(settings, 'personal')).toBe('personal-db');
  });
});

describe('buildMeetingPageInput', () => {
  const dupNote = duplicateCheckNote(new NotionError(0, 'network_error', 'Could not reach Notion.'));
  const result: SessionResult = {
    title: 'Budget review',
    attendees: ['Camille Martin', 'Ilyas'],
    transcript: {
      turns: [
        { speaker: 'Camille Martin', start: 1000, end: 4000, text: 'On regarde le budget.' },
        { speaker: 'Ilyas', start: 4500, end: 9000, text: 'The budget is on track.' },
      ],
      source: 'audio+captions',
      notes: [dupNote, 'The vocabulary pass failed, so names and team terms may be misspelled: quota'],
    },
    summary,
    transcription: { timingPass: { ok: true }, textPass: { ok: false, error: 'quota' } },
    createdAt: 1,
  };

  it('maps the session and its result onto the Notion page', () => {
    const meta = sessionMeta();
    const input = buildMeetingPageInput({
      meta,
      result,
      settings: testSettings({ displayName: ' Ilyas ' }),
      route: 'team',
    });
    expect(input).toEqual({
      key: meta.idempotencyKey,
      title: 'Budget review',
      startedAt: meta.startedAt,
      durationMs: 80_408,
      attendees: ['Camille Martin', 'Ilyas'],
      meetCode: MEET_CODE,
      recordedBy: 'Ilyas',
      source: 'audio+captions',
      summary,
      transcript: {
        turns: result.transcript.turns,
        source: 'audio+captions',
        // The save checks Notion itself, so the pre-transcription check note is dropped.
        notes: ['The vocabulary pass failed, so names and team terms may be misspelled: quota'],
      },
    });
  });

  it('falls back to a title when a stored result has none', () => {
    const input = buildMeetingPageInput({
      meta: sessionMeta({ meetingTitle: undefined }),
      result: { ...result, title: ' ' },
      settings: testSettings(),
      route: 'personal',
    });
    expect(input.title).toBe(`Meeting ${MEET_CODE}`);
  });
});
