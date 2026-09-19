/**
 * The toolbar popup: what the active tab allows (record, stop, or nothing), the mic
 * permission and missing settings. popupState/micView are pure; createPopupView renders.
 */
import { meetCodeFromUrl } from '../meet/meetCode';
import type { ActiveRecording } from '../storage/sessionStore';
import type { SessionMeta } from '../types';
import { formatClock } from '../util/time';
import { h, keepFocus, mount, type Child } from './dom';
import type { MicPermission } from './mic';

export type PopupState =
  /** `onMeet`: on meet.google.com but not in a call (home page, landing page). */
  | { kind: 'not-meet'; onMeet: boolean }
  | { kind: 'idle'; tabId: number; meetCode: string }
  | {
      kind: 'recording';
      sessionId: string;
      startedAt: number;
      meetCode: string;
      title?: string;
      /** The recording belongs to the active tab. */
      thisTab: boolean;
      /** Set when audio could not be captured: captions only. */
      audioError?: string;
      /** Caption batches received so far: who said what. */
      captionCount: number;
      /** Why captions are not reaching the extension, when the background knows. */
      captionsError?: string;
    };

export interface PopupInput {
  tab: { id?: number; url?: string } | null;
  active: ActiveRecording | null;
  /** The session the active-recording pointer names, if any. */
  session: SessionMeta | null;
}

export function popupState({ tab, active, session }: PopupInput): PopupState {
  if (active && session && session.id === active.sessionId && session.status === 'recording') {
    const state: Extract<PopupState, { kind: 'recording' }> = {
      kind: 'recording',
      sessionId: session.id,
      startedAt: session.startedAt,
      meetCode: session.meetCode,
      thisTab: tab?.id === active.tabId,
      captionCount: session.captionCount,
    };
    if (session.meetingTitle) state.title = session.meetingTitle;
    if (session.audio.error) state.audioError = session.audio.error;
    if (session.captionsError) state.captionsError = session.captionsError;
    return state;
  }
  const url = tab?.url ?? '';
  const tabId = tab?.id;
  const meetCode = meetCodeFromUrl(url);
  if (meetCode && tabId !== undefined) return { kind: 'idle', tabId, meetCode };
  let onMeet = false;
  try {
    onMeet = new URL(url).hostname === 'meet.google.com';
  } catch {
    onMeet = false;
  }
  return { kind: 'not-meet', onMeet };
}

/** Meet shows the first caption within seconds of speech; this long without one, CC is likely off. */
export const NO_CAPTIONS_AFTER_MS = 20_000;

/** Why the recording may end up without speaker names, if it might. */
export function captionsNotice(state: Extract<PopupState, { kind: 'recording' }>, now: number): string | undefined {
  if (state.captionsError) return state.captionsError;
  if (state.captionCount === 0 && now - state.startedAt >= NO_CAPTIONS_AFTER_MS) {
    return 'No captions yet — make sure captions are on (CC) so speakers are identified.';
  }
  return undefined;
}

export interface MicView {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
  /** Show the button that opens the permission page. */
  canRequest: boolean;
}

export function micView(state: MicPermission, includeMic: boolean): MicView {
  if (!includeMic) {
    return {
      text: 'Microphone off in settings: only the other participants are recorded.',
      tone: 'muted',
      canRequest: false,
    };
  }
  switch (state) {
    case 'granted':
      return { text: 'Microphone on: your voice is recorded too.', tone: 'ok', canRequest: false };
    case 'denied':
      return {
        text: 'Microphone blocked: only the other participants will be recorded.',
        tone: 'warn',
        canRequest: true,
      };
    case 'prompt':
      return {
        text: 'Microphone not allowed yet: only the other participants will be recorded.',
        tone: 'warn',
        canRequest: true,
      };
    case 'unknown':
      return {
        text: 'Microphone status unknown: only the other participants may be recorded.',
        tone: 'warn',
        canRequest: true,
      };
  }
}

export interface PopupModel {
  /** Null while loading. */
  state: PopupState | null;
  mic: MicView | null;
  /** Settings that block saving to Notion. */
  missing: readonly string[];
  /** No Gemini key: meetings are still saved, with a captions-only transcript. */
  geminiKeyMissing: boolean;
}

export interface PopupHandlers {
  /** Rejects with a user-facing message when the recording could not start. */
  record(tabId: number): Promise<void>;
  stop(sessionId: string): Promise<void>;
  grantMic(): void;
  openSettings(): void;
  openDashboard(): void;
}

export interface PopupView {
  update(model: PopupModel, now: number): void;
}

