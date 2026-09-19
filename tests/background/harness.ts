/**
 * Test harness for the background: WXT's fakeBrowser for storage, tabs, windows,
 * alarms, notifications and the action badge, plus stubs for the chrome APIs it lacks
 * (tabCapture, offscreen, runtime.getContexts, tabs.sendMessage, commands).
 *
 * The offscreen document cannot run in Node (it needs a tab-capture MediaStream), so
 * FakeOffscreen answers OffscreenProtocol messages over the fake chrome.runtime, through
 * the real handleMessages/sendToOffscreen code. It only exists once createDocument ran.
 */
import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleMessages, type OffscreenProtocol, type RecorderStartResult, type RecordingState } from '@lib/messages';
import { updateSettings } from '@lib/settings';
import { createChromeDeps } from '@/entrypoints/background/chromeDeps';
import {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
} from '@/entrypoints/background/sessionManager';
import type {
  AudioSessionInfo,
  CaptionSegment,
  ProcessJob,
  ProcessOutcome,
  SaveJob,
  SaveOutcome,
  SessionResult,
  Settings,
} from '@lib/types';

export const MEET_CODE = 'abc-defg-hij';
export const MEET_URL = `https://meet.google.com/${MEET_CODE}`;
export const T0 = Date.UTC(2026, 8, 19, 9, 0, 0);
export const DAY = 24 * 60 * 60 * 1000;

export function createClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
      return t;
    },
    set(v: number) {
      t = v;
    },
  };
}
export type Clock = ReturnType<typeof createClock>;

export const FULL_SETTINGS: Partial<Settings> = {
  geminiApiKey: 'gemini-key',
  notionToken: 'notion-token',
  notionTeamDbId: 'team-db',
  notionPersonalDbId: 'personal-db',
  displayName: 'Ilyas',
  autoTranscribe: true,
  retentionDays: 7,
};

export async function configure(patch: Partial<Settings> = {}): Promise<void> {
  await updateSettings({ ...FULL_SETTINGS, ...patch });
}

export function seg(id: string, speaker: string, tStart: number, text: string, rev = 0): CaptionSegment {
  return { id, speaker, self: false, text, tStart, tEnd: tStart + 2000, rev };
}

export function resultFor(job: ProcessJob, createdAt: number): SessionResult {
  return {
    title: 'Weekly sync',
    attendees: [...new Set(job.captions.map((c) => c.speaker))],
    transcript: {
      turns: job.captions.map((c) => ({ speaker: c.speaker, start: c.tStart, end: c.tEnd, text: c.text })),
      source: 'audio+captions',
      notes: [],
    },
    summary: null,
    transcription: { timingPass: { ok: true }, textPass: { ok: true } },
    createdAt,
  };
}

type Call = { [K in keyof OffscreenProtocol]: { type: K; payload: OffscreenProtocol[K]['req'] } }[keyof OffscreenProtocol];

export class FakeOffscreen {
  open = false;
  readonly calls: Call[] = [];
  readonly recording = new Set<string>();
  readonly audio = new Map<string, AudioSessionInfo>();
  recorderStart: (
    req: OffscreenProtocol['offscreen/recorder-start']['req'],
  ) => RecorderStartResult | Promise<RecorderStartResult>;
  process: (job: ProcessJob) => ProcessOutcome | Promise<ProcessOutcome>;
  save: (job: SaveJob) => SaveOutcome | Promise<SaveOutcome>;
  audioDeleteError: string | null = null;
  /** Runs inside 'offscreen/recorder-stop' after the recorder stopped, before it answers. */
  onRecorderStop: (sessionId: string) => void | Promise<void> = () => undefined;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly clock: Clock) {
    this.recorderStart = (req) => ({
      ok: true,
      startedAt: this.clock.now() + 150,
      micIncluded: req.includeMic,
      mimeType: 'audio/webm;codecs=opus',
    });
    this.process = (job) => ({ status: 'processed', result: resultFor(job, this.clock.now()) });
    this.save = () => ({ status: 'created', pageId: 'page-1', url: 'https://www.notion.so/page-1' });
  }

  callsOf<K extends keyof OffscreenProtocol>(type: K): OffscreenProtocol[K]['req'][] {
    return this.calls.filter((c) => c.type === type).map((c) => c.payload as OffscreenProtocol[K]['req']);
  }

  /** The document is running (e.g. it survived a service-worker restart). */
  start(): void {
    if (this.unsubscribe) return;
    this.open = true;
    const log = <K extends keyof OffscreenProtocol>(type: K, payload: OffscreenProtocol[K]['req']) =>
      this.calls.push({ type, payload } as Call);
    this.unsubscribe = handleMessages<OffscreenProtocol>('offscreen', {
      'offscreen/recorder-start': async (req) => {
        log('offscreen/recorder-start', req);
        const res = await this.recorderStart(req);
        if (res.ok) this.recording.add(req.sessionId);
        return res;
      },
      'offscreen/recorder-stop': async (req) => {
        log('offscreen/recorder-stop', req);
        this.recording.delete(req.sessionId);
        await this.onRecorderStop(req.sessionId);
        const info = this.audio.get(req.sessionId);
        return { chunkCount: info?.chunkCount ?? 0, bytes: info?.bytes ?? 0 };
      },
      'offscreen/recorder-status': (req) => {
        log('offscreen/recorder-status', req);
        return { recordingSessionIds: [...this.recording] };
      },
      'offscreen/process': (job) => {
        log('offscreen/process', job);
        return this.process(job);
      },
      'offscreen/save': (job) => {
        log('offscreen/save', job);
        return this.save(job);
      },
      'offscreen/audio-scan': (req) => {
        log('offscreen/audio-scan', req);
        return [...this.audio.values()];
      },
      'offscreen/audio-delete': (req) => {
        log('offscreen/audio-delete', req);
        if (this.audioDeleteError) throw new Error(this.audioDeleteError);
        this.audio.delete(req.sessionId);
      },
    });
  }

  /** The document went away (browser restart, crash). */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.open = false;
    this.recording.clear();
  }
}

