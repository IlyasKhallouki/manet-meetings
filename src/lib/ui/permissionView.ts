/**
 * The microphone permission page. Meet does not play your own voice back, so tab audio
 * holds only the other participants; the offscreen recorder mixes in the mic, but only
 * once the extension origin has been granted it here.
 */
import { h, mount, type Child } from './dom';
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

const DISMISSED = 'The prompt was closed without an answer. Click Allow microphone to ask again.';

export function createPermissionView(
  root: HTMLElement,
  handlers: PermissionHandlers,
  siteSettingsUrl: string,
): PermissionView {
  let permission: MicPermission | null = null;
  let requesting = false;
  let failure: string | undefined;

  const stateSlot = h('section', { class: 'permission-state' });
  mount(
    root,
    h('h1', null, 'Microphone access'),
    h(
      'p',
      null,
      "Manet Meetings records the Meet tab's audio. Meet does not play your own voice back to you, so that " +
        'audio only holds the other participants. To include your voice, the extension also records your ' +
        'microphone, only while a meeting is being recorded.',
    ),
    h(
      'p',
      null,
      'Chrome only lets an extension ask for the microphone from a visible page like this one, so this is a ' +
        'one-time step.',
    ),
    stateSlot,
  );

  async function request(): Promise<void> {
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
      if (result.reason !== 'denied') failure = result.message;
      else if (after !== 'denied') failure = DISMISSED;
    }
    render();
  }

  function pageState(): PageState {
    if (permission === 'granted') return 'granted';
    if (requesting) return 'requesting';
    if (permission === null) return 'checking';
    return permission === 'denied' ? 'denied' : 'prompt';
  }

  function allowButton(label: string, disabled = false): HTMLButtonElement {
    return h('button', { type: 'button', class: 'primary big', disabled, onclick: () => void request() }, label);
  }

  function content(state: PageState): Child[] {
    const alert = failure ? h('p', { class: 'error', role: 'alert' }, failure) : null;
    switch (state) {
      case 'checking':
        return [h('p', { class: 'muted' }, 'Checking the current permission…')];
      case 'requesting':
        return [
          allowButton('Allow microphone', true),
          h('p', { class: 'hint' }, "Answer Chrome's prompt next to the address bar."),
        ];
      case 'prompt':
        return [
          allowButton('Allow microphone'),
          h(
            'p',
            { class: 'hint' },
            'When Chrome asks, choose to allow it while visiting the site, not just this time: the recorder ' +
              'needs the permission later, in the background.',
          ),
          alert,
        ];
      case 'granted':
        return [
          h(
            'p',
            { class: 'notice ok', role: 'status' },
            'Microphone access granted. Your voice will be included in recordings.',
          ),
          h('button', { type: 'button', onclick: () => handlers.close() }, 'Close this tab'),
        ];
      case 'denied':
        return [
          h('p', { class: 'notice warn' }, 'The microphone is blocked for this extension.'),
          h(
            'ol',
            { class: 'steps' },
            h(
              'li',
              null,
              "Open the extension's site settings: ",
              h(
                'button',
                { type: 'button', class: 'link', onclick: () => handlers.openSiteSettings() },
                'Open site settings',
              ),
              ' or paste ',
              h('code', null, siteSettingsUrl),
              ' into the address bar.',
            ),
            h('li', null, 'Set ', h('strong', null, 'Microphone'), ' to ', h('strong', null, 'Allow'), '.'),
            h('li', null, 'Come back to this tab and click ', h('strong', null, 'Try again'), '.'),
          ),
          allowButton('Try again'),
          alert,
        ];
    }
  }

  function render(): void {
    const state = pageState();
    stateSlot.dataset.state = state;
    mount(stateSlot, content(state));
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
