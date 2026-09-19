/**
 * Session lifecycle in the background service worker: start → record → finalize →
 * route → process → save, plus recovery after restarts and audio retention.
 *
 * Everything that must outlive the worker is in storage (sessions, captions, results,
 * the active-recording pointer, alarms). Jobs run in the offscreen document, which
 * reports each outcome as its own 'offscreen/job-done' message, so whichever worker is
 * alive by then records it. This object only holds in-flight promises, so a fresh
 * worker rebuilds its view with boot(). Chrome-facing effects go through `deps`.
 */
import { browser } from 'wxt/browser';
import {
  errorMessage,
  type BackgroundProtocol,
  type Handlers,
  type JobDone,
  type OffscreenProtocol,
  type RecordingState,
  type StartResult,
} from '@lib/messages';
import { meetCodeFromUrl } from '@lib/meet/meetCode';
import { missingForSave } from '@lib/settingsSchema';
import { deleteCaptions, loadCaptions, mergeCaptions } from '@lib/storage/captionStore';
import { deleteResult, getResult, putResult } from '@lib/storage/resultStore';
import {
  clearActiveRecording,
  deleteSession,
  getActiveRecording,
  getSession,
  listSessions,
  putSession,
  setActiveRecording,
  updateSession,
  type ActiveRecording,
} from '@lib/storage/sessionStore';
import {
  MAX_TRANSCRIBE_ATTEMPTS,
  type AudioSessionInfo,
  type ExistingMeeting,
  type JobStage,
  type ProcessOutcome,
  type Route,
  type SaveOutcome,
  type SessionMeta,
  type SessionResult,
  type SessionStatus,
  type Settings,
} from '@lib/types';
import { idempotencyKey, sessionId as makeSessionId } from '@lib/util/ids';
import type { OffscreenDocument } from './offscreenDocument';

const TIMESLICE_MS = 5000;
const ROUTE_DELAY_MS = 2 * 60 * 1000;
const ROUTE_ALARM_PREFIX = 'route:';
const RETRY_ALARM_PREFIX = 'retry:';
const RETENTION_ALARM = 'retention';
const RETENTION_PERIOD_MINUTES = 6 * 60;
const WATCHDOG_ALARM = 'recorder-watchdog';
/** Chrome's shortest alarm period (older versions round it up to a minute). */
const WATCHDOG_PERIOD_MINUTES = 0.5;
/** A chunk lands every timeslice; this long without one and the recorder may be gone. */
const STALL_MS = 3 * TIMESLICE_MS;
/** Wait before retrying a transcription Gemini could not take: after attempt 1, then after later ones. */
const RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_MS = 20_000;
/** The document accepts a job at once; this only bounds a wedged one. */
const ACCEPT_TIMEOUT_MS = 30_000;
/** storage.session flag: the OPFS orphan scan ran in this browser session. */
const SCANNED_KEY = 'bootScanned';
/** storage.session: what the content script last reported for a tab. */
const TAB_PREFIX = 'meetTab:';
const NOTIFICATION_PREFIX = 'manet:';
/** `<meetCode>_<YYYYMMDDTHHMMSSZ>`, as built by util/ids sessionId(). */
const SESSION_DIR = /^([a-z]{3}-[a-z]{4}-[a-z]{3})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const CAPTIONS_MISSING = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
const RECORDER_GONE = 'Recording stopped: the recorder is no longer running';

/** 'duplicate' and 'empty' can run again: "Transcribe anyway", or audio that holds more. */
const TRANSCRIBABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);
/** Only with a stored result. */
const SAVABLE = new Set<SessionStatus>(['processed', 'failed', 'duplicate']);
const REROUTABLE = new Set<SessionStatus>(['ready', 'failed', 'processed', 'empty', 'duplicate']);
/** The session's job is in the offscreen document. */
const RUNNING = new Set<SessionStatus>(['processing', 'saving']);

export type SendToOffscreen = <K extends keyof OffscreenProtocol & string>(
  type: K,
  payload: OffscreenProtocol[K]['req'],
) => Promise<OffscreenProtocol[K]['res']>;

export type BadgeState = 'recording' | 'captions-only' | null;

/**
 * How a push to a tab went. 'no-receiver': nothing listens in the tab, i.e. it was open
 * before the extension was installed or updated and has no content script.
 */
export type PushResult = 'delivered' | 'no-receiver' | 'failed';

export interface SessionManagerDeps {
  capture: {
    /** chrome.tabCapture.getMediaStreamId; needs a user invocation of the extension on that tab. */
    getMediaStreamId(tabId: number): Promise<string>;
  };
  offscreen: OffscreenDocument & { send: SendToOffscreen };
  tabs: {
    /** Null when the tab does not exist. */
    get(tabId: number): Promise<{ url?: string } | null>;
    activeTabId(): Promise<number | null>;
    /** Open tabs on https://meet.google.com. */
    meetTabIds(): Promise<number[]>;
    /** Pushes 'content/recording-state', giving up after a few seconds. Never throws. */
    pushRecordingState(tabId: number, state: RecordingState | null): Promise<PushResult>;
    /** Runs the manifest's Meet content script in the tab. */
    injectContentScript(tabId: number): Promise<void>;
    open(url: string): Promise<void>;
  };
  openDashboard(): Promise<void>;
  setBadge(state: BadgeState): Promise<void>;
  openRoutingPrompt(sessionId: string): Promise<void>;
  notify(sessionId: string, title: string, message: string): Promise<void>;
  alarms: {
    create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
    clear(name: string): Promise<void>;
    exists(name: string): Promise<boolean>;
  };
  getSettings(): Promise<Settings>;
  now(): number;
}

type Req<K extends keyof BackgroundProtocol> = BackgroundProtocol[K]['req'];

