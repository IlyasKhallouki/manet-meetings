/**
 * Typed message protocol between extension contexts.
 *
 * runtime.sendMessage broadcasts to every extension context (background, offscreen
 * document, open extension pages), so each envelope names its `target` and every
 * listener ignores envelopes addressed elsewhere. Handler errors travel back as
 * `{ ok: false, error }` and are rethrown on the sending side.
 *
 * The offscreen document can only use chrome.runtime, so everything it needs
 * (settings, captions, session meta) arrives inside these messages.
 */
import { browser, type Browser } from 'wxt/browser';
import type {
  AudioSessionInfo,
  CaptionSegment,
  JobStage,
  ProcessJob,
  ProcessOutcome,
  Route,
  SaveJob,
  SaveOutcome,
} from './types';

export interface RecordingState {
  sessionId: string;
  /** Epoch ms of recording start: captions are timed relative to it. */
  startedAt: number;
}

export type StartResult = { ok: true; sessionId: string } | { ok: false; error: string };

/** Handled by the background service worker. */
export interface BackgroundProtocol {
  /** Content script: the page is in a call. Tab id comes from the sender. */
  'meet/joined': { req: { meetCode: string; title?: string }; res: RecordingState | null };
  /** Content script: the local user left the call. */
  'meet/left': { req: { meetCode: string }; res: void };
  /** Content script: deduped caption revisions since the last batch. */
  'captions/batch': { req: { sessionId: string; segments: CaptionSegment[] }; res: void };

  /** Popup / keyboard command: start recording this tab (needs a user invocation). */
  'session/start': { req: { tabId: number }; res: StartResult };
  'session/stop': { req: { sessionId: string }; res: void };
  'session/route': { req: { sessionId: string; route: Route }; res: void };
  /**
   * Routing window: `hold: true` pauses the default-route countdown (the person asked for
   * more time); `hold: false` re-arms it, e.g. when the paused window is closed.
   */
  'session/route-hold': { req: { sessionId: string; hold: boolean }; res: void };
  /** `force` skips the Notion duplicate check ("Transcribe anyway"). */
  'session/transcribe': { req: { sessionId: string; force?: boolean }; res: void };
  /** `force` saves even if a page with the key exists ("Save anyway"). */
  'session/save': { req: { sessionId: string; force?: boolean }; res: void };
  'session/delete': { req: { sessionId: string }; res: void };

  /** Offscreen: chunk `index` was persisted (heartbeat). `bytes` is the session's running total. */
  'offscreen/recorder-chunk': { req: { sessionId: string; index: number; bytes: number }; res: void };
  /** Offscreen: recording ended for a reason other than a stop request, or after one. */
  'offscreen/recorder-stopped': {
    req: {
      sessionId: string;
      reason: 'requested' | 'track-ended' | 'error';
      error?: string;
      chunkCount: number;
      bytes: number;
    };
    res: void;
  };
  'offscreen/job-progress': { req: { sessionId: string; stage: JobStage }; res: void };
  /**
   * Offscreen: a job accepted earlier finished. Sent as its own message so a restarted
   * worker still gets it. At-least-once: ignore a jobId that doesn't match meta.job.id.
   */
  'offscreen/job-done': { req: JobDone; res: void };
}

export type JobDone = { sessionId: string; jobId: string } & (
  | { kind: 'process'; outcome: ProcessOutcome }
  | { kind: 'save'; outcome: SaveOutcome }
);

export type JobAccepted = { accepted: true };

export type RecorderStartResult =
  | { ok: true; startedAt: number; micIncluded: boolean; mimeType: string }
  | { ok: false; error: string };

/** Handled by the offscreen document. */
export interface OffscreenProtocol {
  'offscreen/recorder-start': {
    req: { sessionId: string; streamId: string; timesliceMs: number; includeMic: boolean };
    res: RecorderStartResult;
  };
  'offscreen/recorder-stop': { req: { sessionId: string }; res: { chunkCount: number; bytes: number } };
  'offscreen/recorder-status': { req: Record<string, never>; res: { recordingSessionIds: string[] } };
  /** Fire and forget: replies once the job is queued; the outcome comes back as 'offscreen/job-done'. */
  'offscreen/process': { req: ProcessJob & { jobId: string }; res: JobAccepted };
  'offscreen/save': { req: SaveJob & { jobId: string }; res: JobAccepted };
  /**
   * Jobs still running, plus finished ones whose job-done wasn't delivered yet (they are
   * re-sent right after this reply), so a restarted worker doesn't reset them.
   */
  'offscreen/job-status': {
    req: Record<string, never>;
    res: { jobs: { sessionId: string; jobId: string; kind: 'process' | 'save' }[] };
  };
  'offscreen/audio-scan': { req: Record<string, never>; res: AudioSessionInfo[] };
  'offscreen/audio-delete': { req: { sessionId: string }; res: void };
}

