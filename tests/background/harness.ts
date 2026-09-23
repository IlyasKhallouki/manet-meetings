/**
 * Test harness for the background: WXT's fakeBrowser for storage, tabs, windows,
 * alarms, notifications and the action badge, plus stubs for the chrome APIs it lacks
 * (tabCapture, offscreen, runtime.getContexts, tabs.sendMessage, scripting, commands,
 * action.setIcon, runtime.openOptionsPage).
 *
 * The offscreen document cannot run in Node (it needs a tab-capture MediaStream), so
 * FakeOffscreen answers OffscreenProtocol messages over the fake chrome.runtime, through
 * the real handleMessages/sendToOffscreen code, the way entrypoints/offscreen does:
 * jobs are accepted at once and report back with 'offscreen/job-done', 'job-status'
 * lists them, and audio is never deleted under a running recorder. It only exists once
 * createDocument ran.
 */
import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  errorMessage,
  handleMessages,
  sendToBackground,
  type BackgroundProtocol,
  type JobDone,
  type OffscreenProtocol,
  type RecorderStartResult,
  type RecordingState,
} from '@lib/messages';
import { starterProfiles } from '@lib/profiles';
import { updateSettings } from '@lib/settings';
import { createChromeDeps } from '@/entrypoints/background/chromeDeps';
import {
  backgroundHandlers,
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
  profiles: starterProfiles('team-db', 'personal-db'),
  defaultProfileId: 'team',
};