export interface SessionManager {
  /**
   * Recovery: orphaned recordings, interrupted jobs, lost alarms, retention, and (on the
   * first boot of a browser session, or with `full`) audio in OPFS that has no session.
   * Methods that change sessions wait for the latest boot to finish.
   */
  boot(opts?: { full?: boolean }): Promise<void>;
  start(tabId: number): Promise<StartResult>;
  stop(sessionId: string): Promise<void>;
  /** Keyboard command: stops the current recording, or starts one on `tabId` / the active tab. */
  toggle(tabId?: number): Promise<void>;
  route(sessionId: string, route: Route): Promise<void>;
  /**
   * Hands the process job (then the save) to the offscreen document and resolves once it
   * is accepted, or the session failed. `force` skips the Notion duplicate check.
   */
  transcribe(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  /** Starts the save job for a session with a stored result. `force` saves despite an existing page. */
  save(sessionId: string, opts?: { force?: boolean }): Promise<void>;
  /** Stops the session if it is recording, then deletes its audio, captions, result and meta. */
  remove(sessionId: string): Promise<void>;
  sweepRetention(): Promise<void>;
  /** After an install or update: Meet tabs opened before it get a content script. */
  onInstalled(): Promise<void>;
  onMeetJoined(tabId: number | undefined, req: Req<'meet/joined'>): Promise<RecordingState | null>;
  onMeetLeft(tabId: number | undefined, req: Req<'meet/left'>): Promise<void>;
  onCaptions(req: Req<'captions/batch'>): Promise<void>;
  onRecorderChunk(req: Req<'offscreen/recorder-chunk'>): Promise<void>;
  onRecorderStopped(req: Req<'offscreen/recorder-stopped'>): Promise<void>;
  onJobProgress(req: Req<'offscreen/job-progress'>): Promise<void>;
  onJobDone(req: Req<'offscreen/job-done'>): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  onTabUrlChanged(tabId: number, url: string): Promise<void>;
  onAlarm(name: string): Promise<void>;
  onNotificationClicked(notificationId: string): Promise<void>;
  /** Resolves when every background task started so far has settled. */
  idle(): Promise<void>;
}

interface Counts {
  chunkCount: number;
  bytes: number;
}

type EndCause = { kind: 'ended' } | { kind: 'recorder-stopped'; counts: Counts; error?: string };

interface MeetTab {
  meetCode: string;
  title?: string;
}

type Job = NonNullable<SessionMeta['job']>;

function isForced(meta: SessionMeta): boolean {
  return meta.forced === true;
}

function warn(message: string, err?: unknown): void {
  console.warn(`[manet] ${message}`, err === undefined ? '' : errorMessage(err));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(errorMessage(e)));
      },
    );
  });
}

/** The recorder's own counts win unless it lost track of chunks we saw arrive. */
function withCounts(audio: SessionMeta['audio'], counts: Counts | null): SessionMeta['audio'] {
  if (!counts || counts.chunkCount < audio.chunkCount) return audio;
  return { ...audio, chunkCount: counts.chunkCount, bytes: counts.bytes };
}

function routeAlarm(sessionId: string): string {
  return `${ROUTE_ALARM_PREFIX}${sessionId}`;
}

function retryAlarm(sessionId: string): string {
  return `${RETRY_ALARM_PREFIX}${sessionId}`;
}

