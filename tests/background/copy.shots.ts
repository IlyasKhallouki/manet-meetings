/**
 * The background's words where people read them: the problems it stores on a meeting or
 * answers a request with, rendered by the real popup and Meetings views. Built from
 * entrypoints/background/copy.ts, not from copies of its strings, so the gallery shows
 * what ships. Runs in the visual project: `UI_SHOTS=1 pnpm vitest run --project visual tests/background/copy.shots.ts`.
 */
import { MeetingProblem, problems } from '../../entrypoints/background/copy';
import { NotionError } from '@lib/notion/client';
import { explainError } from '@lib/notion/errors';
import { STOPPED } from '@lib/pipeline/notes';
import { DEFAULT_SETTINGS, missingForSave } from '@lib/settingsSchema';
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import { createDashboardView, type DashboardHandlers, type DashboardView } from '@lib/ui/dashboardView';
import { createPopupView, type PopupModel, type PopupState } from '@lib/ui/popupView';
import dashboardHtml from '../../entrypoints/dashboard/index.html?raw';
import popupHtml from '../../entrypoints/popup/index.html?raw';
import { FMT, gallery, ok, shell, type Shot } from '../visual/harness';
import { NOW, session } from '../visual/scenarios';

const MIN = 60_000;
const HOUR = 60 * MIN;
const OVERLOADED = 'Gemini API error 503 UNAVAILABLE: The model is overloaded. Please try again later.';
/** What sessionManager stores when the settings block saving (Meetings words it itself). */
const MISSING = `Missing settings: ${missingForSave(DEFAULT_SETTINGS, { name: 'Team', databaseId: 'db' }).join(', ')}. Add them in Settings, then try again.`;
/** What a save stores when Notion turns it down (pipeline/save.ts → notion/errors.ts). */
const REJECTED = explainError(new NotionError(401, 'unauthorized', 'API token is invalid.'));

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const roll = (...names: string[]): SpeakerInfo[] =>
  names.map((name, i) => ({ name, self: name === 'Ilyas', firstAt: i * 30_000, lastAt: i * 30_000 + 20_000, talkMs: 20_000 }));

// ---------------------------------------------------------------------------------------
// Popup

type Recording = Extract<PopupState, { kind: 'recording' }>;

function recording(patch: Partial<Recording> = {}): Recording {
  return {
    kind: 'recording',
    sessionId: 'rec',
    startedAt: NOW - 23 * MIN,
    meetCode: 'qrs-tuvw-xyz',
    title: 'Weekly product sync',
    thisTab: true,
    tabId: 1,
    micIncluded: true,
    lastChunkAt: NOW - 2_000,
    captionCount: 0,
    speakers: [],
    ...patch,
  };
}

function popupModel(state: PopupState): PopupModel {
  return {
    state,
    mic: 'granted',
    includeMic: true,
    setup: [],
    profiles: [
      { id: 'team', name: 'Team' },
      { id: 'personal', name: 'Personal' },
    ],
    defaultProfileId: 'team',
    autoTranscribe: true,
    geminiKeyMissing: false,
    recent: [],
    needsYou: 0,
    shortcut: 'Alt+Shift+R',
  };
}

