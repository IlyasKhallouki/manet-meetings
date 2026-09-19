/**
 * Session lifecycle in the background service worker: start → record → finalize →
 * route → process → save, plus recovery after restarts and audio retention.
 *
 * Everything that must outlive the worker is in storage (sessions, captions, results,
 * the active-recording pointer, alarms). This object only holds in-flight promises, so a
 * fresh worker rebuilds its view with boot(). Chrome-facing effects go through `deps`.
 */
import { browser } from 'wxt/browser';
import {
  errorMessage,
  type BackgroundProtocol,
  type Handlers,
  type OffscreenProtocol,
  type RecordingState,
  type StartResult,
} from '@lib/messages';
import { meetCodeFromUrl } from '@lib/meet/meetCode';
import { missingSettings } from '@lib/settings';
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
import type {
  AudioSessionInfo,
  CaptionSegment,
  ExistingMeeting,
  JobStage,
  ProcessOutcome,
  Route,
  SaveOutcome,
  SessionMeta,
  SessionStatus,
  Settings,
} from '@lib/types';
import { idempotencyKey, sessionId as makeSessionId } from '@lib/util/ids';
import type { OffscreenDocument } from './offscreenDocument';

const TIMESLICE_MS = 5000;
const ROUTE_DELAY_MS = 2 * 60 * 1000;
const ROUTE_ALARM_PREFIX = 'route:';
const RETENTION_ALARM = 'retention';
const RETENTION_PERIOD_MINUTES = 6 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const STOP_TIMEOUT_MS = 10_000;
const STATUS_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_MS = 20_000;
/** storage.session flag: the OPFS orphan scan ran in this browser session. */
const SCANNED_KEY = 'bootScanned';
/** storage.session: what the content script last reported for a tab. */
const TAB_PREFIX = 'meetTab:';
const NOTIFICATION_PREFIX = 'manet:';
/** `<meetCode>_<YYYYMMDDTHHMMSSZ>`, as built by util/ids sessionId(). */
const SESSION_DIR = /^([a-z]{3}-[a-z]{4}-[a-z]{3})_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

const TRANSCRIBABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed']);
const SAVABLE = new Set<SessionStatus>(['processed', 'failed']);
const REROUTABLE = new Set<SessionStatus>(['ready', 'failed', 'processed']);

export type SendToOffscreen = <K extends keyof OffscreenProtocol & string>(
  type: K,
  payload: OffscreenProtocol[K]['req'],
) => Promise<OffscreenProtocol[K]['res']>;

export type BadgeState = 'recording' | 'captions-only' | null;

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
    /** Pushes 'content/recording-state'. Must not throw when the page is gone. */
    pushRecordingState(tabId: number, state: RecordingState | null): Promise<void>;
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
  /** Keeps the service worker alive until the returned release function is called. */
  keepAlive(): () => void;
  getSettings(): Promise<Settings>;
  now(): number;
}

type Req<K extends keyof BackgroundProtocol> = BackgroundProtocol[K]['req'];

