/**
 * The microphone page. Meet doesn’t play your own voice back, so tab audio holds only the
 * other people; the offscreen recorder mixes in the mic, but only once the extension
 * origin has been granted it here, on a visible page.
 *
 *   [mic]                                        40 px tile; ✓ or ▲ once answered
 *   Include your voice in recordings             22/28
 *   Meet doesn’t play your own voice back…       15/22 --label, why
 *   Chrome asks next. Choose “Allow while…”      13/18 --label-2, what happens next
 *   [ Continue ]                                 the only control (privacy.md › Pre-alert)
 *
 * States: checking (quiet) · prompt (the pre-alert) · requesting (Continue inert, focus
 * kept) · granted · denied (numbered steps) · dismissed (the prompt, with a ▲ line).
 */
import { button, setDisabled, type ButtonKind } from './controls';
import { h, keepFocus, mount, type Child } from './dom';
import { svg, type Glyph } from './icons';
import { micFailure, type MicPermission, type MicRequestResult } from './mic';

export interface PermissionHandlers {
  request(): Promise<MicRequestResult>;
  query(): Promise<MicPermission>;
  openSiteSettings(): void;
  close(): void;
}

export interface PermissionView {
  update(permission: MicPermission): void;
}

type PageState = 'checking' | 'prompt' | 'requesting' | 'granted' | 'denied';

const ASKING = 'Answer Chrome’s prompt next to the address bar.';

/** A request that didn't end in a grant, kept as a reason so the words can name the button. */
interface Failure {
  reason: 'dismissed' | 'no-device' | 'error';
  message: string;
}