function popup(name: string, state: PopupState, o: { stopFails?: boolean } = {}): Shot {
  return {
    name: `popup-${name}`,
    width: 360,
    height: 120,
    full: true,
    async render() {
      document.documentElement.style.fontSize = '';
      const root = shell(popupHtml);
      const view = createPopupView(
        root,
        {
          record: ok,
          stop: o.stopFails ? () => Promise.reject(new MeetingProblem(problems.noResponse)) : ok,
          setProfile: ok,
          rememberProfile: () => {},
          goToCall: () => {},
          grantMic: () => {},
          openSettings: () => {},
          openDashboard: () => {},
          openNotion: () => {},
        },
        { format: FMT },
      );
      view.update(popupModel(state), NOW);
      if (o.stopFails) {
        await settle(900); // past the Record → Stop guard
        root.querySelector<HTMLButtonElement>('[data-role="hero"] button')!.click();
        await settle(50);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------
// Meetings

const PROBLEM_MEETINGS: SessionMeta[] = [
  session('rec', {
    status: 'recording',
    meetCode: 'qrs-tuvw-xyz',
    meetingTitle: 'Client call — Halstead audit pilot',
    startedAt: NOW - 23 * MIN,
    endedAt: undefined,
    durationMs: undefined,
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 40, bytes: 0, micIncluded: true, error: problems.audioStopped() },
    captionsError: problems.captionsMissing,
  }),
  session('ready', {
    status: 'ready',
    meetingTitle: 'Design review — onboarding',
    startedAt: NOW - 2 * HOUR,
    speakers: roll('Camille Martin', 'Ilyas'),
  }),
  session('retry', {
    status: 'failed',
    meetCode: 'mno-pqrs-tuv',
    startedAt: NOW - 3 * HOUR,
    error: problems.geminiRetrying(OVERLOADED, NOW + 10 * MIN),
    retryAt: NOW + 10 * MIN,
    attempt: 1,
    speakers: roll('Julien', 'Ilyas'),
  }),
  session('gave-up', {
    status: 'failed',
    meetingTitle: 'Point hebdo produit',
    startedAt: NOW - 4 * HOUR,
    error: problems.geminiGaveUp(OVERLOADED, 3),
    attempt: 3,
    speakers: roll('Tom Martin', 'Ilyas'),
  }),
  session('save-start', {
    status: 'failed',
    meetingTitle: 'Sales pipeline review',
    startedAt: NOW - 5 * HOUR,
    error: problems.didNotStart('save'),
    speakers: roll('Sofia', 'Ilyas'),
  }),
  session('kept', {
    status: 'failed',
    meetingTitle: 'Board prep',
    startedAt: NOW - 6 * HOUR,
    error: problems.earlierTranscriptKept,
    speakers: roll('Marie Curie', 'Ilyas'),
  }),
  session('missing', {
    status: 'failed',
    meetingTitle: 'Weekly product sync',
    startedAt: NOW - 7 * HOUR,
    error: MISSING,
    speakers: roll('Marie Curie', 'Tom Martin', 'Ilyas'),
  }),
  session('start', {
    status: 'failed',
    meetingTitle: '1:1 Ilyas / Yasser',
    startedAt: NOW - 8 * HOUR,
    error: problems.transcribingStopped,
    speakers: roll('Yasser', 'Ilyas'),
  }),
  session('again', {
    status: 'failed',
    meetingTitle: 'Roadmap review',
    startedAt: NOW - 9 * HOUR,
    error: problems.transcribingStopped,
    speakers: roll('Sofia', 'Julien', 'Ilyas'),
  }),
  session('rejected', {
    status: 'failed',
    meetingTitle: 'Hiring sync',
    startedAt: NOW - 10 * HOUR,
    error: REJECTED,
    speakers: roll('Marie Curie', 'Ilyas'),
  }),
  session('save-bug', {
    status: 'failed',
    meetingTitle: 'Retro',
    startedAt: NOW - 11 * HOUR,
    error: STOPPED.save,
    speakers: roll('Tom Martin', 'Ilyas'),
  }),
];

const refuse = (message: string) => () => Promise.reject(new MeetingProblem(message));

let current: DashboardView | null = null;

function meetings(name: string, width: number): Shot {
  return {
    name: `dashboard-${name}`,
    width,
    height: 860,
    full: true,
    async render() {
      current?.destroy();
      document.documentElement.style.fontSize = '';
      const root = shell(dashboardHtml);
      const handlers: DashboardHandlers = {
        // A stop that Chrome didn't answer, and a Transcribe for a meeting deleted elsewhere.
        stop: refuse(problems.noResponse),
        transcribe: (id) => (id === 'ready' ? refuse(problems.deleted)() : ok()),
        save: ok,
        remove: ok,
        setProfile: ok,
        setAutoTranscribe: ok,
        openSettings: () => {},
      };
      current = createDashboardView(root, handlers, FMT);
      current.update({
        sessions: PROBLEM_MEETINGS,
        resultIds: new Set(['save-start', 'kept', 'again', 'rejected', 'save-bug']),
        audioOnDisk: new Map(PROBLEM_MEETINGS.map((s) => [s.id, s.audio.bytes])),
        missing: [],
        geminiKeyMissing: false,
        profiles: [
          { id: 'team', name: 'Team' },
          { id: 'personal', name: 'Personal' },
        ],
        autoTranscribe: true,
        retentionDays: 7,
        now: NOW,
      });
      root.querySelector<HTMLElement>('[data-key="rec:primary"]')?.click();
      root.querySelector<HTMLElement>('[data-key="ready:primary"]')?.click();
      await settle(50);
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) throw new Error(`Horizontal overflow at ${width}px: ${doc.scrollWidth}`);
    },
  };
}

gallery('background copy', [
  popup('captions-missing', recording({ captionsError: problems.captionsMissing, speakers: [] })),
  popup('audio-gone', recording({ audioError: problems.audioStopped(), speakers: roll('Marie Curie', 'Tom Martin', 'Ilyas') })),
  popup('stop-failed', recording({ speakers: roll('Marie Curie', 'Ilyas'), captionCount: 20 }), { stopFails: true }),
  meetings('problems', 1280),
  meetings('problems-narrow', 390),
]);