export interface SessionManager {
  /**
   * Recovery: orphaned recordings, interrupted jobs, lost alarms, retention, and (on the
   * first boot of a browser session, or with `full`) audio in OPFS that has no session.
   * Every other method waits for the latest boot to finish.
   */
  boot(opts?: { full?: boolean }): Promise<void>;
  start(tabId: number): Promise<StartResult>;
  stop(sessionId: string): Promise<void>;
  /** Keyboard command: stops the current recording, or starts one on `tabId` / the active tab. */
  toggle(tabId?: number): Promise<void>;
  route(sessionId: string, route: Route): Promise<void>;
  /** Starts the process + save job. Resolves once it is running (or failed on missing settings). */
  transcribe(sessionId: string): Promise<void>;
  /** Starts the save job for a processed (or failed-to-save) session. */
  save(sessionId: string): Promise<void>;
  /** Stops the session if it is recording, then deletes its audio, captions, result and meta. */
  remove(sessionId: string): Promise<void>;
  sweepRetention(): Promise<void>;
  onMeetJoined(tabId: number | undefined, req: Req<'meet/joined'>): Promise<RecordingState | null>;
  onMeetLeft(tabId: number | undefined, req: Req<'meet/left'>): Promise<void>;
  onCaptions(req: Req<'captions/batch'>): Promise<void>;
  onRecorderChunk(req: Req<'offscreen/recorder-chunk'>): Promise<void>;
  onRecorderStopped(req: Req<'offscreen/recorder-stopped'>): Promise<void>;
  onJobProgress(req: Req<'offscreen/job-progress'>): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  onTabUrlChanged(tabId: number, url: string): Promise<void>;
  onAlarm(name: string): Promise<void>;
  onNotificationClicked(notificationId: string): Promise<void>;
  /** Resolves when every background job and task started so far has settled. */
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

function warn(message: string, err?: unknown): void {
  console.warn(`[manet] ${message}`, err === undefined ? '' : errorMessage(err));
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

function parseSessionDir(name: string): { meetCode: string; startedAt: number } | null {
  const m = SESSION_DIR.exec(name);
  if (!m) return null;
  const [, meetCode, y, mo, d, h, mi, s] = m.map(String) as [string, string, string, string, string, string, string, string];
  return { meetCode, startedAt: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
}

function label(meta: SessionMeta): string {
  return meta.meetingTitle || `Meet ${meta.meetCode}`;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const jobs = new Map<string, Promise<void>>();
  const finalizing = new Map<string, Promise<void>>();
  const deleting = new Set<string>();
  const startingIds = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let booting: Promise<void> = Promise.resolve();
  let startChain: Promise<unknown> = Promise.resolve();
  let fullBootDone = false;

  const ready = () => booting;

  function track(p: Promise<unknown>): void {
    const t: Promise<unknown> = p
      .catch((err: unknown) => warn('Background task failed:', err))
      .finally(() => pending.delete(t));
    pending.add(t);
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

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  function start(tabId: number): Promise<StartResult> {
    // One start at a time: a second click sees the first recording and answers from it.
    const run = startChain.then(() => startRecording(tabId));
    startChain = run.catch(() => undefined);
    return run;
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
      const meta = await updateSession(id, (m) => (audioError ? { ...m, audio: { ...m.audio, error: audioError } } : m));
      if (!meta) return { ok: false, error: 'The session was deleted while starting.' };

      await deps.setBadge(meta.audio.error ? 'captions-only' : 'recording');
      await deps.tabs.pushRecordingState(tabId, { sessionId: id, startedAt: meta.startedAt });
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
      await updateSession(id, (m) => ({
        ...m,
        startedAt: res.startedAt,
        idempotencyKey: idempotencyKey(m.meetCode, res.startedAt),
        audio: { ...m.audio, mimeType: res.mimeType, micIncluded: res.micIncluded },
      }));
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

  async function releaseActive(active: ActiveRecording): Promise<void> {
    await clearActiveRecording();
    await deps.setBadge(null);
    await deps.tabs.pushRecordingState(active.tabId, null);
  }

  /** Ends a recording exactly once, however many end signals arrive. */
  function finalize(id: string, cause: EndCause): Promise<void> {
    if (deleting.has(id)) return Promise.resolve();
    let run = finalizing.get(id);
    if (!run) {
      run = endRecording(id, cause).finally(() => finalizing.delete(id));
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
    if (!ended) return;

    // The alarm first: it routes the meeting even if the prompt never shows.
    await deps.alarms.create(routeAlarm(id), { when: endedAt + ROUTE_DELAY_MS });
    try {
      await deps.openRoutingPrompt(id);
    } catch (err) {
      warn('Could not open the routing prompt:', err);
    }
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

  /**
   * One job per session. `work` calls `started()` once the job is visibly running; the
   * returned promise settles then (or when the job ends or fails before that point).
   */
  function runJob(id: string, work: (started: () => void) => Promise<void>): Promise<void> {
    if (jobs.has(id)) return Promise.resolve();
    let signal!: () => void;
    let isStarted = false;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const release = deps.keepAlive();
    const job = work(() => {
      isStarted = true;
      signal();
    }).finally(() => {
      jobs.delete(id);
      release();
    });
    jobs.set(id, job);
    // Errors before started() reach the caller through the race below; later ones only the log.
    track(job.catch((err: unknown) => (isStarted ? Promise.reject(err) : undefined)));
    return Promise.race([started, job]);
  }

  /** Blocks transcription or saving when keys are missing. Recording never needs them. */
  async function checkSettings(id: string, settings: Settings, route: Route): Promise<boolean> {
    const missing = missingSettings(settings, route);
    if (missing.length === 0) return true;
    await markFailed(id, `Missing settings: ${missing.join(', ')}. Add them in Settings, then try again.`);
    return false;
  }

  async function markFailed(id: string, error: string): Promise<void> {
    const meta = await updateSession(id, (m) => ({ ...m, status: 'failed', stage: undefined, error }));
    if (meta) await notify(meta, error);
  }

  async function markDuplicate(id: string, existing: ExistingMeeting, settings: Settings): Promise<void> {
    const now = deps.now();
    const meta = await updateSession(id, (m) => ({
      ...m,
      status: 'duplicate',
      stage: undefined,
      error: undefined,
      notion: { pageId: existing.pageId, url: existing.url, recordedBy: existing.recordedBy },
      // The meeting is in Notion, so our copy of the audio follows the normal retention.
      purgeAudioAt: now + settings.retentionDays * DAY_MS,
    }));
    if (meta) await notify(meta, `Already in Notion — recorded by ${existing.recordedBy || 'a teammate'}`);
  }

  function transcribeNow(id: string): Promise<void> {
    return runJob(id, async (started) => {
      const meta = await getSession(id);
      if (!meta) throw new Error(`Unknown session ${id}.`);
      if (!TRANSCRIBABLE.has(meta.status)) throw new Error(`Cannot transcribe a session that is ${meta.status}.`);
      if (meta.status === 'awaiting-route') await deps.alarms.clear(routeAlarm(id));
      const settings = await deps.getSettings();
      const route = meta.route ?? settings.defaultRoute;
      if (!(await checkSettings(id, settings, route))) return;

      const processing = await updateSession(id, (m) => ({
        ...m,
        status: 'processing',
        route,
        stage: undefined,
        error: undefined,
      }));
      if (!processing) return;
      started();

      const captions: CaptionSegment[] = await loadCaptions(id);
      let outcome: ProcessOutcome;
      try {
        await deps.offscreen.ensure();
        outcome = await deps.offscreen.send('offscreen/process', { meta: processing, captions, settings, route });
      } catch (err) {
        outcome = { status: 'error', error: `Processing failed: ${errorMessage(err)}` };
      }
      if (deleting.has(id) || !(await getSession(id))) return;

      switch (outcome.status) {
        case 'processed': {
          await putResult(id, outcome.result);
          const processed = await updateSession(id, { status: 'processed', stage: undefined, error: undefined });
          if (!processed) {
            await deleteResult(id);
            return;
          }
          await saveNow(id, settings);
          return;
        }
        case 'duplicate':
          await markDuplicate(id, outcome.existing, settings);
          return;
        case 'error':
          await markFailed(id, outcome.error);
          return;
      }
    });
  }

  async function saveNow(id: string, settings: Settings, started?: () => void): Promise<void> {
    const [meta, result] = await Promise.all([getSession(id), getResult(id)]);
    if (!meta || !result) return;
    const route = meta.route ?? settings.defaultRoute;
    if (!(await checkSettings(id, settings, route))) return;

    const saving = await updateSession(id, (m) => ({ ...m, status: 'saving', stage: 'saving', route, error: undefined }));
    if (!saving) return;
    started?.();

    let outcome: SaveOutcome;
    try {
      await deps.offscreen.ensure();
      outcome = await deps.offscreen.send('offscreen/save', { meta: saving, result, settings, route });
    } catch (err) {
      outcome = { status: 'error', error: `Saving to Notion failed: ${errorMessage(err)}` };
    }

    switch (outcome.status) {
      case 'created': {
        const { pageId, url } = outcome;
        const savedAt = deps.now();
        const saved = await updateSession(id, (m) => ({
          ...m,
          status: 'saved',
          stage: undefined,
          error: undefined,
          notion: { pageId, url, recordedBy: settings.displayName },
          savedAt,
          purgeAudioAt: savedAt + settings.retentionDays * DAY_MS,
        }));
        if (saved) await notify(saved, 'Saved to Notion.');
        return;
      }
      case 'duplicate':
        await markDuplicate(id, outcome.existing, settings);
        return;
      case 'error':
        // The result stays in storage so Save can retry without transcribing again.
        await markFailed(id, outcome.error);
        return;
    }
  }

  function saveJob(id: string): Promise<void> {
    return runJob(id, async (started) => {
      const meta = await getSession(id);
      if (!meta) throw new Error(`Unknown session ${id}.`);
      if (!SAVABLE.has(meta.status) || !(await getResult(id))) {
        throw new Error(`Nothing to save for a session that is ${meta.status}: transcribe it first.`);
      }
      await saveNow(id, await deps.getSettings(), started);
    });
  }

  async function removeSession(id: string): Promise<void> {
    deleting.add(id);
    try {
      const meta = await getSession(id);
      const active = await getActiveRecording();
      if (meta?.status === 'recording' && !meta.audio.error) await stopRecorder(id);
      if (active?.sessionId === id) await releaseActive(active);
      await deps.alarms.clear(routeAlarm(id));
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
      if (jobs.has(meta.id) || deleting.has(meta.id)) continue;
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

  async function isStillRecording(meta: SessionMeta, active: ActiveRecording, recorderIds: string[]): Promise<boolean> {
    if (!meta.audio.error) return recorderIds.includes(meta.id);
    // Captions-only: alive while its tab is still on the call.
    const tab = await deps.tabs.get(active.tabId);
    return !!tab?.url && meetCodeFromUrl(tab.url) === active.meetCode;
  }

  /** Returns the ids of sessions that were recording when the worker or browser died. */
  async function recoverRecordings(settings: Settings): Promise<string[]> {
    // Sessions being started or finalized by this worker are not orphans.
    const busy = (id: string) => startingIds.has(id) || finalizing.has(id);
    const recording = (await listSessions()).filter((s) => s.status === 'recording' && !busy(s.id));
    const active = await getActiveRecording();

    let recorderIds: string[] = [];
    if (await deps.offscreen.exists().catch(() => false)) {
      try {
        const status = await withTimeout(deps.offscreen.send('offscreen/recorder-status', {}), STATUS_TIMEOUT_MS, 'Recorder status');
        recorderIds = status.recordingSessionIds;
      } catch (err) {
        warn('Recorder status unavailable:', err);
      }
    }
    // A recorder nothing points at would run until the browser closes.
    for (const id of recorderIds) if (id !== active?.sessionId) await stopRecorder(id);

    const recovered: string[] = [];
    let activeMeta: SessionMeta | null = null;
    for (const s of recording) {
      if (active?.sessionId === s.id && (await isStillRecording(s, active, recorderIds))) {
        activeMeta = s;
        continue;
      }
      const endedAt = s.lastHeartbeat ?? s.startedAt;
      let changed = false;
      await updateSession(s.id, (m) => {
        if (m.status !== 'recording') return m;
        changed = true;
        return {
          ...m,
          status: 'ready',
          recovered: true,
          endedAt,
          durationMs: Math.max(0, endedAt - m.startedAt),
          route: m.route ?? settings.defaultRoute,
        };
      });
      if (changed) recovered.push(s.id);
    }

    if (active && !busy(active.sessionId)) {
      if (activeMeta) await deps.setBadge(activeMeta.audio.error ? 'captions-only' : 'recording');
      else await releaseActive(active);
    }
    return recovered;
  }

  async function resetInterruptedJobs(): Promise<void> {
    for (const s of await listSessions()) {
      if (jobs.has(s.id)) continue;
      if (s.status === 'processing') {
        await updateSession(s.id, (m) => (m.status === 'processing' ? { ...m, status: 'ready', stage: undefined } : m));
      } else if (s.status === 'saving') {
        const next: SessionStatus = (await getResult(s.id)) ? 'processed' : 'ready';
        await updateSession(s.id, (m) => (m.status === 'saving' ? { ...m, status: next, stage: undefined } : m));
      }
    }
  }

  /** Alarms can be lost across browser restarts: re-arm or apply overdue default routes. */
  async function restoreRouteAlarms(): Promise<void> {
    const now = deps.now();
    for (const s of await listSessions()) {
      if (s.status !== 'awaiting-route' || (await deps.alarms.exists(routeAlarm(s.id)))) continue;
      const due = (s.endedAt ?? now) + ROUTE_DELAY_MS;
      if (due <= now) await applyDefaultRoute(s.id);
      else await deps.alarms.create(routeAlarm(s.id), { when: due });
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

    const recovered = await recoverRecordings(settings);
    await resetInterruptedJobs();
    await restoreRouteAlarms();
    await ensureRetentionAlarm();
    await sweep();
    if (full) {
      await adoptOrphanAudio(settings, recovered);
      fullBootDone = true;
      await browser.storage.session.set({ [SCANNED_KEY]: true });
    }
    if (settings.autoTranscribe) for (const id of recovered) track(transcribeNow(id));
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

    async transcribe(sessionId) {
      await ready();
      await transcribeNow(sessionId);
    },

    async save(sessionId) {
      await ready();
      await saveJob(sessionId);
    },

    async remove(sessionId) {
      await ready();
      await removeSession(sessionId);
    },

    async sweepRetention() {
      await ready();
      await sweep();
    },

    async onMeetJoined(tabId, { meetCode, title }) {
      await ready();
      if (tabId === undefined) return null;
      await rememberTab(tabId, { meetCode, ...(title ? { title } : {}) });
      const active = await getActiveRecording();
      if (!active || active.tabId !== tabId || active.meetCode !== meetCode) return null;
      let meta = await getSession(active.sessionId);
      if (!meta || meta.status !== 'recording') return null;
      if (title && title !== meta.meetingTitle) meta = (await updateSession(meta.id, { meetingTitle: title })) ?? meta;
      return { sessionId: meta.id, startedAt: meta.startedAt };
    },

    async onMeetLeft(tabId, { meetCode }) {
      await ready();
      const active = await getActiveRecording();
      if (!active) return;
      const same = tabId !== undefined ? active.tabId === tabId : active.meetCode === meetCode;
      if (same) await finalize(active.sessionId, { kind: 'ended' });
    },

    async onCaptions({ sessionId, segments }) {
      await ready();
      if (deleting.has(sessionId) || !(await getSession(sessionId))) return;
      const count = await mergeCaptions(sessionId, segments);
      const now = deps.now();
      const meta = await updateSession(sessionId, (m) => ({
        ...m,
        captionCount: count,
        ...(m.status === 'recording' ? { lastHeartbeat: now } : {}),
      }));
      // Deleted while merging: do not leave captions behind.
      if (!meta) await deleteCaptions(sessionId);
    },

    async onRecorderChunk({ sessionId, index, bytes }) {
      await ready();
      if (deleting.has(sessionId)) return;
      const now = deps.now();
      await updateSession(sessionId, (m) => ({
        ...m,
        audio: {
          ...m.audio,
          chunkCount: Math.max(m.audio.chunkCount, index + 1),
          // Cumulative total from the recorder; max() tolerates out-of-order delivery.
          bytes: Math.max(m.audio.bytes, bytes),
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
      await finalize(sessionId, {
        kind: 'recorder-stopped',
        counts,
        ...(reason === 'error' ? { error: `Recording stopped: ${error ?? 'recorder error'}` } : {}),
      });
    },

    async onJobProgress({ sessionId, stage }: { sessionId: string; stage: JobStage }) {
      await ready();
      await updateSession(sessionId, (m) => (m.status === 'processing' || m.status === 'saving' ? { ...m, stage } : m));
    },

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
      else if (name.startsWith(ROUTE_ALARM_PREFIX)) await applyDefaultRoute(name.slice(ROUTE_ALARM_PREFIX.length));
    },

    async onNotificationClicked(notificationId) {
      if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
      const meta = await getSession(notificationId.slice(NOTIFICATION_PREFIX.length));
      if (meta?.notion?.url) await deps.tabs.open(meta.notion.url);
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
    'session/transcribe': (req) => manager.transcribe(req.sessionId),
    'session/save': (req) => manager.save(req.sessionId),
    'session/delete': (req) => manager.remove(req.sessionId),
    'offscreen/recorder-chunk': (req) => manager.onRecorderChunk(req),
    'offscreen/recorder-stopped': (req) => manager.onRecorderStopped(req),
    'offscreen/job-progress': (req) => manager.onJobProgress(req),
  };
}