function sentence(text: string): string {
  return /[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** Every failure names the next step, with the label of the button on screen (`retry`). */
function failureText(failure: Failure, retry: string): string {
  switch (failure.reason) {
    case 'dismissed':
      return `Chrome’s prompt closed without an answer. Choose ${retry} to ask again.`;
    case 'no-device':
      return `No microphone was found. Plug one in, then choose ${retry}.`;
    case 'error':
      return `${sentence(failure.message)} Choose ${retry} to try again.`;
  }
}

const HEADLINE = {
  prompt: 'Include your voice in recordings',
  granted: 'Your voice will be included',
  denied: 'The microphone is blocked',
} as const;

export function createPermissionView(
  root: HTMLElement,
  handlers: PermissionHandlers,
  siteSettingsUrl: string,
): PermissionView {
  const doc = root.ownerDocument;
  let permission: MicPermission | null = null;
  let requesting = false;
  let failure: Failure | undefined;
  let shown: PageState | null = null;

  const stateSlot = h('section', { class: 'perm' });
  // One polite region that outlives the re-rendered content, so each change is spoken once.
  const announcer = h('p', { class: 'visually-hidden', role: 'status', 'data-role': 'announce' });
  mount(root, stateSlot, announcer);

  async function request(): Promise<void> {
    if (requesting) return;
    requesting = true;
    failure = undefined;
    render();
    let result: MicRequestResult;
    try {
      result = await handlers.request();
    } catch (err) {
      result = micFailure(err);
    }
    let after: MicPermission;
    try {
      after = await handlers.query();
    } catch {
      after = 'unknown';
    }
    requesting = false;
    permission = result.ok ? 'granted' : after;
    if (!result.ok) {
      // NotAllowedError means blocked, or a prompt closed without an answer (still 'prompt').
      if (result.reason !== 'denied') failure = { reason: result.reason, message: result.message };
      else if (after !== 'denied') failure = { reason: 'dismissed', message: result.message };
    }
    render();
  }

  function pageState(): PageState {
    if (permission === 'granted') return 'granted';
    if (requesting) return 'requesting';
    if (permission === null) return 'checking';
    return permission === 'denied' ? 'denied' : 'prompt';
  }

  function tile(glyph: Glyph, tone: string): HTMLElement {
    return h('div', { class: `perm-tile ${tone}` }, svg(glyph));
  }

  function action(label: string, kind: ButtonKind, key: string, onClick: () => void, busy = false) {
    const el = button(label, { kind, onClick, attrs: { 'data-key': key } });
    if (busy) setDisabled(el, true);
    return el;
  }

  function failureLine(retry: string): HTMLElement | null {
    if (!failure) return null;
    return h(
      'p',
      { class: 'perm-alert', role: 'alert' },
      svg('caution', { class: 'tone-caution' }),
      h('span', null, failureText(failure, retry)),
    );
  }

  function prompt(busy: boolean): Child[] {
    return [
      tile('mic', 'tone-none'),
      h('h1', { class: 't-title1' }, HEADLINE.prompt),
      h(
        'p',
        { class: 'perm-lead' },
        "Meet doesn’t play your own voice back to you, so the call audio only has the other people. " +
          "To include what you say, Manet Meetings also records your microphone, only while you’re recording a call.",
      ),
      h(
        'p',
        { class: 'perm-note' },
        'Chrome asks next. Choose “Allow while visiting the site”, so recordings can use the microphone later ' +
          'from the background. You only do this once.',
      ),
      h('div', { class: 'perm-actions' }, action('Continue', 'prominent', 'continue', () => void request(), busy)),
      busy ? h('p', { class: 'perm-hint' }, ASKING) : failureLine('Continue'),
    ];
  }

  function denied(busy: boolean): Child[] {
    return [
      tile('caution', 'tone-caution'),
      h('h1', { class: 't-title1' }, HEADLINE.denied),
      h(
        'p',
        { class: 'perm-lead' },
        'Chrome blocks the microphone for Manet Meetings, so only the other people will be recorded. To allow it:',
      ),
      h(
        'ol',
        { class: 'perm-steps' },
        h('li', null, 'Open site settings for Manet Meetings.'),
        h('li', null, 'Set Microphone to Allow.'),
        h('li', null, 'Come back here and choose Try again.'),
      ),
      h(
        'div',
        { class: 'perm-actions' },
        action('Open site settings', 'prominent', 'site-settings', () => handlers.openSiteSettings()),
        action('Try again', 'bordered', 'try-again', () => void request(), busy),
      ),
      busy ? h('p', { class: 'perm-hint' }, ASKING) : failureLine('Try again'),
      h('p', { class: 'perm-url' }, 'Or paste ', h('code', null, siteSettingsUrl), ' into the address bar.'),
    ];
  }

  function granted(): Child[] {
    return [
      tile('done', 'tone-done'),
      h('h1', { class: 't-title1' }, HEADLINE.granted),
      h('p', { class: 'perm-lead' }, 'Chrome now allows the microphone for Manet Meetings. You can close this tab.'),
      h('div', { class: 'perm-actions' }, action('Close tab', 'bordered', 'close', () => handlers.close())),
    ];
  }

  function content(state: PageState): Child[] {
    switch (state) {
      case 'checking':
        return [h('p', { class: 'perm-checking' }, "Checking Chrome’s microphone setting…")];
      case 'requesting':
        return permission === 'denied' ? denied(true) : prompt(true);
      case 'prompt':
        return prompt(false);
      case 'denied':
        return denied(false);
      case 'granted':
        return granted();
    }
  }

  function announcement(state: PageState): string {
    switch (state) {
      case 'requesting':
        return ASKING;
      case 'granted':
        return `${HEADLINE.granted}.`;
      case 'denied':
        return `${HEADLINE.denied}.`;
      default:
        return ''; // a failure speaks through its own role=alert line
    }
  }

  function render(): void {
    const state = pageState();
    const active = doc.activeElement;
    const hadFocus = active !== null && root.contains(active);
    stateSlot.dataset.state = state;
    keepFocus(stateSlot, () => mount(stateSlot, content(state)));
    if (state !== shown) {
      // The first answer after loading is read with the page; later changes are spoken.
      if (shown !== null && shown !== 'checking') announcer.textContent = announcement(state);
      shown = state;
    }
    // The focused control went away (Continue → Close tab): land on the new first action.
    if (hadFocus && !root.contains(doc.activeElement)) {
      stateSlot.querySelector<HTMLElement>('.perm-actions .btn')?.focus();
    }
  }

  render();
  return {
    update(next) {
      permission = next;
      if (next === 'granted') failure = undefined;
      render();
    },
  };
}