function parseSessionDir(name: string): { meetCode: string; startedAt: number } | null {
  const m = SESSION_DIR.exec(name);
  if (!m) return null;
  const [, meetCode, y, mo, d, h, mi, s] = m.map(String) as [string, string, string, string, string, string, string, string];
  return { meetCode, startedAt: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
}

function label(meta: SessionMeta): string {
  return meta.meetingTitle || `Meet ${meta.meetCode}`;
}

/** Local HH:MM. */
function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Whether `name` (as Notion's "Recorded by" has it) is the user's own display name. */
function isSelf(name: string | undefined, settings: Settings): boolean {
  const own = settings.displayName.trim().toLowerCase();
  return own !== '' && name?.trim().toLowerCase() === own;
}

/** A re-run that lost what the previous result had (Gemini failing, audio gone). */
function worseThan(previous: SessionResult | null, next: SessionResult): boolean {
  if (!previous) return false;
  const lostAudio = previous.transcript.source !== 'captions-only' && next.transcript.source === 'captions-only';
  const lostTurns = previous.transcript.turns.length > 0 && next.transcript.turns.length === 0;
  return lostAudio || lostTurns;
}

function failureReason(result: SessionResult): string {
  const passes = result.transcription;
  if (passes && !passes.timingPass.ok) return passes.timingPass.error;
  if (passes && !passes.textPass.ok) return passes.textPass.error;
  return result.transcript.notes[0] ?? 'no audio transcript';
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const finalizing = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  const startingIds = new Set<string>();
  /** Sessions whose job this worker is handing to the offscreen document right now. */
  const launching = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let booting: Promise<void> = Promise.resolve();
  /** Starts, ends and removals of recordings run one at a time, in call order. */
  let lifecycle: Promise<unknown> = Promise.resolve();
  let fullBootDone = false;
  let watchdog: Promise<void> | null = null;
  let lastWatchdogRun = -Infinity;

  const ready = () => booting;

  function track(p: Promise<unknown>): void {
    const t: Promise<unknown> = p
      .catch((err: unknown) => warn('Background task failed:', err))
      .finally(() => pending.delete(t));
    pending.add(t);
  }

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = lifecycle.then(fn);
    lifecycle = run.catch(() => undefined);
    return run;
  }

  async function notify(meta: SessionMeta, message: string): Promise<void> {
    try {
      await deps.notify(meta.id, label(meta), message);
    } catch (err) {
      warn('Notification failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Tabs the content script told us about
  // -------------------------------------------------------------------------

  async function rememberTab(tabId: number, tab: MeetTab): Promise<void> {
    const key = `${TAB_PREFIX}${tabId}`;
    const prev = (await browser.storage.session.get(key))[key] as MeetTab | undefined;
    const title = tab.title ?? (prev?.meetCode === tab.meetCode ? prev.title : undefined);
    await browser.storage.session.set({ [key]: { meetCode: tab.meetCode, ...(title ? { title } : {}) } });
  }

  async function rememberedTab(tabId: number): Promise<MeetTab | null> {
    const key = `${TAB_PREFIX}${tabId}`;
    return ((await browser.storage.session.get(key))[key] as MeetTab | undefined) ?? null;
  }

  async function tabOnCall(active: ActiveRecording): Promise<boolean> {
    const tab = await deps.tabs.get(active.tabId);
    return !!tab?.url && meetCodeFromUrl(tab.url) === active.meetCode;
  }

  /**
   * Tells the tab to capture captions, first giving it a content script if it has none.
   * Runs inside the start, so no retry can land after a later stop's push.
   */
  async function pushState(tabId: number, id: string, state: RecordingState): Promise<void> {
    let pushed = await deps.tabs.pushRecordingState(tabId, state);
    // The page asked with meet/joined while we started and got nothing: it must get this.
    if (pushed === 'failed') pushed = await deps.tabs.pushRecordingState(tabId, state);
    if (pushed !== 'no-receiver') return;
    let reached = false;
    try {
      await deps.tabs.injectContentScript(tabId);
      reached = (await deps.tabs.pushRecordingState(tabId, state)) !== 'no-receiver';
    } catch (err) {
      warn(`Could not add the content script to tab ${tabId}:`, err);
    }
    if (!reached) {
      await updateSession(id, (m) => (m.status === 'recording' ? { ...m, captionsError: CAPTIONS_MISSING } : m));
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  function start(tabId: number): Promise<StartResult> {
    // A second click sees the first recording and answers from it; a stop waits for the
    // start in flight, so it stops the recorder that started.
    return serial(() => startRecording(tabId));
  }

  async function startRecording(tabId: number): Promise<StartResult> {
    await ready();
    const active = await getActiveRecording();
    if (active) {
      const current = await getSession(active.sessionId);
      if (current?.status === 'recording') {
        return active.tabId === tabId
          ? { ok: true, sessionId: active.sessionId }
          : { ok: false, error: 'Already recording another meeting. Stop it first.' };
      }
      await clearActiveRecording();
    }

    const tab = await deps.tabs.get(tabId);
    const meetCode = tab?.url ? meetCodeFromUrl(tab.url) : null;
    if (!meetCode) return { ok: false, error: 'This tab is not a Google Meet call.' };

    const settings = await deps.getSettings();
    const requestedAt = deps.now();
    // Ids have one-second resolution and name the OPFS directory: never reuse one.
    let idTime = requestedAt;
    while (await getSession(makeSessionId(meetCode, idTime))) idTime += 1000;
    const id = makeSessionId(meetCode, idTime);
    startingIds.add(id);
    try {
      // The stream id is only granted right after the user invoked us, and expires quickly.
      let streamId: string | null = null;
      let audioError: string | undefined;
      try {
        streamId = await deps.capture.getMediaStreamId(tabId);
      } catch (err) {
        audioError = `Tab audio capture failed: ${errorMessage(err)}`;
      }

      const known = await rememberedTab(tabId);
      const title = known?.meetCode === meetCode ? known.title : undefined;
      // Meta and pointer exist before audio does, so a crash from here on is recoverable.
      await putSession({
        id,
        meetCode,
        ...(title ? { meetingTitle: title } : {}),
        startedAt: requestedAt,
        status: 'recording',
        idempotencyKey: idempotencyKey(meetCode, requestedAt),
        audio: { mimeType: '', chunkCount: 0, bytes: 0, micIncluded: false },
        captionCount: 0,
      });
      await setActiveRecording({ sessionId: id, tabId, meetCode });

      if (streamId) audioError = await startRecorder(id, streamId, settings.includeMic);
      const meta = await updateSession(id, (m) =>
        audioError && m.status === 'recording' ? { ...m, audio: { ...m.audio, error: audioError } } : m,
      );
      if (!meta || meta.status !== 'recording' || (await getActiveRecording())?.sessionId !== id) {
        // Ended or deleted meanwhile: nothing may keep recording for it.
        if (!audioError) await stopRecorder(id);
        return { ok: false, error: 'The recording was stopped while it was starting.' };
      }

      await deps.setBadge(meta.audio.error ? 'captions-only' : 'recording');
      if (!meta.audio.error) await armWatchdog();
      await pushState(tabId, id, { sessionId: id, startedAt: meta.startedAt });
      return { ok: true, sessionId: id };
    } finally {
      startingIds.delete(id);
    }
  }

  /** Returns an error message, or undefined once the recorder runs and t = 0 is known. */
  async function startRecorder(id: string, streamId: string, includeMic: boolean): Promise<string | undefined> {
    try {
      await deps.offscreen.ensure();
      const res = await deps.offscreen.send('offscreen/recorder-start', {
        sessionId: id,
        streamId,
        timesliceMs: TIMESLICE_MS,
        includeMic,
      });
      if (!res.ok) return `Recorder failed to start: ${res.error}`;
      await updateSession(id, (m) =>
        m.status === 'recording'
          ? {
              ...m,
              startedAt: res.startedAt,
              idempotencyKey: idempotencyKey(m.meetCode, res.startedAt),
              audio: { ...m.audio, mimeType: res.mimeType, micIncluded: res.micIncluded },
            }
          : m,
      );
      return undefined;
    } catch (err) {
      return `Recorder failed to start: ${errorMessage(err)}`;
    }
  }

  async function stopRecorder(id: string): Promise<Counts | null> {
    try {
      return await withTimeout(deps.offscreen.send('offscreen/recorder-stop', { sessionId: id }), STOP_TIMEOUT_MS, 'Recorder stop');
    } catch (err) {
      warn(`Could not stop the recorder for ${id}:`, err);
      return null;
    }
  }

  /**
   * Clears the pointer, badge and watchdog, and tells the tab to stop capturing. With
   * `waitForTab` false the push is not awaited: the page's reply can depend on a
   * caption batch, and boot must never wait on a page.
   */
  async function releaseActive(active: ActiveRecording, waitForTab = true): Promise<void> {
    await clearActiveRecording();
    await deps.alarms.clear(WATCHDOG_ALARM);
    await deps.setBadge(null);
    const push = deps.tabs.pushRecordingState(active.tabId, null);
    if (waitForTab) await push;
    else track(push);
  }

  /** Ends a recording exactly once, however many end signals arrive. */
  function finalize(id: string, cause: EndCause): Promise<void> {
    if (deleting.has(id)) return Promise.resolve();
    let run = finalizing.get(id);
    if (!run) {
      run = serial(() => endRecording(id, cause)).finally(() => finalizing.delete(id));
      finalizing.set(id, run);
    }
    return run;
  }

  async function endRecording(id: string, cause: EndCause): Promise<void> {
    const meta = await getSession(id);
    const active = await getActiveRecording();
    const isActive = active?.sessionId === id;
    if (!meta || meta.status !== 'recording') {
      if (active && isActive) await releaseActive(active);
      return;
    }

    let counts: Counts | null = cause.kind === 'recorder-stopped' ? cause.counts : null;
    if (cause.kind === 'ended' && !meta.audio.error) counts = await stopRecorder(id);
    const endedAt = deps.now();
    if (active && isActive) await releaseActive(active);

    const recorderError = cause.kind === 'recorder-stopped' ? cause.error : undefined;
    let ended = false;
    await updateSession(id, (m) => {
      if (m.status !== 'recording') return m;
      ended = true;
      const audio = withCounts(m.audio, counts);
      return {
        ...m,
        status: 'awaiting-route',
        endedAt,
        durationMs: Math.max(0, endedAt - m.startedAt),
        audio: recorderError && !audio.error ? { ...audio, error: recorderError } : audio,
      };
    });
    if (ended) await askForRoute(id, endedAt + ROUTE_DELAY_MS);
  }

  /** The alarm first: it routes the meeting (to the default) even if the prompt never shows. */
  async function askForRoute(id: string, when: number): Promise<void> {
    await deps.alarms.create(routeAlarm(id), { when });
    try {
      await deps.openRoutingPrompt(id);
    } catch (err) {
      warn('Could not open the routing prompt:', err);
    }
  }

  /**
   * The audio stopped mid-call: the session keeps recording captions only, and ends like
   * any other, on leave, tab close or Stop.
   */
  async function degradeAudio(id: string, error: string): Promise<void> {
    let changed = false;
    const meta = await updateSession(id, (m) => {
      if (m.status !== 'recording' || m.audio.error) return m;
      changed = true;
      return { ...m, audio: { ...m.audio, error } };
    });
    if (!meta || !changed) return;
    if ((await getActiveRecording())?.sessionId === id) {
      await deps.alarms.clear(WATCHDOG_ALARM);
      await deps.setBadge('captions-only');
    }
    await notify(meta, `${error}. Captions are still being recorded.`);
  }

  // -------------------------------------------------------------------------
  // Recorder watchdog
  // -------------------------------------------------------------------------

  async function armWatchdog(): Promise<void> {
    if (!(await deps.alarms.exists(WATCHDOG_ALARM))) {
      await deps.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES });
    }
  }

  /** Whether the offscreen document still records `id`. An unanswered query counts as yes. */
  async function recorderAlive(id: string): Promise<boolean> {
    let open: boolean;
    try {
      open = await deps.offscreen.exists();
    } catch {
      return true;
    }
    if (!open) return false;
    try {
      const status = await withTimeout(deps.offscreen.send('offscreen/recorder-status', {}), STATUS_TIMEOUT_MS, 'Recorder status');
      return status.recordingSessionIds.includes(id);
    } catch (err) {
      warn('Recorder status unavailable:', err);
      return true;
    }
  }

  /**
   * A dead offscreen document sends no 'recorder-stopped', so a recording whose chunks
   * stopped coming is checked against the recorder. Caption batches call this often:
   * `throttle` limits them to one check per timeslice.
   */
  function checkRecorder(throttle: boolean): Promise<void> {
    if (watchdog) return watchdog;
    const now = deps.now();
    if (throttle && now - lastWatchdogRun < TIMESLICE_MS) return Promise.resolve();
    lastWatchdogRun = now;
    watchdog = runWatchdog().finally(() => {
      watchdog = null;
    });
    return watchdog;
  }

  async function runWatchdog(): Promise<void> {
    const active = await getActiveRecording();
    if (active && (startingIds.has(active.sessionId) || finalizing.has(active.sessionId))) return;
    const meta = active ? await getSession(active.sessionId) : null;
    if (!meta || meta.status !== 'recording' || meta.audio.error) {
      await deps.alarms.clear(WATCHDOG_ALARM);
      return;
    }
    if (deps.now() - (meta.audio.lastChunkAt ?? meta.startedAt) <= STALL_MS) return;
    if (!(await recorderAlive(meta.id))) await degradeAudio(meta.id, RECORDER_GONE);
  }

  // -------------------------------------------------------------------------
  // Routing and jobs
  // -------------------------------------------------------------------------

  async function applyRoute(id: string, route: Route, explicit: boolean): Promise<void> {
    let routed = false;
    const meta = await updateSession(id, (m) => {
      if (m.status === 'awaiting-route') {
        routed = true;
        return { ...m, route, status: 'ready' };
      }
      if (!explicit) return m;
      if (REROUTABLE.has(m.status)) return { ...m, route };
      throw new Error(`Cannot route a session that is ${m.status}.`);
    });
    if (!meta) {
      if (explicit) throw new Error(`Unknown session ${id}.`);
      return;
    }
    if (routed || explicit) await deps.alarms.clear(routeAlarm(id));
    if (routed && (await deps.getSettings()).autoTranscribe) {
      await transcribeNow(id).catch((err: unknown) => warn('Auto-transcribe failed:', err));
    }
  }

  async function applyDefaultRoute(id: string): Promise<void> {
    await applyRoute(id, (await deps.getSettings()).defaultRoute, false);
  }

  /** Applies `update` only while `jobId` is the session's job. Null when it is not (any more). */
  async function updateJob(id: string, jobId: string, update: (m: SessionMeta) => SessionMeta): Promise<SessionMeta | null> {
    let applied = false;
    const meta = await updateSession(id, (m) => {
      if (m.job?.id !== jobId) return m;
      applied = true;
      return update(m);
    });
    return applied ? meta : null;
  }

  async function failJob(id: string, jobId: string, error: string): Promise<void> {
    const meta = await updateJob(id, jobId, (m) => ({ ...m, status: 'failed', stage: undefined, job: undefined, error }));
    if (meta) await notify(meta, error);
  }

  async function markMissingSettings(id: string, missing: string[]): Promise<void> {
    const error = `Missing settings: ${missing.join(', ')}. Add them in Settings, then try again.`;
    let changed = false;
    const meta = await updateSession(id, (m) => {
      if (RUNNING.has(m.status)) return m;
      changed = true;
      return { ...m, status: 'failed', stage: undefined, job: undefined, error };
    });
    if (meta && changed) await notify(meta, error);
  }

  /**
   * Hands a job to the offscreen document. Its outcome arrives as 'offscreen/job-done';
   * if the document never accepted it, the session fails with the reason.
   */
  async function launch(id: string, jobId: string, what: string, send: () => Promise<unknown>): Promise<void> {
    launching.add(id);
    try {
      await deps.offscreen.ensure();
      await withTimeout(send(), ACCEPT_TIMEOUT_MS, 'The offscreen document');
    } catch (err) {
      await failJob(id, jobId, `${what}: ${errorMessage(err)}`);
    } finally {
      launching.delete(id);
    }
  }

  function newJob(kind: Job['kind']): Job {
    return { id: crypto.randomUUID(), kind, startedAt: deps.now() };
  }

  /**
   * Starts processing (then saving) unless the session's job is already running. `attempt`
   * counts automatic retries after Gemini was unreachable; a user's Transcribe is attempt 1.
   */
  async function transcribeNow(id: string, opts: { force?: boolean; attempt?: number } = {}): Promise<void> {
    const meta = await getSession(id);
    if (!meta) throw new Error(`Unknown session ${id}.`);
    if (RUNNING.has(meta.status)) return;
    if (!TRANSCRIBABLE.has(meta.status)) throw new Error(`Cannot transcribe a session that is ${meta.status}.`);
    await deps.alarms.clear(routeAlarm(id));
    await deps.alarms.clear(retryAlarm(id));
    const settings = await deps.getSettings();
    const route = meta.route ?? settings.defaultRoute;
    const missing = missingForSave(settings, route);
    if (missing.length > 0) {
      await markMissingSettings(id, missing);
      return;
    }

    const job = newJob('process');
    const attempt = opts.attempt ?? 1;
    let claimed = false;
    const processing = await updateSession(id, (m) => {
      if (!TRANSCRIBABLE.has(m.status)) return m;
      claimed = true;
      const next: SessionMeta = {
        ...m,
        status: 'processing',
        route,
        stage: undefined,
        error: undefined,
        job,
        attempt,
        retryAt: undefined,
        // Audio a duplicate or empty session was due to lose is needed again.
        purgeAudioAt: undefined,
        forced: opts.force || isForced(m) || undefined,
      };
      return next;
    });
    if (!claimed || !processing) return;

    const force = isForced(processing);
    await launch(id, job.id, 'Processing failed', async () => {
      const captions = await loadCaptions(id);
      await deps.offscreen.send('offscreen/process', {
        jobId: job.id,
        meta: processing,
        captions,
        settings,
        route,
        attempt,
        ...(force ? { force } : {}),
      });
    });
  }

  /** Starts the save job for a session with a stored result, unless a job is running. */
  async function saveNow(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const [meta, result] = await Promise.all([getSession(id), getResult(id)]);
    if (!meta || !result || RUNNING.has(meta.status)) return;
    const settings = await deps.getSettings();
    const route = meta.route ?? settings.defaultRoute;
    const missing = missingForSave(settings, route);
    if (missing.length > 0) {
      await markMissingSettings(id, missing);
      return;
    }

    const job = newJob('save');
    let claimed = false;
    const saving = await updateSession(id, (m) => {
      if (!SAVABLE.has(m.status)) return m;
      claimed = true;
      const next: SessionMeta = {
        ...m,
        status: 'saving',
        stage: 'saving',
        route,
        error: undefined,
        job,
        retryAt: undefined,
        forced: opts.force || isForced(m) || undefined,
      };
      return next;
    });
    if (!claimed || !saving) return;

    const force = isForced(saving);
    await launch(id, job.id, 'Saving to Notion failed', () =>
      deps.offscreen.send('offscreen/save', { jobId: job.id, meta: saving, result, settings, route, ...(force ? { force } : {}) }),
    );
  }

  async function saveJob(id: string, force?: boolean): Promise<void> {
    const meta = await getSession(id);
    if (!meta) throw new Error(`Unknown session ${id}.`);
    if (RUNNING.has(meta.status)) return;
    if (!SAVABLE.has(meta.status) || !(await getResult(id))) {
      throw new Error(`Nothing to save for a session that is ${meta.status}: transcribe it first.`);
    }
    await deps.alarms.clear(retryAlarm(id));
    await saveNow(id, { force });
  }

  async function markDuplicate(id: string, jobId: string, existing: ExistingMeeting): Promise<void> {
    const settings = await deps.getSettings();
    // Our own earlier page may hold only part of the meeting (a rejoin, a reload): keep
    // the audio until the user decides. A teammate's page covers it, so ours follows retention.
    const self = isSelf(existing.recordedBy, settings);
    const now = deps.now();
    const meta = await updateJob(id, jobId, (m) => ({
      ...m,
      status: 'duplicate',
      stage: undefined,
      error: undefined,
      job: undefined,
      notion: { pageId: existing.pageId, url: existing.url, recordedBy: existing.recordedBy },
      purgeAudioAt: self ? undefined : now + settings.retentionDays * DAY_MS,
    }));
    if (!meta) return;
    await notify(
      meta,
      self
        ? 'You already saved part of this meeting — open the dashboard to save this recording too'
        : `Already in Notion — recorded by ${existing.recordedBy || 'a teammate'}`,
    );
  }

  async function processDone(meta: SessionMeta, jobId: string, outcome: ProcessOutcome): Promise<void> {
    const id = meta.id;
    switch (outcome.status) {
      case 'processed':
        await processed(id, jobId, outcome.result);
        return;
      case 'duplicate':
        await markDuplicate(id, jobId, outcome.existing);
        return;
      case 'retry-later':
        await scheduleRetry(meta, jobId, outcome.error);
        return;
      case 'error':
        await failJob(id, jobId, outcome.error);
        return;
    }
  }

  async function processed(id: string, jobId: string, result: SessionResult): Promise<void> {
    const previous = await getResult(id);
    if (worseThan(previous, result)) {
      await failJob(
        id,
        jobId,
        `Transcribing again failed (${failureReason(result)}), so the previous transcript was kept. Save it, or transcribe again later.`,
      );
      return;
    }
    await putResult(id, result);

    if (result.transcript.turns.length === 0) {
      // Filing it would claim the day's dedupe key for everyone, over nothing.
      const settings = await deps.getSettings();
      const now = deps.now();
      const empty = await updateJob(id, jobId, (m) => ({
        ...m,
        status: 'empty',
        stage: undefined,
        error: undefined,
        job: undefined,
        purgeAudioAt: now + settings.retentionDays * DAY_MS,
      }));
      if (empty) await notify(empty, 'Nothing was said or captured, so this recording was not saved to Notion.');
      else if (!(await getSession(id))) await deleteResult(id);
      return;
    }

    const done = await updateJob(id, jobId, (m) => ({ ...m, status: 'processed', stage: undefined, error: undefined, job: undefined }));
    if (!done) {
      if (!(await getSession(id))) await deleteResult(id);
      return;
    }
    await saveNow(id);
  }

  async function scheduleRetry(meta: SessionMeta, jobId: string, error: string): Promise<void> {
    const attempt = meta.attempt ?? 1;
    if (attempt >= MAX_TRANSCRIBE_ATTEMPTS) {
      await failJob(meta.id, jobId, `Gemini unreachable: ${error}.`);
      return;
    }
    const retryAt = deps.now() + RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
    const message = `Gemini unreachable: ${error}. Retrying automatically at ${clockTime(retryAt)}.`;
    const failed = await updateJob(meta.id, jobId, (m) => ({
      ...m,
      status: 'failed',
      stage: undefined,
      job: undefined,
      error: message,
      retryAt,
    }));
    if (!failed) return;
    await deps.alarms.create(retryAlarm(meta.id), { when: retryAt });
    await notify(failed, message);
  }

  async function saveDone(meta: SessionMeta, jobId: string, outcome: SaveOutcome): Promise<void> {
    const id = meta.id;
    switch (outcome.status) {
      case 'created': {
        const settings = await deps.getSettings();
        const { pageId, url } = outcome;
        const savedAt = deps.now();
        const saved = await updateJob(id, jobId, (m) => ({
          ...m,
          status: 'saved',
          stage: undefined,
          error: undefined,
          job: undefined,
          notion: { pageId, url, recordedBy: settings.displayName },
          savedAt,
          purgeAudioAt: savedAt + settings.retentionDays * DAY_MS,
        }));
        if (saved) await notify(saved, 'Saved to Notion.');
        return;
      }
      case 'duplicate':
        await markDuplicate(id, jobId, outcome.existing);
        return;
      case 'error':
        // The result stays in storage so Save can retry without transcribing again.
        await failJob(id, jobId, outcome.error);
        return;
    }
  }

  async function onJobDone(done: JobDone): Promise<void> {
    const meta = await getSession(done.sessionId);
    // Deleted, reset after a restart, or superseded by a newer job: not ours to record.
    if (!meta || meta.job?.id !== done.jobId || deleting.has(meta.id)) return;
    if (done.kind === 'process') await processDone(meta, done.jobId, done.outcome);
    else await saveDone(meta, done.jobId, done.outcome);
  }

  async function retryTranscription(id: string): Promise<void> {
    const meta = await getSession(id);
    // A manual Transcribe or Save, or a deletion, got there first.
    if (meta?.status !== 'failed' || meta.retryAt === undefined) return;
    await transcribeNow(id, { attempt: (meta.attempt ?? 1) + 1 });
  }

  async function removeSession(id: string): Promise<void> {
    deleting.add(id);
    try {
      const meta = await getSession(id);
      const active = await getActiveRecording();
      if (meta?.status === 'recording' && !meta.audio.error && !(await stopRecorder(id))) {
        // Leave it recording, as it is, rather than half deleted under a live recorder.
        if (await recorderAlive(id)) throw new Error('Could not stop the recording. Try again.');
      }
      if (active?.sessionId === id) await releaseActive(active);
      await deps.alarms.clear(routeAlarm(id));
      await deps.alarms.clear(retryAlarm(id));
      // Audio goes first: an audio directory without a session would be adopted at next boot.
      await deps.offscreen.ensure();
      await deps.offscreen.send('offscreen/audio-delete', { sessionId: id });
      await deleteCaptions(id);
      await deleteResult(id);
      await deleteSession(id);
    } finally {
      deleting.delete(id);
    }
  }

  async function sweep(): Promise<void> {
    const now = deps.now();
    for (const meta of await listSessions()) {
      if (meta.purgeAudioAt === undefined || meta.purgeAudioAt > now || meta.audio.deletedAt !== undefined) continue;
      // Captions and results stay: they are the only local copy of the meeting.
      if (RUNNING.has(meta.status) || meta.status === 'recording' || deleting.has(meta.id)) continue;
      try {
        await deps.offscreen.ensure();
        await deps.offscreen.send('offscreen/audio-delete', { sessionId: meta.id });
        await updateSession(meta.id, (m) => ({ ...m, audio: { ...m.audio, deletedAt: now } }));
      } catch (err) {
        warn(`Could not delete the audio of ${meta.id}; will retry:`, err);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /** Session ids the offscreen recorder reports, or null when it could not say. */
  async function recorderIds(docOpen: boolean): Promise<string[] | null> {
    if (!docOpen) return [];
    try {
      const status = await withTimeout(deps.offscreen.send('offscreen/recorder-status', {}), STATUS_TIMEOUT_MS, 'Recorder status');
      return status.recordingSessionIds;
    } catch (err) {
      warn('Recorder status unavailable:', err);
      return null;
    }
  }

  async function isStillRecording(meta: SessionMeta, active: ActiveRecording, recording: string[] | null): Promise<boolean> {
    // Captions-only: alive while its tab is still on the call.
    if (meta.audio.error) return tabOnCall(active);
    // Only a recorder positively gone ends it; an unanswered status query proves nothing.
    return recording === null || recording.includes(meta.id);
  }

  /**
   * Ends recordings that died with the worker or the browser, and asks where each goes:
   * routing is the user's call even after a crash. Returns the ids it ended.
   */
  async function recoverRecordings(docOpen: boolean): Promise<string[]> {
    // Sessions being started or finalized by this worker are not orphans.
    const busy = (id: string) => startingIds.has(id) || finalizing.has(id);
    const recording = (await listSessions()).filter((s) => s.status === 'recording' && !busy(s.id));
    const active = await getActiveRecording();

    const running = await recorderIds(docOpen);
    // A recorder nothing points at would run until the browser closes.
    for (const id of running ?? []) if (id !== active?.sessionId && !busy(id)) await stopRecorder(id);

    const recovered: string[] = [];
    let activeMeta: SessionMeta | null = null;
    const now = deps.now();
    for (const s of recording) {
      if (active?.sessionId === s.id && (await isStillRecording(s, active, running))) {
        activeMeta = s;
        continue;
      }
      const endedAt = s.lastHeartbeat ?? s.startedAt;
      let changed = false;
      await updateSession(s.id, (m) => {
        if (m.status !== 'recording') return m;
        changed = true;
        return { ...m, status: 'awaiting-route', recovered: true, endedAt, durationMs: Math.max(0, endedAt - m.startedAt) };
      });
      if (!changed) continue;
      recovered.push(s.id);
      await askForRoute(s.id, now + ROUTE_DELAY_MS);
    }

    if (active && !busy(active.sessionId)) {
      if (activeMeta) {
        await deps.setBadge(activeMeta.audio.error ? 'captions-only' : 'recording');
        if (!activeMeta.audio.error) await armWatchdog();
      } else {
        await releaseActive(active, false);
      }
    }
    return recovered;
  }

  /** Job ids the offscreen document is running, or null when it could not say. */
  async function runningJobs(docOpen: boolean): Promise<Set<string> | null> {
    if (!docOpen) return new Set();
    try {
      const { jobs } = await withTimeout(deps.offscreen.send('offscreen/job-status', {}), STATUS_TIMEOUT_MS, 'Job status');
      return new Set(jobs.map((j) => j.jobId));
    } catch (err) {
      warn('Job status unavailable:', err);
      return null;
    }
  }

  interface Interrupted {
    id: string;
    kind: 'process' | 'save';
    attempt: number;
  }

  /**
   * Sessions whose job died with the offscreen document go back to where a retry starts;
   * jobs still running there will report back. Returns the sessions it reset.
   */
  async function resetInterruptedJobs(docOpen: boolean): Promise<Interrupted[]> {
    const stuck = (await listSessions()).filter((s) => RUNNING.has(s.status) && !launching.has(s.id));
    if (stuck.length === 0) return [];
    const running = await runningJobs(docOpen);
    // Unknown: leave them; the next worker start asks again.
    if (!running) return [];

    const reset: Interrupted[] = [];
    for (const s of stuck) {
      if (s.job && running.has(s.job.id)) continue;
      const hasResult = s.status === 'saving' && (await getResult(s.id)) !== null;
      const next: SessionStatus = hasResult ? 'processed' : 'ready';
      let changed = false;
      await updateSession(s.id, (m) => {
        if (m.status !== s.status || m.job?.id !== s.job?.id) return m;
        changed = true;
        return { ...m, status: next, stage: undefined, job: undefined };
      });
      if (!changed) continue;
      if (s.status === 'processing') reset.push({ id: s.id, kind: 'process', attempt: s.attempt ?? 1 });
      else if (hasResult) reset.push({ id: s.id, kind: 'save', attempt: s.attempt ?? 1 });
    }
    return reset;
  }

  /**
   * Route and retry alarms, and the routing prompt window, can be lost with the browser.
   * Within a browser session alarms persist, so a missing one has just fired (its event
   * is on its way): apply what it would.
   */
  async function restoreAlarms(newBrowserSession: boolean): Promise<void> {
    const now = deps.now();
    for (const s of await listSessions()) {
      if (finalizing.has(s.id)) continue;
      if (s.status === 'awaiting-route' && !(await deps.alarms.exists(routeAlarm(s.id)))) {
        const due = (s.endedAt ?? now) + ROUTE_DELAY_MS;
        if (!newBrowserSession && due <= now) await applyDefaultRoute(s.id);
        // Lost, or never armed (the worker died while ending it): the prompt may never have shown.
        else await askForRoute(s.id, now + ROUTE_DELAY_MS);
      } else if (s.status === 'failed' && s.retryAt !== undefined && !(await deps.alarms.exists(retryAlarm(s.id)))) {
        if (s.retryAt > now) await deps.alarms.create(retryAlarm(s.id), { when: s.retryAt });
        else track(retryTranscription(s.id));
      }
    }
  }

  /** Creates sessions for OPFS audio that has none (e.g. the worker died before saving it). */
  async function adoptOrphanAudio(settings: Settings, recovered: string[]): Promise<void> {
    let infos: AudioSessionInfo[];
    try {
      await deps.offscreen.ensure();
      infos = await withTimeout(deps.offscreen.send('offscreen/audio-scan', {}), SCAN_TIMEOUT_MS, 'Audio scan');
    } catch (err) {
      warn('Audio scan failed:', err);
      return;
    }
    const known = new Set((await listSessions()).map((s) => s.id));
    for (const info of infos) {
      const counts = { chunkCount: info.chunkCount, bytes: info.bytes };
      if (known.has(info.sessionId)) {
        if (recovered.includes(info.sessionId)) {
          await updateSession(info.sessionId, (m) => ({ ...m, audio: withCounts(m.audio, counts) }));
        }
        continue;
      }
      const parsed = parseSessionDir(info.sessionId);
      if (!parsed || info.chunkCount === 0) continue;
      const durationMs = info.chunkCount * TIMESLICE_MS; // estimate: one chunk per timeslice
      await putSession({
        id: info.sessionId,
        meetCode: parsed.meetCode,
        startedAt: parsed.startedAt,
        endedAt: parsed.startedAt + durationMs,
        durationMs,
        status: 'ready',
        route: settings.defaultRoute,
        recovered: true,
        idempotencyKey: idempotencyKey(parsed.meetCode, parsed.startedAt),
        audio: { mimeType: 'audio/webm', ...counts, micIncluded: false },
        captionCount: 0,
      });
    }
  }

  async function ensureRetentionAlarm(): Promise<void> {
    if (!(await deps.alarms.exists(RETENTION_ALARM))) {
      await deps.alarms.create(RETENTION_ALARM, { periodInMinutes: RETENTION_PERIOD_MINUTES });
    }
  }

  async function runBoot(forceFull: boolean): Promise<void> {
    const scanned = (await browser.storage.session.get(SCANNED_KEY))[SCANNED_KEY] === true;
    const full = forceFull ? !fullBootDone : !scanned;
    const settings = await deps.getSettings();
    const docOpen = await deps.offscreen.exists().catch(() => false);

    const recovered = await recoverRecordings(docOpen);
    const interrupted = await resetInterruptedJobs(docOpen);
    await restoreAlarms(!scanned);
    await ensureRetentionAlarm();
    await sweep();
    if (full) {
      await adoptOrphanAudio(settings, recovered);
      fullBootDone = true;
      await browser.storage.session.set({ [SCANNED_KEY]: true });
    }
    if (settings.autoTranscribe) {
      for (const job of interrupted) {
        track(job.kind === 'process' ? transcribeNow(job.id, { attempt: job.attempt }) : saveNow(job.id));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    boot(opts = {}) {
      booting = booting
        .then(() => runBoot(opts.full ?? false))
        .catch((err: unknown) => warn('Recovery failed:', err));
      return booting;
    },

    start,

    async stop(sessionId) {
      await ready();
      await finalize(sessionId, { kind: 'ended' });
    },

    async toggle(tabId) {
      await ready();
      const active = await getActiveRecording();
      if (active && (await getSession(active.sessionId))?.status === 'recording') {
        await finalize(active.sessionId, { kind: 'ended' });
        return;
      }
      const target = tabId ?? (await deps.tabs.activeTabId());
      if (target === null) return;
      const res = await start(target);
      if (!res.ok) await deps.notify('start', 'Manet Meetings', res.error).catch((err: unknown) => warn('Notification failed:', err));
    },

    async route(sessionId, route) {
      await ready();
      await applyRoute(sessionId, route, true);
    },

    async transcribe(sessionId, opts = {}) {
      await ready();
      await transcribeNow(sessionId, { ...(opts.force ? { force: true } : {}), attempt: 1 });
    },

    async save(sessionId, opts = {}) {
      await ready();
      await saveJob(sessionId, opts.force);
    },

    async remove(sessionId) {
      await ready();
      // A recording is removed in turn with starts and ends, so no recorder outlives it.
      if (startingIds.has(sessionId) || (await getSession(sessionId))?.status === 'recording') {
        await serial(() => removeSession(sessionId));
      } else {
        await removeSession(sessionId);
      }
    },

    async sweepRetention() {
      await ready();
      await sweep();
    },

    async onInstalled() {
      await ready();
      const active = await getActiveRecording();
      const meta = active ? await getSession(active.sessionId) : null;
      for (const tabId of await deps.tabs.meetTabIds()) {
        // The push doubles as a probe; a tab that answers keeps the script it has.
        const state = active?.tabId === tabId && meta?.status === 'recording' ? { sessionId: meta.id, startedAt: meta.startedAt } : null;
        if ((await deps.tabs.pushRecordingState(tabId, state)) !== 'no-receiver') continue;
        try {
          await deps.tabs.injectContentScript(tabId);
        } catch (err) {
          warn(`Could not add the content script to tab ${tabId}:`, err);
        }
      }
    },

    async onMeetJoined(tabId, { meetCode, title }) {
      await ready();
      if (tabId === undefined) return null;
      await rememberTab(tabId, { meetCode, ...(title ? { title } : {}) });
      const active = await getActiveRecording();
      if (!active || active.tabId !== tabId || active.meetCode !== meetCode) return null;
      // Until the recorder runs, t = 0 is unknown; the start pushes the state itself.
      if (startingIds.has(active.sessionId)) return null;
      let meta = await getSession(active.sessionId);
      if (!meta || meta.status !== 'recording') return null;
      if ((title && title !== meta.meetingTitle) || meta.captionsError) {
        meta =
          (await updateSession(meta.id, {
            ...(title ? { meetingTitle: title } : {}),
            // The page has a content script after all.
            captionsError: undefined,
          })) ?? meta;
      }
      return { sessionId: meta.id, startedAt: meta.startedAt };
    },

    async onMeetLeft(tabId, { meetCode }) {
      await ready();
      const active = await getActiveRecording();
      if (!active) return;
      const same = tabId !== undefined ? active.tabId === tabId : active.meetCode === meetCode;
      if (same) await finalize(active.sessionId, { kind: 'ended' });
    },

    // Not gated on boot: merging needs no recovery, and boot may be releasing this very tab.
    async onCaptions({ sessionId, segments }) {
      if (deleting.has(sessionId) || !(await getSession(sessionId))) return;
      const count = await mergeCaptions(sessionId, segments);
      const now = deps.now();
      const meta = await updateSession(sessionId, (m) => ({
        ...m,
        captionCount: count,
        captionsError: undefined,
        ...(m.status === 'recording' ? { lastHeartbeat: now } : {}),
      }));
      // Deleted while merging: do not leave captions behind.
      if (!meta) {
        await deleteCaptions(sessionId);
        return;
      }
      if (meta.status === 'recording' && !meta.audio.error) track(checkRecorder(true));
    },

    async onRecorderChunk({ sessionId, index, bytes }) {
      if (deleting.has(sessionId)) return;
      const now = deps.now();
      await updateSession(sessionId, (m) => ({
        ...m,
        audio: {
          ...m.audio,
          chunkCount: Math.max(m.audio.chunkCount, index + 1),
          // Cumulative total from the recorder; max() tolerates out-of-order delivery.
          bytes: Math.max(m.audio.bytes, bytes),
          lastChunkAt: now,
        },
        ...(m.status === 'recording' ? { lastHeartbeat: now } : {}),
      }));
    },

    async onRecorderStopped({ sessionId, reason, error, chunkCount, bytes }) {
      await ready();
      if (deleting.has(sessionId)) return;
      const counts = { chunkCount, bytes };
      await updateSession(sessionId, (m) => ({ ...m, audio: withCounts(m.audio, counts) }));
      // A requested stop is already being finalized by whoever requested it.
      if (reason === 'requested' || finalizing.has(sessionId)) return;
      const message = reason === 'error' ? `Recording stopped: ${error ?? 'recorder error'}` : 'Recording stopped: the tab audio ended';
      const active = await getActiveRecording();
      if (active?.sessionId === sessionId && (await tabOnCall(active))) {
        await degradeAudio(sessionId, message);
        return;
      }
      await finalize(sessionId, { kind: 'recorder-stopped', counts, ...(reason === 'error' ? { error: message } : {}) });
    },

    async onJobProgress({ sessionId, stage }: { sessionId: string; stage: JobStage }) {
      await updateSession(sessionId, (m) => (RUNNING.has(m.status) ? { ...m, stage } : m));
    },

    // Not gated on boot either: recording the outcome first is what keeps boot from
    // resetting a session whose job has just finished.
    onJobDone,

    async onTabRemoved(tabId) {
      await ready();
      await browser.storage.session.remove(`${TAB_PREFIX}${tabId}`);
      const active = await getActiveRecording();
      if (active?.tabId === tabId) await finalize(active.sessionId, { kind: 'ended' });
    },

    async onTabUrlChanged(tabId, url) {
      await ready();
      const active = await getActiveRecording();
      if (active?.tabId !== tabId || meetCodeFromUrl(url) === active.meetCode) return;
      await finalize(active.sessionId, { kind: 'ended' });
    },

    async onAlarm(name) {
      await ready();
      if (name === RETENTION_ALARM) await sweep();
      else if (name === WATCHDOG_ALARM) await checkRecorder(false);
      else if (name.startsWith(ROUTE_ALARM_PREFIX)) await applyDefaultRoute(name.slice(ROUTE_ALARM_PREFIX.length));
      else if (name.startsWith(RETRY_ALARM_PREFIX)) await retryTranscription(name.slice(RETRY_ALARM_PREFIX.length));
    },

    async onNotificationClicked(notificationId) {
      if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
      const meta = await getSession(notificationId.slice(NOTIFICATION_PREFIX.length));
      // The dashboard is where a meeting you partly saved already can be saved in full.
      const ownDuplicate = meta?.status === 'duplicate' && isSelf(meta.notion?.recordedBy, await deps.getSettings());
      if (meta?.notion?.url && !ownDuplicate) await deps.tabs.open(meta.notion.url);
      else await deps.openDashboard();
    },

    async idle() {
      await booting;
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}

/** Maps BackgroundProtocol messages onto the manager. The tab of content messages comes from the sender. */
export function backgroundHandlers(manager: SessionManager): Handlers<BackgroundProtocol> {
  return {
    'meet/joined': (req, sender) => manager.onMeetJoined(sender.tab?.id, req),
    'meet/left': (req, sender) => manager.onMeetLeft(sender.tab?.id, req),
    'captions/batch': (req) => manager.onCaptions(req),
    'session/start': (req) => manager.start(req.tabId),
    'session/stop': (req) => manager.stop(req.sessionId),
    'session/route': (req) => manager.route(req.sessionId, req.route),
    'session/transcribe': (req) => manager.transcribe(req.sessionId, { force: req.force === true }),
    'session/save': (req) => manager.save(req.sessionId, { force: req.force === true }),
    'session/delete': (req) => manager.remove(req.sessionId),
    'offscreen/recorder-chunk': (req) => manager.onRecorderChunk(req),
    'offscreen/recorder-stopped': (req) => manager.onRecorderStopped(req),
    'offscreen/job-progress': (req) => manager.onJobProgress(req),
    'offscreen/job-done': (req) => manager.onJobDone(req),
  };
}
