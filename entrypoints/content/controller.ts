/**
 * Content-script logic for a Meet tab, kept free of timers and extension APIs so it runs
 * against real Meet fixtures in tests: index.ts drives tick()/flushCaptions() once a
 * second and plugs in runtime messaging.
 *
 * In a call it announces meet/joined; while the background reports a recording it keeps
 * captions on, feeds the caption tracker and ships deduped revisions in captions/batch;
 * when the call ends it flushes the last captions, then sends meet/left.
 */
import { CaptionTracker } from '@lib/captions/tracker';
import { CaptionWatcher } from '@lib/captions/watcher';
import {
  adapterHealth,
  captionsEnabled,
  enableCaptions,
  isInCall,
  meetingTitle,
} from '@lib/meet/captionAdapter';
import { meetCodeFromUrl } from '@lib/meet/meetCode';
import type { BackgroundProtocol, RecordingState } from '@lib/messages';
import type { CaptionSegment } from '@lib/types';

export type SendToBackground = <K extends keyof BackgroundProtocol & string>(
  type: K,
  payload: BackgroundProtocol[K]['req'],
) => Promise<BackgroundProtocol[K]['res']>;

export interface MeetControllerDeps {
  doc: Document;
  /** Current page URL; Meet is a single-page app. */
  url: () => string;
  send: SendToBackground;
  /** Epoch ms. */
  clock?: () => number;
  log?: (message: string, detail?: unknown) => void;
}

/** Meet fills in the calendar title shortly after the call UI appears. */
const JOIN_TITLE_GRACE_MS = 3000;
/** Time for Meet to react to a CC click before judging whether it worked. */
const CAPTIONS_RETRY_MS = 3000;
/** Stop clicking after this many tries so we never fight a user who turned captions off. */
const MAX_CAPTION_CLICKS = 3;
const HEALTH_LOG_DELAY_MS = 15_000;

interface Call {
  meetCode: string;
  since: number;
  joinSent: boolean;
  healthLogged: boolean;
}

interface Capture {
  sessionId: string;
  tracker: CaptionTracker<Element>;
  watcher: CaptionWatcher;
  captionClicks: number;
  captionsConfirmed: boolean;
  nextCaptionTry: number;
}

export class MeetController {
  private readonly deps: MeetControllerDeps;
  private call: Call | null = null;
  private capture: Capture | null = null;
  /** Unsent segments per session, latest revision per id. */
  private readonly outbox = new Map<string, Map<string, CaptionSegment>>();
  private ticking: Promise<void> | null = null;

  constructor(deps: MeetControllerDeps) {
    this.deps = deps;
  }

  /** Detects joining/leaving and keeps the capture attached. Concurrent calls share one run. */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Background pushed a recording state (or meet/joined returned one). */
  async setRecording(state: RecordingState | null): Promise<void> {
    try {
      if (state && this.capture?.sessionId === state.sessionId) return;
      this.stopCapture();
      if (state) this.startCapture(state);
    } catch (err) {
      this.log('could not switch recording state', err);
    }
    await this.flushCaptions();
  }

  /** Sends every unsent caption revision. Failed batches are kept for the next flush. */
  async flushCaptions(): Promise<void> {
    if (this.capture) {
      this.capture.watcher.flush();
      this.collect(this.capture);
    }
    const sends: Promise<void>[] = [];
    for (const [sessionId, byId] of this.outbox) {
      this.outbox.delete(sessionId);
      const segments = [...byId.values()].sort((a, b) => a.tStart - b.tStart);
      if (segments.length === 0) continue;
      sends.push(
        this.deps.send('captions/batch', { sessionId, segments }).then(
          () => undefined,
          (err: unknown) => {
            this.enqueue(sessionId, segments);
            this.log('caption batch not delivered, will retry', err);
          },
        ),
      );
    }
    await Promise.all(sends);
  }

  /**
   * The tab is going away: dispatch the last batch and meet/left right now, in that
   * order, without waiting for replies the page will not live to receive.
   */
  pageHide(): void {
    const call = this.call;
    this.call = null;
    this.stopCapture();
    void this.flushCaptions();
    if (call) void this.sendLeft(call.meetCode);
  }

  dispose(): void {
    this.capture?.watcher.stop();
    this.capture = null;
  }

