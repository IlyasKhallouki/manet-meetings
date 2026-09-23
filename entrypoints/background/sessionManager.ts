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
import { defaultProfile, profileById, profileForSession } from '@lib/profiles';
import { AUDIO_CHUNK_MS, recordingHealth } from '@lib/recordingHealth';
import { missingForSave } from '@lib/settingsSchema';
import { deleteCaptions, loadCaptions, mergeCaptions } from '@lib/storage/captionStore';
import { deleteResult, getResult, putResult } from '@lib/storage/resultStore';
import {
  clearActiveRecording,
  deleteSession,
  getActiveRecording,
  getSession,
  listSessions,
  needsYou,
  putSession,
  setActiveRecording,
  updateSession,
  watchActiveRecording,
  watchSessions,
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
import { actionStateFor, type ActionState } from './actionState';
import { MeetingProblem, notes, problems, type Note } from './copy';
import type { OffscreenDocument } from './offscreenDocument';

/** The recorder's chunk length; recordingHealth calls three missing chunks a stall. */
const TIMESLICE_MS = AUDIO_CHUNK_MS;
const ROUTE_DELAY_MS = 2 * 60 * 1000;
const ROUTE_ALARM_PREFIX = 'route:';
const RETRY_ALARM_PREFIX = 'retry:';
const RETENTION_ALARM = 'retention';
const RETENTION_PERIOD_MINUTES = 6 * 60;
const WATCHDOG_ALARM = 'recorder-watchdog';
/** Chrome's shortest alarm period (older versions round it up to a minute). */
const WATCHDOG_PERIOD_MINUTES = 0.5;
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
/** storage.session: the routing prompt's window and whether its countdown is paused, per session. */
const ROUTING_PREFIX = 'routing:';
const NOTIFICATION_PREFIX = 'manet:';
/** `<meetCode>_<YYYYMMDDTHHMMSSZ>`, as built by util/ids sessionId(). */
const SESSION_DIR = /^([a-z]{3}-[a-z]{4}-[a-z]{3})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/**
 * `meta` with its routeDeadline (the route alarm's time, which pages show as "If you don’t
 * choose, it goes to Team at 15:34") set to `at`, or removed when undefined; `meta` itself
 * if unchanged.
 */
function withRouteDeadline(meta: SessionMeta, at: number | undefined): SessionMeta {
  if (meta.routeDeadline === at) return meta;
  return { ...meta, routeDeadline: at };
}

/** 'duplicate' and 'empty' can run again: "Transcribe anyway", or audio that holds more. */
const TRANSCRIBABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);
/** Only with a stored result. */
const SAVABLE = new Set<SessionStatus>(['processed', 'failed', 'duplicate']);
const REROUTABLE = new Set<SessionStatus>(['ready', 'failed', 'processed', 'empty', 'duplicate']);
/** The session's job is in the offscreen document. */
const RUNNING = new Set<SessionStatus>(['processing', 'saving']);
/** A meeting's profile can change until it is in Notion or on its way there. */
const PROFILE_CHANGEABLE = new Set<SessionStatus>(['recording', 'awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);

export type SendToOffscreen = <K extends keyof OffscreenProtocol & string>(
  type: K,
  payload: OffscreenProtocol[K]['req'],
) => Promise<OffscreenProtocol[K]['res']>;

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
  /** Opens Settings (the options page). */
  openSettings(): Promise<void>;
  /** Shows `state` on the toolbar button: icon, badge and tooltip. */
  setActionState(state: ActionState): Promise<void>;
  /** The toggle-recording shortcut as Chrome shows it ("Alt+Shift+R"), or null when unset. Never throws. */
  shortcut(): Promise<string | null>;
  /** Opens the Team | Personal prompt. Resolves to its window id, when known. */
  openRoutingPrompt(sessionId: string): Promise<number | undefined>;
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
  /** Starts recording `tabId` for `profileId` (the default profile when absent or unknown). */
  start(tabId: number, profileId?: string): Promise<StartResult>;
  stop(sessionId: string): Promise<void>;
  /** Keyboard command: stops the current recording, or starts one on `tabId` / the active tab. */
  toggle(tabId?: number): Promise<void>;
  route(sessionId: string, route: Route): Promise<void>;
  /**
   * The routing prompt paused (`hold`) or resumed its countdown. Paused, the default route
   * is not applied until the person resumes or closes the prompt, which re-arms the
   * 2-minute default. `windowId` is the prompt's window, when the message came from one.
   */
  routeHold(sessionId: string, hold: boolean, windowId?: number): Promise<void>;
  /** Sets the meeting's profile. The next transcription or save uses it. */
  setProfile(sessionId: string, profileId: string): Promise<void>;
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
  /**
   * After an install or update: Meet tabs opened before it get a content script. A first
   * install (`reason` 'install') also opens Settings, where setup starts.
   */
  onInstalled(reason?: string): Promise<void>;
  onMeetJoined(tabId: number | undefined, req: Req<'meet/joined'>): Promise<RecordingState | null>;
  onMeetLeft(tabId: number | undefined, req: Req<'meet/left'>): Promise<void>;
  onCaptions(req: Req<'captions/batch'>): Promise<void>;
  onRecorderChunk(req: Req<'offscreen/recorder-chunk'>): Promise<void>;
  onRecorderStopped(req: Req<'offscreen/recorder-stopped'>): Promise<void>;
  onJobProgress(req: Req<'offscreen/job-progress'>): Promise<void>;
  onJobDone(req: Req<'offscreen/job-done'>): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  onTabUrlChanged(tabId: number, url: string): Promise<void>;
  /** A closed routing prompt that was paused re-arms the default route. */
  onWindowRemoved(windowId: number): Promise<void>;
  onAlarm(name: string): Promise<void>;
  onNotificationClicked(notificationId: string): Promise<void>;
  /**
   * Recomputes the toolbar button from storage and shows it if it changed. Runs by itself
   * on every relevant session or pointer write; alarms and caption batches call it too.
   */
  refreshAction(): Promise<void>;
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

interface RoutingPrompt {
  windowId?: number;
  /** The person paused the countdown: no default-route alarm is armed. */
  held?: boolean;
}

type Job = NonNullable<SessionMeta['job']>;

/** audio.error when the recorder can't start; captions are still captured. */
const RECORDER_DIDNT_START = 'The recorder couldn’t start, so only captions are being saved.';

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

/** Whether a change to a session can change the toolbar button. */
function affectsAction(next: SessionMeta | null, previous: SessionMeta | null): boolean {
  if (!next || !previous) return true;
  if (next.status === 'recording' || previous.status === 'recording') return true;
  return needsYou(next) !== needsYou(previous);
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

  async function notify(sessionId: string, note: Note): Promise<void> {
    try {
      await deps.notify(sessionId, note.title, note.message);
    } catch (err) {
      warn('Notification failed:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Toolbar button
  // -------------------------------------------------------------------------

  /** JSON of the state last shown, so unchanged states cost no Chrome calls. */
  let shownAction: string | null = null;
  let actionChain: Promise<void> = Promise.resolve();
  /** A refresh that has not started yet: it will read whatever was written before it runs. */
  let queuedAction: Promise<void> | null = null;

  function refreshAction(): Promise<void> {
    if (queuedAction) return queuedAction;
    const run = actionChain.then(() => {
      queuedAction = null;
      return showAction();
    });
    queuedAction = run;
    actionChain = run.catch(() => undefined);
    return run;
  }

  async function showAction(): Promise<void> {
    try {
      const active = await getActiveRecording();
      const meta = active ? await getSession(active.sessionId) : null;
      const recording = meta?.status === 'recording' ? meta : null;
      const state = actionStateFor({
        recording,
        sessions: recording ? [] : await listSessions(),
        now: deps.now(),
        shortcut: recording ? null : await deps.shortcut(),
      });
      const key = JSON.stringify(state);
      if (key === shownAction) return;
      await deps.setActionState(state);
      shownAction = key;
    } catch (err) {
      warn('Could not update the toolbar button:', err);
    }
  }

  // Session writes come only from this worker, but from dozens of places: watching
  // storage catches every one of them. Time-based problems are rechecked by the
  // watchdog alarm and by the chunks and captions that keep arriving.
  watchSessions((_id, next, previous) => {
    if (affectsAction(next, previous)) track(refreshAction());
  });
  watchActiveRecording(() => track(refreshAction()));

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
      await updateSession(id, (m) => (m.status === 'recording' ? { ...m, captionsError: problems.captionsMissing } : m));
    }
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  function start(tabId: number, profileId?: string): Promise<StartResult> {
    // A second click sees the first recording and answers from it; a stop waits for the
    // start in flight, so it stops the recorder that started.
    return serial(() => startRecording(tabId, profileId));
  }

  async function startRecording(tabId: number, profileId?: string): Promise<StartResult> {
    await ready();
    const active = await getActiveRecording();
    if (active) {
      const current = await getSession(active.sessionId);
      if (current?.status === 'recording') {
        return active.tabId === tabId
          ? { ok: true, sessionId: active.sessionId }
          : { ok: false, error: 'Already recording another meeting. Stop that recording first.' };
      }
      await clearActiveRecording();
    }

    const tab = await deps.tabs.get(tabId);
    const meetCode = tab?.url ? meetCodeFromUrl(tab.url) : null;
    if (!meetCode) return { ok: false, error: 'This tab isn’t a Google Meet call.' };

    const settings = await deps.getSettings();
    const profile = profileById(settings, profileId) ?? defaultProfile(settings);
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
        // Shown in the popup and on the Notion page: plain words, the raw detail goes to the log.
        warn('Tab capture failed', err);
        audioError = 'Chrome couldn’t capture the call audio.';
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
        profileId: profile.id,
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

      await refreshAction();
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
      if (!res.ok) {
        warn('Recorder failed to start', res.error);
        return RECORDER_DIDNT_START;
      }
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
      warn('Recorder failed to start', err);
      return RECORDER_DIDNT_START;
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
   * Clears the pointer and watchdog, shows the idle button, and tells the tab to stop capturing. With
   * `waitForTab` false the push is not awaited: the page's reply can depend on a
   * caption batch, and boot must never wait on a page.
   */
  async function releaseActive(active: ActiveRecording, waitForTab = true): Promise<void> {
    await clearActiveRecording();
    await deps.alarms.clear(WATCHDOG_ALARM);
    await refreshAction();
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
      const next: SessionMeta = {
        ...m,
        status: 'awaiting-route',
        endedAt,
        durationMs: Math.max(0, endedAt - m.startedAt),
        audio: recorderError && !audio.error ? { ...audio, error: recorderError } : audio,
      };
      // With the status, so pages never see the meeting waiting without its deadline.
      return withRouteDeadline(next, endedAt + ROUTE_DELAY_MS);
    });
    if (ended) await askForRoute(id, endedAt + ROUTE_DELAY_MS);
  }

  /**
   * The alarm first: it routes the meeting (to the default) even if the prompt never shows.
   * A new prompt starts a new countdown, so an earlier pause no longer applies.
   */
  async function askForRoute(id: string, when: number): Promise<void> {
    await armRouteAlarm(id, when);
    await forgetRouting(id);
    try {
      const windowId = await deps.openRoutingPrompt(id);
      if (windowId !== undefined) await setRouting(id, { windowId });
    } catch (err) {
      warn('Could not open the routing prompt:', err);
    }
  }

  /** Arms the default route for a meeting still waiting for one, and writes its time on the meta. */
  async function armRouteAlarm(id: string, when: number): Promise<void> {
    await deps.alarms.create(routeAlarm(id), { when });
    await updateSession(id, (m) => (m.status === 'awaiting-route' ? withRouteDeadline(m, when) : m));
  }

  /** No default route any more (paused, routed, transcribed): no alarm, no deadline on the meta. */
  async function clearRouteAlarm(id: string): Promise<void> {
    await deps.alarms.clear(routeAlarm(id));
    await updateSession(id, (m) => withRouteDeadline(m, undefined));
  }

  // -------------------------------------------------------------------------
  // Routing prompt: pause and resume the default route
  // -------------------------------------------------------------------------

  async function routing(id: string): Promise<RoutingPrompt | null> {
    const key = `${ROUTING_PREFIX}${id}`;
    return ((await browser.storage.session.get(key))[key] as RoutingPrompt | undefined) ?? null;
  }

  async function setRouting(id: string, prompt: RoutingPrompt): Promise<void> {
    await browser.storage.session.set({ [`${ROUTING_PREFIX}${id}`]: prompt });
  }

  async function forgetRouting(id: string): Promise<void> {
    await browser.storage.session.remove(`${ROUTING_PREFIX}${id}`);
  }

  async function isHeld(id: string): Promise<boolean> {
    return (await routing(id))?.held === true;
  }

  /** Pause and resume for one session happen one at a time, in arrival order. */
  const routingOps = new Map<string, Promise<unknown>>();
  function routingOp<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (routingOps.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    routingOps.set(id, tail);
    void tail.then(() => {
      if (routingOps.get(id) === tail) routingOps.delete(id);
    });
    return run;
  }

  async function holdRoute(id: string, windowId: number | undefined): Promise<void> {
    if ((await getSession(id))?.status !== 'awaiting-route') return;
    await clearRouteAlarm(id);
    const prompt = await routing(id);
    await setRouting(id, { windowId: prompt?.windowId ?? windowId, held: true });
  }

  /** Re-arms the full default-route delay for a paused session still waiting for a route. */
  async function resumeRoute(id: string, windowOpen: boolean): Promise<void> {
    const prompt = await routing(id);
    if (!prompt?.held) {
      if (!windowOpen) await forgetRouting(id);
      return;
    }
    if ((await getSession(id))?.status === 'awaiting-route') await armRouteAlarm(id, deps.now() + ROUTE_DELAY_MS);
    if (windowOpen) await setRouting(id, prompt.windowId === undefined ? {} : { windowId: prompt.windowId });
    else await forgetRouting(id);
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
      await refreshAction();
    }
    await notify(id, notes.captionsOnly());
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
    // The same rule as the popup's "No audio for 20 s" and the toolbar's "!".
    if (recordingHealth(meta, deps.now()).audio?.kind !== 'stalled') return;
    if (!(await recorderAlive(meta.id))) await degradeAudio(meta.id, problems.audioStopped());
  }

  // -------------------------------------------------------------------------
  // Routing and jobs
  // -------------------------------------------------------------------------

  async function applyRoute(id: string, route: Route, explicit: boolean): Promise<void> {
    let routed = false;
    const meta = await updateSession(id, (m) => {
      if (m.status === 'awaiting-route') {
        routed = true;
        return withRouteDeadline({ ...m, route, profileId: route, status: 'ready' }, undefined);
      }
      if (!explicit) return m;
      if (REROUTABLE.has(m.status)) return { ...m, route, profileId: route };
      throw new MeetingProblem(problems.cannotRoute(m.status));
    });
    if (!meta) {
      if (explicit) throw new MeetingProblem(problems.deleted);
      return;
    }
    if (routed || explicit) {
      // A choice ends the prompt's business: no alarm, no deadline, no pause, no window to watch.
      await clearRouteAlarm(id);
      await forgetRouting(id);
    }
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

  /** The notification for a job of `kind` that failed with `reason`. */
  function failureNote(meta: SessionMeta, kind: Job['kind'], reason: string): Note {
    return kind === 'save'
      ? notes.couldNotSave(meta, reason, deps.now())
      : notes.couldNotTranscribe(meta, reason, deps.now());
  }

  /** `reason` is what the person reads in the notification, when it differs from the stored error. */
  async function failJob(id: string, jobId: string, error: string, reason = error): Promise<void> {
    let kind: Job['kind'] = 'process';
    const meta = await updateJob(id, jobId, (m) => {
      kind = m.job?.kind ?? kind;
      return { ...m, status: 'failed', stage: undefined, job: undefined, error };
    });
    if (meta) await notify(id, failureNote(meta, kind, reason));
  }

  /**
   * The stored error is a record Meetings reads (sessionView MISSING_SETTINGS) and words
   * itself; the notification says the same sentence.
   */
  async function markMissingSettings(id: string, missing: string[], kind: Job['kind']): Promise<void> {
    const error = problems.missingSettings(missing);
    let changed = false;
    const meta = await updateSession(id, (m) => {
      if (RUNNING.has(m.status)) return m;
      changed = true;
      return { ...m, status: 'failed', stage: undefined, job: undefined, error };
    });
    if (meta && changed) await notify(id, failureNote(meta, kind, problems.missingSettings(missing)));
  }

  /** The meeting's profile was deleted: it waits for another (Meetings offers them). */
  async function markProfileMissing(id: string, kind: Job['kind']): Promise<void> {
    let changed = false;
    const meta = await updateSession(id, (m) => {
      if (RUNNING.has(m.status)) return m;
      changed = true;
      return { ...m, status: 'failed', stage: undefined, job: undefined, error: problems.profileDeleted };
    });
    if (meta && changed) await notify(id, failureNote(meta, kind, problems.profileDeleted));
  }

  async function changeProfile(id: string, profileId: string): Promise<void> {
    if (!profileById(await deps.getSettings(), profileId)) throw new MeetingProblem(problems.unknownProfile);
    const meta = await updateSession(id, (m) => {
      if (!PROFILE_CHANGEABLE.has(m.status)) throw new MeetingProblem(problems.cannotChangeProfile(m.status));
      return m.profileId === profileId ? m : { ...m, profileId };
    });
    if (!meta) throw new MeetingProblem(problems.deleted);
  }

  /**
   * Hands a job to the offscreen document. Its outcome arrives as 'offscreen/job-done';
   * if the document never accepted it, the session fails with the reason.
   */
  async function launch(id: string, jobId: string, kind: Job['kind'], send: () => Promise<unknown>): Promise<void> {
    launching.add(id);
    try {
      await deps.offscreen.ensure();
      await withTimeout(send(), ACCEPT_TIMEOUT_MS, 'The offscreen document');
    } catch (err) {
      warn(`The offscreen document did not take the ${kind} job for ${id}:`, err);
      await failJob(id, jobId, problems.didNotStart(kind));
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
  async function transcribeNow(
    id: string,
    opts: { force?: boolean; attempt?: number; summaryOnly?: boolean } = {},
  ): Promise<void> {
    const meta = await getSession(id);
    if (!meta) throw new MeetingProblem(problems.deleted);
    if (RUNNING.has(meta.status)) return;
    if (!TRANSCRIBABLE.has(meta.status)) throw new MeetingProblem(problems.cannotTranscribe(meta.status));
    await clearRouteAlarm(id);
    await deps.alarms.clear(retryAlarm(id));
    const settings = await deps.getSettings();
    const profile = profileForSession(settings, meta.profileId);
    if (!profile) {
      await markProfileMissing(id, 'process');
      return;
    }
    const route = meta.route ?? settings.defaultRoute;
    const missing = missingForSave(settings, profile);
    if (missing.length > 0) {
      await markMissingSettings(id, missing, 'process');
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
        profileId: profile.id,
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
    const reuse = opts.summaryOnly ? await getResult(id) : null;
    await launch(id, job.id, 'process', async () => {
      const captions = await loadCaptions(id);
      await deps.offscreen.send('offscreen/process', {
        jobId: job.id,
        meta: processing,
        captions,
        settings,
        profile,
        attempt,
        ...(reuse ? { reuse } : {}),
        ...(force ? { force } : {}),
      });
    });
  }

  /** Starts the save job for a session with a stored result, unless a job is running. */
  async function saveNow(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const [meta, result] = await Promise.all([getSession(id), getResult(id)]);
    if (!meta || !result || RUNNING.has(meta.status)) return;
    const settings = await deps.getSettings();
    const profile = profileForSession(settings, meta.profileId);
    if (!profile) {
      await markProfileMissing(id, 'save');
      return;
    }
    const route = meta.route ?? settings.defaultRoute;
    const missing = missingForSave(settings, profile);
    if (missing.length > 0) {
      await markMissingSettings(id, missing, 'save');
      return;
    }
    // The notes were written for another profile: write them again for this one; the save follows.
    const writtenFor = result.profile?.id ?? meta.route;
    if (SAVABLE.has(meta.status) && writtenFor !== undefined && writtenFor !== profile.id) {
      await transcribeNow(id, { summaryOnly: true, ...(opts.force ? { force: true } : {}) });
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
    await launch(id, job.id, 'save', () =>
      deps.offscreen.send('offscreen/save', { jobId: job.id, meta: saving, result, settings, profile, ...(force ? { force } : {}) }),
    );
  }

  async function saveJob(id: string, force?: boolean): Promise<void> {
    const meta = await getSession(id);
    if (!meta) throw new MeetingProblem(problems.deleted);
    if (RUNNING.has(meta.status)) return;
    if (!SAVABLE.has(meta.status) || !(await getResult(id))) throw new MeetingProblem(problems.cannotSave(meta.status));
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
      id,
      self ? notes.alreadySavedByYou(meta, now) : notes.alreadyInNotion(meta, existing.recordedBy, now),
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
        // Unexpected by contract (Gemini and Notion trouble degrade or retry instead): a
        // bug's words help nobody on Meetings, so they go to the console.
        warn(`Transcribing ${id} failed:`, outcome.error);
        await failJob(id, jobId, problems.transcribingStopped);
        return;
    }
  }

  async function processed(id: string, jobId: string, result: SessionResult): Promise<void> {
    const previous = await getResult(id);
    if (worseThan(previous, result)) {
      warn(`Transcribing ${id} again came out worse, so the earlier transcript was kept:`, failureReason(result));
      await failJob(id, jobId, problems.earlierTranscriptKept);
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
      if (empty) await notify(id, notes.nothingToSave(empty, now));
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
    warn(`Gemini could not transcribe ${meta.id} (attempt ${attempt}):`, error);
    if (attempt >= MAX_TRANSCRIBE_ATTEMPTS) {
      await failJob(meta.id, jobId, problems.geminiGaveUp(error, attempt));
      return;
    }
    const retryAt = deps.now() + RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
    const message = problems.geminiRetrying(error, retryAt);
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
    // One notification per outage: later retries only move the time, which Meetings shows
    // (HIG notifications.md › Best practices: "Avoid sending multiple notifications for the same thing").
    if (attempt === 1) await notify(meta.id, notes.retrying(failed, retryAt, deps.now()));
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
        const where = profileForSession(settings, saved?.profileId)?.name ?? 'Notion';
        if (saved) await notify(id, notes.saved(saved, where, savedAt));
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
        if (await recorderAlive(id)) throw new MeetingProblem(problems.couldNotStop);
      }
      if (active?.sessionId === id) await releaseActive(active);
      await deps.alarms.clear(routeAlarm(id));
      await deps.alarms.clear(retryAlarm(id));
      await forgetRouting(id);
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
        const durationMs = Math.max(0, endedAt - m.startedAt);
        const next: SessionMeta = { ...m, status: 'awaiting-route', recovered: true, endedAt, durationMs };
        return withRouteDeadline(next, now + ROUTE_DELAY_MS);
      });
      if (!changed) continue;
      recovered.push(s.id);
      await askForRoute(s.id, now + ROUTE_DELAY_MS);
    }

    if (active && !busy(active.sessionId)) {
      if (activeMeta) {
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
      // A paused prompt has no alarm on purpose (storage.session forgets pauses with the browser).
      if (s.status === 'awaiting-route' && !(await deps.alarms.exists(routeAlarm(s.id))) && !(await isHeld(s.id))) {
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
    // The button's state lives in the browser, not the worker: after a browser restart it
    // is back to the manifest's, so show what storage says.
    await refreshAction();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Runs a request a page made. Its words reach that page as they are, so anything but a
   * MeetingProblem (a storage or messaging failure inside Chrome) goes to the console and
   * the page hears "Chrome didn't respond. Try again." (HIG writing.md › Getting started:
   * plain language, no jargon).
   */
  async function request<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MeetingProblem) throw err;
      warn(`Could not ${what}:`, err);
      throw new MeetingProblem(problems.noResponse);
    }
  }

  return {
    boot(opts = {}) {
      booting = booting
        .then(() => runBoot(opts.full ?? false))
        .catch((err: unknown) => warn('Recovery failed:', err));
      return booting;
    },

    start: (tabId, profileId) => start(tabId, profileId),

    stop(sessionId) {
      return request('stop the recording', async () => {
        await ready();
        await finalize(sessionId, { kind: 'ended' });
      });
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
      if (!res.ok) await notify('start', notes.couldNotStart(res.error));
    },

    route(sessionId, route) {
      return request(`save the meeting to ${route}`, async () => {
        await ready();
        await applyRoute(sessionId, route, true);
      });
    },

    async routeHold(sessionId, hold, windowId) {
      await ready();
      await routingOp(sessionId, () => (hold ? holdRoute(sessionId, windowId) : resumeRoute(sessionId, true)));
    },

    setProfile(sessionId, profileId) {
      return request('change the profile', async () => {
        await ready();
        await changeProfile(sessionId, profileId);
      });
    },

    transcribe(sessionId, opts = {}) {
      return request('transcribe', async () => {
        await ready();
        await transcribeNow(sessionId, { ...(opts.force ? { force: true } : {}), attempt: 1 });
      });
    },

    save(sessionId, opts = {}) {
      return request('save to Notion', async () => {
        await ready();
        await saveJob(sessionId, opts.force);
      });
    },

    remove(sessionId) {
      return request('delete', async () => {
        await ready();
        // A recording is removed in turn with starts and ends, so no recorder outlives it.
        if (startingIds.has(sessionId) || (await getSession(sessionId))?.status === 'recording') {
          await serial(() => removeSession(sessionId));
        } else {
          await removeSession(sessionId);
        }
      });
    },

    async sweepRetention() {
      await ready();
      await sweep();
    },

    async onInstalled(reason) {
      if (reason === 'install') {
        await deps.openSettings().catch((err: unknown) => warn('Could not open Settings:', err));
      }
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
      const { count, speakers } = await mergeCaptions(sessionId, segments);
      const now = deps.now();
      const meta = await updateSession(sessionId, (m) => ({
        ...m,
        captionCount: count,
        speakers,
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
      const message = reason === 'error' ? problems.audioStopped(error) : problems.tabAudioEnded;
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

    async onWindowRemoved(windowId) {
      await ready();
      const stored = await browser.storage.session.get(null);
      for (const [key, value] of Object.entries(stored)) {
        if (!key.startsWith(ROUTING_PREFIX) || (value as RoutingPrompt).windowId !== windowId) continue;
        const id = key.slice(ROUTING_PREFIX.length);
        await routingOp(id, () => resumeRoute(id, false));
      }
    },

    async onAlarm(name) {
      await ready();
      if (name === RETENTION_ALARM) await sweep();
      else if (name === WATCHDOG_ALARM) {
        await checkRecorder(false);
        // Problems that only time reveals: no captions yet, captions gone quiet, audio stalled.
        await refreshAction();
      } else if (name.startsWith(ROUTE_ALARM_PREFIX)) {
        const id = name.slice(ROUTE_ALARM_PREFIX.length);
        // Fired just as the prompt was paused: the pause wins.
        if (!(await isHeld(id))) await applyDefaultRoute(id);
      } else if (name.startsWith(RETRY_ALARM_PREFIX)) await retryTranscription(name.slice(RETRY_ALARM_PREFIX.length));
    },

    async onNotificationClicked(notificationId) {
      if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
      const meta = await getSession(notificationId.slice(NOTIFICATION_PREFIX.length));
      // The dashboard is where a meeting you partly saved already can be saved in full.
      const ownDuplicate = meta?.status === 'duplicate' && isSelf(meta.notion?.recordedBy, await deps.getSettings());
      if (meta?.notion?.url && !ownDuplicate) await deps.tabs.open(meta.notion.url);
      else await deps.openDashboard();
    },

    refreshAction,

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
    'session/start': (req) => manager.start(req.tabId, req.profileId),
    'session/stop': (req) => manager.stop(req.sessionId),
    'session/route': (req) => manager.route(req.sessionId, req.route),
    'session/route-hold': (req, sender) => manager.routeHold(req.sessionId, req.hold, sender.tab?.windowId),
    'session/set-profile': (req) => manager.setProfile(req.sessionId, req.profileId),
    'session/transcribe': (req) => manager.transcribe(req.sessionId, { force: req.force === true }),
    'session/save': (req) => manager.save(req.sessionId, { force: req.force === true }),
    'session/delete': (req) => manager.remove(req.sessionId),
    'offscreen/recorder-chunk': (req) => manager.onRecorderChunk(req),
    'offscreen/recorder-stopped': (req) => manager.onRecorderStopped(req),
    'offscreen/job-progress': (req) => manager.onJobProgress(req),
    'offscreen/job-done': (req) => manager.onJobDone(req),
  };
}