export function createPopupView(root: HTMLElement, handlers: PopupHandlers): PopupView {
  let model: PopupModel | null = null;
  let now = 0;
  let busy = false;
  let error: string | undefined;
  let signature = '';
  let captionsShown: string | undefined;

  const loading = () => h('p', { class: 'muted' }, 'Loading…');
  const stateSlot = h('section', { class: 'state', 'data-role': 'state', 'aria-live': 'polite' }, loading());
  // Apart from the state section: it appears as time passes, and must not rebuild Stop.
  const captionsSlot = h('div');
  const errorSlot = h('div');
  const noticeSlot = h('div', { class: 'notices' });
  const link = (key: string, label: string, onclick: () => void) =>
    h('button', { type: 'button', class: 'link', 'data-key': key, onclick }, label);
  const footer = h(
    'footer',
    { class: 'popup-foot' },
    link('dashboard', 'Dashboard', () => handlers.openDashboard()),
    link('settings', 'Settings', () => handlers.openSettings()),
  );
  const header = h('header', { class: 'popup-head' }, h('h1', null, 'Manet Meetings'));
  mount(root, header, stateSlot, captionsSlot, errorSlot, noticeSlot, footer);

  function run(request: () => Promise<void>): void {
    busy = true;
    error = undefined;
    let promise: Promise<void>;
    try {
      promise = request();
    } catch (err) {
      promise = Promise.reject(err);
    }
    render(true);
    promise
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        busy = false;
        render(true);
      });
  }

  function stateContent(state: PopupState): Child[] {
    switch (state.kind) {
      case 'not-meet':
        return [
          h(
            'p',
            null,
            state.onMeet ? 'Join the call, then record it from here.' : 'Open a Google Meet call to record it.',
          ),
        ];
      case 'idle':
        return [
          h('p', null, 'Meet call ', h('code', null, state.meetCode)),
          h(
            'button',
            {
              type: 'button',
              class: 'primary big',
              'data-key': 'record',
              disabled: busy,
              onclick: () => run(() => handlers.record(state.tabId)),
            },
            busy ? 'Starting…' : 'Record',
          ),
          h('p', { class: 'hint' }, 'Captions are turned on while recording: they tell who is speaking.'),
        ];
      case 'recording':
        return [
          h(
            'p',
            { class: 'recording-line' },
            h('span', { class: 'rec-dot', 'aria-hidden': 'true' }),
            'Recording ',
            // Explicitly off: the state section is a live region and this changes every second.
            h(
              'span',
              { class: 'clock', role: 'timer', 'aria-live': 'off', 'data-role': 'clock' },
              formatClock(now - state.startedAt),
            ),
          ),
          h('p', { class: 'muted' }, state.title ? `${state.title} · ${state.meetCode}` : state.meetCode),
          state.thisTab ? null : h('p', { class: 'hint' }, 'This call is recording in another tab.'),
          state.audioError
            ? h('p', { class: 'notice warn' }, `No audio: ${state.audioError}. Captions are still recorded.`)
            : null,
          h(
            'button',
            {
              type: 'button',
              class: 'danger big',
              'data-key': 'stop',
              disabled: busy,
              onclick: () => run(() => handlers.stop(state.sessionId)),
            },
            busy ? 'Stopping…' : 'Stop recording',
          ),
        ];
    }
  }

  function render(force = false): void {
    const m = model;
    if (!m) return;
    const captions = m.state?.kind === 'recording' ? captionsNotice(m.state, now) : undefined;
    if (captions !== captionsShown) {
      captionsShown = captions;
      mount(captionsSlot, captions ? h('p', { class: 'notice warn', 'data-role': 'captions' }, captions) : null);
    }
    const sig = JSON.stringify([m, busy, error]);
    if (!force && sig === signature) {
      // Only the clock moved.
      const clock = root.querySelector('[data-role="clock"]');
      if (clock && m.state?.kind === 'recording') clock.textContent = formatClock(now - m.state.startedAt);
      return;
    }
    signature = sig;
    keepFocus(root, () => {
      mount(stateSlot, m.state ? stateContent(m.state) : loading());
      mount(errorSlot, error ? h('p', { class: 'error', role: 'alert' }, error) : null);
      mount(
        noticeSlot,
        m.missing.length
          ? h(
              'div',
              { class: 'notice warn', 'data-role': 'missing' },
              h('span', null, `Saving to Notion needs: ${m.missing.join(', ')}.`),
              link('missing-settings', 'Open settings', () => handlers.openSettings()),
            )
          : null,
        m.geminiKeyMissing
          ? h(
              'div',
              { class: 'notice muted', 'data-role': 'no-gemini' },
              h('span', null, "No Gemini API key: transcripts come from Meet's captions only."),
              link('no-gemini-settings', 'Open settings', () => handlers.openSettings()),
            )
          : null,
        m.mic
          ? h(
              'div',
              { class: `notice ${m.mic.tone}`, 'data-role': 'mic' },
              h('span', null, m.mic.text),
              m.mic.canRequest ? link('grant-mic', 'Allow microphone', () => handlers.grantMic()) : null,
            )
          : null,
      );
    });
  }

  return {
    update(next, at) {
      model = next;
      now = at;
      render();
    },
  };
}