  private async runTick(): Promise<void> {
    try {
      const doc = this.deps.doc;
      const code = meetCodeFromUrl(this.deps.url());
      const inCall = code !== null && isInCall(doc);
      if (this.call && (!inCall || this.call.meetCode !== code)) await this.leave();
      if (inCall && code && !this.call) {
        this.call = { meetCode: code, since: this.now(), joinSent: false, healthLogged: false };
      }
      const join = this.call && !this.call.joinSent ? this.maybeJoin(this.call) : null;
      if (this.capture) {
        this.capture.watcher.sync();
        this.ensureCaptions(this.capture);
      }
      this.logHealthOnce();
      await join;
    } catch (err) {
      this.log('tick failed', err);
    }
  }

  private async maybeJoin(call: Call): Promise<void> {
    const title = meetingTitle(this.deps.doc);
    if (!title && this.now() - call.since < JOIN_TITLE_GRACE_MS) return;
    call.joinSent = true;
    try {
      const { meetCode } = call;
      const state = await this.deps.send('meet/joined', title ? { meetCode, title } : { meetCode });
      if (state && this.call === call) await this.setRecording(state);
    } catch (err) {
      this.log('meet/joined failed', err);
    }
  }

  private async leave(): Promise<void> {
    const call = this.call;
    this.call = null;
    this.stopCapture();
    await this.flushCaptions();
    if (call) await this.sendLeft(call.meetCode);
  }

  private async sendLeft(meetCode: string): Promise<void> {
    try {
      await this.deps.send('meet/left', { meetCode });
    } catch (err) {
      this.log('meet/left failed', err);
    }
  }

  private startCapture(state: RecordingState): void {
    const tracker = new CaptionTracker<Element>();
    const watcher = new CaptionWatcher({
      doc: this.deps.doc,
      tracker,
      now: () => this.now() - state.startedAt,
      skipExisting: true,
      onError: (err) => this.log('caption watcher error', err),
    });
    const capture: Capture = {
      sessionId: state.sessionId,
      tracker,
      watcher,
      captionClicks: 0,
      captionsConfirmed: false,
      nextCaptionTry: 0,
    };
    this.capture = capture;
    // Sync before touching the CC toggle: whatever is on screen now predates the recording.
    watcher.sync();
    this.ensureCaptions(capture);
  }

  private stopCapture(): void {
    const capture = this.capture;
    if (!capture) return;
    this.capture = null;
    capture.watcher.stop();
    this.collect(capture);
  }

  private ensureCaptions(capture: Capture): void {
    if (capture.captionsConfirmed || this.now() < capture.nextCaptionTry) return;
    const on = captionsEnabled(this.deps.doc);
    if (on === true) {
      capture.captionsConfirmed = true;
      return;
    }
    // null: toolbar not rendered yet; try again next tick.
    if (on !== false || capture.captionClicks >= MAX_CAPTION_CLICKS) return;
    if (enableCaptions(this.deps.doc)) {
      capture.captionClicks++;
      capture.nextCaptionTry = this.now() + CAPTIONS_RETRY_MS;
      if (capture.captionClicks === MAX_CAPTION_CLICKS) this.log('last automatic attempt to turn captions on');
    }
  }

  private collect(capture: Capture): void {
    const segments = capture.tracker.drainChanges();
    if (segments.length > 0) this.enqueue(capture.sessionId, segments);
  }

  private enqueue(sessionId: string, segments: CaptionSegment[]): void {
    let byId = this.outbox.get(sessionId);
    if (!byId) {
      byId = new Map();
      this.outbox.set(sessionId, byId);
    }
    for (const seg of segments) {
      const queued = byId.get(seg.id);
      if (!queued || seg.rev > queued.rev) byId.set(seg.id, seg);
    }
  }

  private logHealthOnce(): void {
    const call = this.call;
    if (!call || call.healthLogged) return;
    if (this.capture?.watcher.observing || this.now() - call.since >= HEALTH_LOG_DELAY_MS) {
      call.healthLogged = true;
      this.log('Meet adapter health', adapterHealth(this.deps.doc));
    }
  }

  private now(): number {
    return this.deps.clock?.() ?? Date.now();
  }

  private log(message: string, detail?: unknown): void {
    if (this.deps.log) this.deps.log(message, detail);
    else console.info(`[manet] ${message}`, detail ?? '');
  }
}