/** Pushed by the background to a Meet tab's content script. */
export interface ContentProtocol {
  'content/recording-state': { req: RecordingState | null; res: void };
}

/** Any protocol interface: each message type maps to its request and response. */
type Protocol<P> = { [K in keyof P]: { req: unknown; res: unknown } };
export type Target = 'background' | 'offscreen' | 'content';

export interface Envelope {
  __manet: true;
  target: Target;
  type: string;
  payload: unknown;
}

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

export type MessageSender = Browser.runtime.MessageSender;

export type Handlers<P extends Protocol<P>> = {
  [K in keyof P]?: (payload: P[K]['req'], sender: MessageSender) => P[K]['res'] | Promise<P[K]['res']>;
};

export function isEnvelope(msg: unknown): msg is Envelope {
  return typeof msg === 'object' && msg !== null && (msg as Envelope).__manet === true;
}

function unwrap(reply: unknown, type: string): unknown {
  if (reply === undefined) throw new Error(`No handler answered "${type}"`);
  const r = reply as Reply;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

async function send(target: Target, type: string, payload: unknown): Promise<unknown> {
  const envelope: Envelope = { __manet: true, target, type, payload };
  return unwrap(await browser.runtime.sendMessage(envelope), type);
}

export function sendToBackground<K extends keyof BackgroundProtocol & string>(
  type: K,
  payload: BackgroundProtocol[K]['req'],
): Promise<BackgroundProtocol[K]['res']> {
  return send('background', type, payload) as Promise<BackgroundProtocol[K]['res']>;
}

export function sendToOffscreen<K extends keyof OffscreenProtocol & string>(
  type: K,
  payload: OffscreenProtocol[K]['req'],
): Promise<OffscreenProtocol[K]['res']> {
  return send('offscreen', type, payload) as Promise<OffscreenProtocol[K]['res']>;
}

export async function sendToTab<K extends keyof ContentProtocol & string>(
  tabId: number,
  type: K,
  payload: ContentProtocol[K]['req'],
): Promise<ContentProtocol[K]['res']> {
  const envelope: Envelope = { __manet: true, target: 'content', type, payload };
  return unwrap(await browser.tabs.sendMessage(tabId, envelope), type) as ContentProtocol[K]['res'];
}

/** Messages the Meet content script may send; everything else needs an extension page or worker. */
const CONTENT_SCRIPT_TYPES: ReadonlySet<string> = new Set(['meet/joined', 'meet/left', 'captions/batch']);
const MEET_ORIGIN = 'https://meet.google.com/';

/**
 * Content scripts share the Meet renderer, so a compromised page could use them to
 * reach our handlers. Content-script messages must come from a Meet tab; every other
 * message must come from an extension context. (runtime.onMessage never delivers
 * messages from other extensions or web pages.) A sender without a url is accepted:
 * Chrome always sets it for content scripts and pages.
 */
export function senderAllowed(type: string, sender: MessageSender, extensionOrigin: string): boolean {
  const url = sender.url;
  if (CONTENT_SCRIPT_TYPES.has(type)) {
    return sender.tab?.id !== undefined && (url === undefined || url.startsWith(MEET_ORIGIN));
  }
  return url === undefined || url.startsWith(extensionOrigin);
}

/**
 * Registers handlers for one target. Returns an unsubscribe function.
 * Uses the sendResponse + `return true` form, which every Chrome version supports.
 */
export function handleMessages<P extends Protocol<P>>(target: Target, handlers: Handlers<P>): () => void {
  const extensionOrigin = browser.runtime.getURL('/');
  const listener = (
    msg: unknown,
    sender: MessageSender,
    sendResponse: (reply: Reply) => void,
  ): true | undefined => {
    if (!isEnvelope(msg) || msg.target !== target) return undefined;
    const handler = handlers[msg.type as keyof P];
    if (!handler) return undefined;
    if (!senderAllowed(msg.type, sender, extensionOrigin)) {
      sendResponse({ ok: false, error: `"${msg.type}" is not accepted from this sender` });
      return undefined;
    }
    Promise.resolve()
      .then(() => handler(msg.payload as never, sender))
      .then(
        (value) => sendResponse({ ok: true, value }),
        (err: unknown) => sendResponse({ ok: false, error: errorMessage(err) }),
      );
    return true;
  };
  browser.runtime.onMessage.addListener(listener as never);
  return () => browser.runtime.onMessage.removeListener(listener as never);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