export type Harness = ReturnType<typeof setupHarness>;

/** Resets fakeBrowser and stubs the chrome APIs it does not implement. Call in beforeEach. */
export function setupHarness() {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  const clock = createClock();
  const offscreen = new FakeOffscreen(clock);
  /** 'content/recording-state' pushes, per tab. */
  const pushes: { tabId: number; state: RecordingState | null }[] = [];
  let streams = 0;

  const getMediaStreamId = vi.fn(async (opts?: { targetTabId?: number }) => `stream-${opts?.targetTabId}-${++streams}`);
  vi.spyOn(fakeBrowser.tabCapture, 'getMediaStreamId').mockImplementation(getMediaStreamId as never);

  const createDocument = vi.fn(async (_params: unknown) => {
    if (offscreen.open) throw new Error('Only a single offscreen document may be created.');
    offscreen.start();
  });
  vi.spyOn(fakeBrowser.offscreen, 'createDocument').mockImplementation(createDocument as never);
  vi.spyOn(fakeBrowser.runtime, 'getContexts').mockImplementation((async () =>
    offscreen.open
      ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: fakeBrowser.runtime.getURL('/offscreen.html') }]
      : []) as never);

  // The content script's side of 'content/recording-state'.
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (tabId: number, msg: { payload: unknown }) => {
    const tab = await fakeBrowser.tabs.get(tabId);
    if (!tab) throw new Error('Could not establish connection. Receiving end does not exist.');
    pushes.push({ tabId, state: msg.payload as RecordingState | null });
    return { ok: true, value: undefined };
  }) as never);

  /** Keep-alive holds taken by background jobs: `held` now, `taken` in total. */
  const keepAlive = { held: 0, taken: 0 };

  const windowsCreate = vi.spyOn(fakeBrowser.windows, 'create');

  return {
    clock,
    offscreen,
    pushes,
    getMediaStreamId,
    createDocument,
    windowsCreate,
    keepAlive,
    /** A session manager over the real chrome deps (fakeBrowser + stubs) and the fake clock. */
    createManager(overrides: Partial<SessionManagerDeps> = {}): SessionManager {
      return createSessionManager({
        ...createChromeDeps(),
        now: clock.now,
        keepAlive: () => {
          keepAlive.held++;
          keepAlive.taken++;
          return () => {
            keepAlive.held--;
          };
        },
        ...overrides,
      });
    },
    /** Opens a Meet tab in the fake browser and returns its id. */
    async openMeetTab(url = MEET_URL): Promise<number> {
      const tab = await fakeBrowser.tabs.create({ url });
      return tab.id!;
    },
    badge: (): Promise<string> => fakeBrowser.action.getBadgeText({}),
    notifications: () =>
      Object.entries(fakeBrowser.notifications.getAllCreateOptions()).map(([id, o]) => ({
        id,
        title: o.title ?? '',
        message: o.message ?? '',
      })),
    alarmNames: async () => (await fakeBrowser.alarms.getAll()).map((a) => a.name).sort(),
  };
}