export async function configure(patch: Partial<Settings> = {}): Promise<void> {
  await updateSettings({ ...FULL_SETTINGS, ...patch });
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The time as the background writes it (hour cycle of the test machine's locale). */
export { clockTime } from '@/entrypoints/background/copy';

export function seg(id: string, speaker: string, tStart: number, text: string, rev = 0): CaptionSegment {
  return { id, speaker, self: false, text, tStart, tEnd: tStart + 2000, rev };
}

/**
 * A canned pipeline result for the job's profile: one turn per caption, or one audio turn
 * when there are none. A job that reuses a stored result gets it back for its profile.
 */
export function resultFor(job: ProcessJob, createdAt: number): SessionResult {
  const profile = { id: job.profile.id, name: job.profile.name };
  if (job.reuse) return { ...job.reuse, profile };
  const turns = job.captions.map((c) => ({ speaker: c.speaker, start: c.tStart, end: c.tEnd, text: c.text }));
  return {
    title: 'Weekly sync',
    attendees: [...new Set(job.captions.map((c) => c.speaker))],
    transcript: {
      turns: turns.length > 0 ? turns : [{ speaker: 'Unknown speaker', start: 0, end: 4000, text: 'Bonjour' }],
      source: 'audio+captions',
      notes: [],
    },
    summary: null,
    transcription: { timingPass: { ok: true }, textPass: { ok: true } },
    profile,
    createdAt,
  };
}

type Call = { [K in keyof OffscreenProtocol]: { type: K; payload: OffscreenProtocol[K]['req'] } }[keyof OffscreenProtocol];

interface RunningJob {
  sessionId: string;
  jobId: string;
  kind: 'process' | 'save';
  /** Settles once the outcome was reported (or the document closed). Null: never reports. */
  done: Promise<void> | null;
  /** The work ended; only the report may still be on its way. */
  finished?: boolean;
}

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
  /** Makes 'offscreen/recorder-status' fail, like a document too busy to answer in time. */
  recorderStatusError: string | null = null;
  /** Makes 'offscreen/recorder-stop' fail while the recorder keeps running. */
  recorderStopError: string | null = null;
  /** Runs inside 'offscreen/recorder-stop' after the recorder stopped, before it answers. */
  onRecorderStop: (sessionId: string) => void | Promise<void> = () => undefined;
  /** Accepted jobs, until their 'offscreen/job-done' was delivered. */
  readonly jobs = new Map<string, RunningJob>();
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
        if (this.recorderStopError) throw new Error(this.recorderStopError);
        this.recording.delete(req.sessionId);
        await this.onRecorderStop(req.sessionId);
        const info = this.audio.get(req.sessionId);
        return { chunkCount: info?.chunkCount ?? 0, bytes: info?.bytes ?? 0 };
      },
      'offscreen/recorder-status': (req) => {
        log('offscreen/recorder-status', req);
        if (this.recorderStatusError) throw new Error(this.recorderStatusError);
        return { recordingSessionIds: [...this.recording] };
      },
      'offscreen/process': (job) => {
        log('offscreen/process', job);
        this.run({ sessionId: job.meta.id, jobId: job.jobId, kind: 'process' }, async () => ({
          kind: 'process',
          outcome: await this.process(job),
        }));
        return { accepted: true };
      },
      'offscreen/save': (job) => {
        log('offscreen/save', job);
        this.run({ sessionId: job.meta.id, jobId: job.jobId, kind: 'save' }, async () => ({
          kind: 'save',
          outcome: await this.save(job),
        }));
        return { accepted: true };
      },
      'offscreen/job-status': (req) => {
        log('offscreen/job-status', req);
        return { jobs: [...this.jobs.values()].map(({ sessionId, jobId, kind }) => ({ sessionId, jobId, kind })) };
      },
      'offscreen/audio-scan': (req) => {
        log('offscreen/audio-scan', req);
        return [...this.audio.values()];
      },
      'offscreen/audio-delete': (req) => {
        log('offscreen/audio-delete', req);
        // Like capture.deleteAudio: never under a running recorder.
        if (this.recording.has(req.sessionId)) {
          throw new Error(`Session ${req.sessionId} is still recording; stop it before deleting its audio`);
        }
        if (this.audioDeleteError) throw new Error(this.audioDeleteError);
        this.audio.delete(req.sessionId);
      },
    });
  }

  /** A job accepted before this test's worker started, still running (it never reports). */
  runningJob(job: Omit<RunningJob, 'done'>): void {
    this.jobs.set(job.jobId, { ...job, done: null });
  }

  /** Waits until every job this document runs reported back. False when there were none. */
  async settle(): Promise<boolean> {
    const running = [...this.jobs.values()].flatMap((j) => (j.done ? [j.done] : []));
    if (running.length === 0) return false;
    await Promise.allSettled(running);
    return true;
  }

  /** The document went away (browser restart, crash): its recorders and jobs die with it. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.open = false;
    this.recording.clear();
    this.jobs.clear();
  }

  private run(
    job: Omit<RunningJob, 'done'>,
    work: () => Promise<Pick<JobDone, 'kind' | 'outcome'>>,
  ): void {
    // Like the real runner (offscreen/jobs.ts): a resent job does not run twice, and a
    // session runs one job at a time.
    if (this.jobs.has(job.jobId)) return;
    const busy = [...this.jobs.values()].find((j) => j.sessionId === job.sessionId && !j.finished);
    if (busy) throw new Error(`Session ${job.sessionId} already has a ${busy.kind} job running (${busy.jobId}); wait for its outcome`);
    const entry: RunningJob = { ...job, done: null };
    this.jobs.set(job.jobId, entry);
    entry.done = (async () => {
      let report: Pick<JobDone, 'kind' | 'outcome'>;
      try {
        report = await work();
      } catch (err) {
        const what = job.kind === 'process' ? 'Processing failed' : 'Saving to Notion failed';
        report = { kind: job.kind, outcome: { status: 'error', error: `${what}: ${errorMessage(err)}` } } as Pick<
          JobDone,
          'kind' | 'outcome'
        >;
      }
      entry.finished = true;
      if (this.jobs.get(job.jobId) !== entry) return; // the document closed meanwhile
      try {
        // Listed until delivered, so a worker restarting meanwhile does not reset the session.
        await sendToBackground('offscreen/job-done', { sessionId: job.sessionId, jobId: job.jobId, ...report } as JobDone);
      } catch {
        // No worker took it; the next one's boot sees the job gone.
      } finally {
        if (this.jobs.get(job.jobId) === entry) this.jobs.delete(job.jobId);
      }
    })();
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

  /** Tabs with no content script listening (opened before an install or update). */
  const noContentScript = new Set<number>();
  const hooks: { onPush: (tabId: number, state: RecordingState | null) => void | Promise<void> } = {
    onPush: () => undefined,
  };

  // The content script's side of 'content/recording-state'.
  vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockImplementation((async (tabId: number, msg: { payload: unknown }) => {
    const tab = await fakeBrowser.tabs.get(tabId);
    if (!tab || noContentScript.has(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
    const state = msg.payload as RecordingState | null;
    pushes.push({ tabId, state });
    await hooks.onPush(tabId, state);
    return { ok: true, value: undefined };
  }) as never);

  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'Manet Meetings',
    version: '0.0.0',
    content_scripts: [{ matches: ['https://meet.google.com/*'], js: ['content-scripts/content.js'] }],
  } as never);
  const executeScript = vi.fn(async (injection: { target: { tabId: number }; files?: string[] }) => {
    const tabId = injection.target.tabId;
    if (!(await fakeBrowser.tabs.get(tabId))) throw new Error(`No tab with id: ${tabId}`);
    noContentScript.delete(tabId);
    return [];
  });
  vi.spyOn(fakeBrowser.scripting, 'executeScript').mockImplementation(executeScript as never);
  const setAccessLevel = vi.fn(async (_opts: unknown) => undefined);
  vi.spyOn(fakeBrowser.storage.local, 'setAccessLevel').mockImplementation(setAccessLevel as never);

  /** The background handlers of the latest manager: one worker at a time answers. */
  let worker: (() => void) | null = null;

  const windowsCreate = vi.spyOn(fakeBrowser.windows, 'create');

  /** The toolbar icon's 16 px path, as last set. */
  const icon: { path: string | null } = { path: null };
  const setIcon = vi.fn(async (details: { path?: string | Record<number, string> }) => {
    const path = details.path;
    icon.path = typeof path === 'string' ? path : (path?.[16] ?? null);
  });
  vi.spyOn(fakeBrowser.action, 'setIcon').mockImplementation(setIcon as never);
  /** The keyboard shortcut Chrome reports for toggle-recording; '' when the user removed it. */
  const shortcut = { value: 'Alt+Shift+R' };
  vi.spyOn(fakeBrowser.commands, 'getAll').mockImplementation((async () => [
    { name: 'toggle-recording', description: 'Start or stop recording the current Meet call', shortcut: shortcut.value },
  ]) as never);
  const openOptionsPage = vi.fn(async () => undefined);
  vi.spyOn(fakeBrowser.runtime, 'openOptionsPage').mockImplementation(openOptionsPage as never);

  return {
    clock,
    offscreen,
    pushes,
    getMediaStreamId,
    createDocument,
    windowsCreate,
    hooks,
    executeScript,
    setAccessLevel,
    setIcon,
    shortcut,
    openOptionsPage,
    /**
     * A session manager over the real chrome deps (fakeBrowser + stubs) and the fake
     * clock. Like a new worker it takes over the background messages, so the offscreen
     * document's job reports reach it. Its idle() also waits for those jobs.
     */
    createManager(overrides: Partial<SessionManagerDeps> = {}): SessionManager {
      const manager = createSessionManager({ ...createChromeDeps(), now: clock.now, ...overrides });
      worker?.();
      worker = handleMessages<BackgroundProtocol>('background', backgroundHandlers(manager));
      return {
        ...manager,
        async idle() {
          do await manager.idle();
          while (await offscreen.settle());
        },
      };
    },
    /**
     * Opens a Meet tab in the fake browser and returns its id. With `contentScript: false`
     * the tab predates the install, so nothing answers 'content/recording-state' in it.
     */
    async openMeetTab(url = MEET_URL, opts: { contentScript?: boolean } = {}): Promise<number> {
      const tab = await fakeBrowser.tabs.create({ url });
      if (opts.contentScript === false) noContentScript.add(tab.id!);
      return tab.id!;
    },
    badge: (): Promise<string> => fakeBrowser.action.getBadgeText({}),
    badgeTitle: (): Promise<string> => fakeBrowser.action.getTitle({}),
    /** 'idle' or 'recording', from the toolbar icon last set; null before any. */
    icon: (): 'idle' | 'recording' | null =>
      icon.path === null ? null : icon.path.includes('rec-') ? 'recording' : 'idle',
    badgeColors: async () => ({
      background: await fakeBrowser.action.getBadgeBackgroundColor({}),
      color: await fakeBrowser.action.getBadgeTextColor({}),
    }),
    notifications: () =>
      Object.entries(fakeBrowser.notifications.getAllCreateOptions()).map(([id, o]) => ({
        id,
        title: o.title ?? '',
        message: o.message ?? '',
      })),
    alarmNames: async () => (await fakeBrowser.alarms.getAll()).map((a) => a.name).sort(),
    /** What each browser.windows.create call asked for. */
    windowsCreated: () => windowsCreate.mock.calls.map(([info]) => info),
  };
}
