/**
 * A Meetings page with one meeting per state, real-length titles and names. Shared by the
 * screenshot gallery (tests/visual/dashboard.shots.ts) and the layout test.
 */
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import { NOW, session } from '../visual/scenarios';

export { NOW };

const MIN = 60_000;
const HOUR = 60 * MIN;
const MB = 1024 * 1024;

function roll(...names: string[]): SpeakerInfo[] {
  return names.map((name, i) => ({
    name: name === 'you' ? 'Ilyas' : name,
    self: name === 'you',
    firstAt: i * 30_000,
    lastAt: i * 30_000 + 20_000,
    talkMs: 20_000,
  }));
}

const audio = (mb: number, patch: Partial<SessionMeta['audio']> = {}): SessionMeta['audio'] => ({
  mimeType: 'audio/webm;codecs=opus',
  chunkCount: 100,
  bytes: mb * MB,
  micIncluded: true,
  ...patch,
});

/** One meeting per state, newest first within each group once sorted. */
export const MEETINGS: SessionMeta[] = [
  session('rec', {
    status: 'recording',
    meetCode: 'qrs-tuvw-xyz',
    meetingTitle: 'Client call — Deloitte audit pilot',
    startedAt: NOW - 23 * MIN - 12_000,
    endedAt: undefined,
    durationMs: undefined,
    route: undefined,
    // A healthy recording: the last chunk 3 s ago, Tom speaking now.
    speakers: roll('Marie Curie', 'Tom Martin', 'you').map((s, i) => ({ ...s, lastAt: 23 * MIN - (3 - i) * 20_000 })),
    audio: audio(5.3, { lastChunkAt: NOW - 3000 }),
  }),
  session('route', {
    status: 'awaiting-route',
    meetCode: 'ghi-jklm-nop',
    meetingTitle: 'Point hebdo produit',
    startedAt: NOW - 70 * MIN,
    durationMs: 32 * MIN,
    route: undefined,
    speakers: roll('Camille Martin', 'you', 'Jean-Baptiste Lefèvre'),
    audio: audio(7.4),
  }),
  session('proc', {
    status: 'processing',
    stage: 'transcribing-text',
    meetingTitle: 'Design review — onboarding',
    startedAt: NOW - 3 * HOUR,
    durationMs: 47 * MIN,
    route: 'personal',
    job: { id: 'j1', kind: 'process', startedAt: NOW - 3 * MIN },
    speakers: roll('Ilya K', 'Sofia'),
    audio: audio(38.2),
  }),
  session('saving', {
    status: 'saving',
    stage: 'saving',
    meetingTitle: '1:1 Ilyas / Yasser',
    startedAt: NOW - 4 * HOUR,
    durationMs: 28 * MIN,
    route: 'personal',
    job: { id: 'j2', kind: 'save', startedAt: NOW - 20_000 },
    speakers: roll('you', 'Yasser'),
    audio: audio(6.6),
  }),
  session('saved', {
    status: 'saved',
    meetingTitle: 'Weekly product sync',
    startedAt: NOW - 6 * HOUR,
    durationMs: 58 * MIN,
    savedAt: NOW - 5 * HOUR,
    notion: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Ilyas' },
    speakers: roll('Marie Curie', 'Tom Martin', 'you', 'Sofia'),
    audio: audio(12),
  }),
  session('failed-save', {
    status: 'failed',
    meetCode: 'vwx-yzab-cde',
    meetingTitle: 'Quarterly planning with Lumind, Kera and the Deloitte audit team — follow-up on pricing',
    startedAt: NOW - 25 * HOUR,
    durationMs: 72 * MIN,
    error: 'Notion rejected the token. Copy it again in Settings.',
    speakers: roll('Julien', 'you'),
    audio: audio(16.1),
  }),
  session('dup', {
    status: 'duplicate',
    meetCode: 'xyz-abcd-efg',
    meetingTitle: 'Standup',
    startedAt: NOW - 27 * HOUR,
    durationMs: 14 * MIN,
    notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Yasser' },
    speakers: roll('Tom Martin', 'Sofia', 'you'),
    audio: audio(0, { deletedAt: NOW - HOUR }),
  }),
  session('failed', {
    status: 'failed',
    meetCode: 'mno-pqrs-tuv',
    startedAt: NOW - 28 * HOUR,
    durationMs: 25 * MIN,
    error: 'Gemini is unavailable right now (503). Retrying automatically at 4:52 PM.',
    retryAt: NOW + 10 * MIN,
    attempt: 1,
    speakers: roll('Julien', 'you'),
    audio: audio(8),
  }),
  session('processed', {
    status: 'processed',
    meetingTitle: 'Sales pipeline review',
    startedAt: NOW - 50 * HOUR,
    durationMs: 36 * MIN,
    error: "This database isn't shared with your token. In Notion, open it and choose ••• › Connections.",
    speakers: roll('you', 'Camille Martin'),
    audio: audio(9.8),
  }),
  session('empty', {
    status: 'empty',
    meetCode: 'efg-hijk-lmn',
    startedAt: NOW - 51 * HOUR,
    durationMs: 40_000,
    captionCount: 0,
    audio: audio(0.4),
  }),
  session('ready', {
    status: 'ready',
    meetingTitle: 'All-hands — September',
    startedAt: NOW - 74 * HOUR,
    durationMs: 61 * MIN,
    route: 'personal',
    speakers: roll('Marie Curie', 'Tom Martin', 'Sofia', 'Julien', 'Camille Martin', 'Jean-Baptiste Lefèvre', 'Yasser', 'you'),
    audio: audio(41.5),
  }),
  session('recovered', {
    status: 'ready',
    recovered: true,
    meetCode: 'rst-uvwx-yza',
    startedAt: NOW - 75 * HOUR,
    durationMs: 19 * MIN,
    audio: audio(4.4, { micIncluded: false }),
  }),
];

/** Meetings with a stored transcript. */
export const MEETING_RESULTS: ReadonlySet<string> = new Set(['processed', 'saved', 'failed-save', 'saving']);
