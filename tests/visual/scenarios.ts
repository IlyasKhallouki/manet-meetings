/**
 * Fixture data for the screenshot gallery: every surface in its key states. Times are
 * fixed so screenshots are stable.
 */
import type { CaptionSegment, SessionMeta, Settings } from '@lib/types';
import { DEFAULT_SETTINGS } from '@lib/settingsSchema';

export const NOW = Date.UTC(2026, 8, 19, 15, 42, 0);
const MIN = 60_000;
const MB = 1024 * 1024;

export function session(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt: NOW - 90 * MIN,
    endedAt: NOW - 58 * MIN,
    durationMs: 32 * MIN,
    status: 'ready',
    route: 'team',
    profileId: 'team',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 384, bytes: 7.4 * MB, micIncluded: true },
    captionCount: 214,
    ...patch,
  };
}

/** One session per status, newest first, with realistic titles and problems. */
export const SESSIONS: SessionMeta[] = [
  session('rec', {
    status: 'recording',
    meetCode: 'qrs-tuvw-xyz',
    meetingTitle: 'Client call — Halstead audit pilot',
    startedAt: NOW - 23 * MIN,
    endedAt: undefined,
    durationMs: undefined,
    route: undefined,
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 276, bytes: 5.3 * MB, micIncluded: true },
  }),
  session('route', {
    status: 'awaiting-route',
    meetingTitle: 'Point hebdo produit',
    startedAt: NOW - 70 * MIN,
    route: undefined,
  }),
  session('proc', {
    status: 'processing',
    stage: 'transcribing-text',
    meetingTitle: 'Design review — onboarding',
    startedAt: NOW - 3 * 60 * MIN,
    durationMs: 47 * MIN,
    route: 'personal',
    profileId: 'personal',
  }),
  session('saved', {
    status: 'saved',
    meetingTitle: 'Weekly product sync',
    startedAt: NOW - 26 * 60 * MIN,
    durationMs: 58 * MIN,
    savedAt: NOW - 25 * 60 * MIN,
    purgeAudioAt: NOW + 6 * 24 * 60 * MIN,
    notion: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Ilyas' },
  }),
  session('dup', {
    status: 'duplicate',
    meetCode: 'xyz-abcd-efg',
    meetingTitle: 'Standup',
    startedAt: NOW - 27 * 60 * MIN,
    durationMs: 14 * MIN,
    notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Yasser' },
  }),
  session('failed', {
    status: 'failed',
    meetCode: 'mno-pqrs-tuv',
    startedAt: NOW - 28 * 60 * MIN,
    durationMs: 25 * MIN,
    error: 'Gemini unreachable: the service is unavailable (503). Retrying automatically at 4:52 PM.',
    retryAt: NOW + 10 * MIN,
    attempt: 1,
  }),
  session('processed', {
    status: 'processed',
    meetingTitle: 'Sales pipeline review',
    startedAt: NOW - 50 * 60 * MIN,
    durationMs: 36 * MIN,
    error: 'Saving to Notion failed: the Team database is not shared with your token.',
  }),
  session('empty', {
    status: 'empty',
    meetCode: 'efg-hijk-lmn',
    startedAt: NOW - 51 * 60 * MIN,
    durationMs: 40_000,
    captionCount: 0,
  }),
  session('recovered', {
    status: 'ready',
    recovered: true,
    meetingTitle: 'Board prep',
    startedAt: NOW - 3 * 24 * 60 * MIN,
    durationMs: 19 * MIN,
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 228, bytes: 4.4 * MB, micIncluded: false },
  }),
];

/** A short who-spoke-when caption timeline for a session (for surfaces that show speakers). */
export function captionsFor(durationMs: number): CaptionSegment[] {
  const speakers = ['Ilyas', 'Yasser', 'Camille Martin', 'Ilyas', 'Jean-Baptiste', 'Yasser'];
  const out: CaptionSegment[] = [];
  let t = 0;
  let i = 0;
  while (t < durationMs) {
    const len = 8_000 + ((i * 7919) % 50_000);
    const speaker = speakers[i % speakers.length]!;
    out.push({ id: `c${i}`, speaker, self: speaker === 'Ilyas', text: '…', tStart: t, tEnd: Math.min(durationMs, t + len), rev: 1 });
    t += len + 1_000;
    i++;
  }
  return out;
}

export const FULL_SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  displayName: 'Ilyas',
  geminiApiKey: 'AIzaSyD-example-key-000000000000000000',
  notionToken: 'ntn_example_token_0000000000000000000000000000',
  notionTeamDbId: 'https://www.notion.so/team/Meetings-0123456789abcdef0123456789abcdef',
  notionPersonalDbId: '',
  customVocabulary: ['Lumind', 'Manet', 'OPFS', 'Halstead'],
  languageCodes: ['en-US', 'fr-FR'],
};
