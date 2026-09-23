import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryMicPermission, requestMicAccess, type MicPermission, type MicRequestResult } from '@lib/ui/mic';
import { createPermissionView, type PermissionHandlers } from '@lib/ui/permissionView';

const SETTINGS_URL = 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fabcdefghijklmnop';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('main');
  document.body.append(root);
});
afterEach(() => root.remove());

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
const state = () => root.querySelector('[data-state]')?.getAttribute('data-state');
const announced = () => text(root.querySelector('[data-role="announce"]'));
const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Answers from sample data, for the states headless Chrome cannot produce. */
function sample(result: MicRequestResult | Promise<MicRequestResult>, after: MicPermission) {
  const calls: string[] = [];
  const handlers: PermissionHandlers = {
    request: async () => {
      calls.push('request');
      return result;
    },
    query: async () => after,
    openSiteSettings: () => void calls.push('openSiteSettings'),
    close: () => void calls.push('close'),
  };
  return { calls, handlers };
}

describe('permission page with the real Permissions API and getUserMedia', () => {
  it('shows the real state, and the real outcome of a click', async () => {
    const calls: string[] = [];
    const view = createPermissionView(
      root,
      {
        request: requestMicAccess,
        query: queryMicPermission,
        openSiteSettings: () => void calls.push('openSiteSettings'),
        close: () => void calls.push('close'),
      },
      SETTINGS_URL,
    );
    const initial = await queryMicPermission();
    view.update(initial);
    if (initial === 'granted') {
      expect(state()).toBe('granted');
      return;
    }
    const action = button('Continue') ?? button('Try again');
    expect(action).toBeDefined();
    action!.click();
    await until(() => state() !== 'requesting');
    const after = await queryMicPermission();
    if (after === 'granted') expect(state()).toBe('granted');
    else expect(['denied', 'prompt']).toContain(state());
    // Headless Chrome under Playwright may refuse the mic: the page must say how to fix it.
    if (after === 'denied') {
      expect(text(root)).toContain(SETTINGS_URL);
      button('Open site settings')!.click();
      expect(calls).toEqual(['openSiteSettings']);
    }
  });
});

describe('permission page: the pre-alert', () => {
  it('explains why, says what Chrome asks next, and offers only Continue', () => {
    const view = createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    view.update('prompt');
    expect(state()).toBe('prompt');
    expect(text(root.querySelector('h1'))).toBe('Include your voice in recordings');
    expect(text(root)).toMatch(/Meet doesn’t play your own voice back to you/);
    // Curly quotes and apostrophes, as in the popup and Settings.
    expect(text(root)).not.toMatch(/'/);
    expect(text(root)).toMatch(/Chrome asks next\. Choose “Allow while visiting the site”/);
    // privacy.md › Pre-alert: one button, titled Continue, no way out.
    const buttons = [...root.querySelectorAll('button')];
    expect(buttons.map((b) => text(b))).toEqual(['Continue']);
    expect(buttons[0]!.classList.contains('prominent')).toBe(true);
    // Nothing is focused for the person: they read first.
    expect(root.contains(document.activeElement)).toBe(false);
  });

  it('treats an unknown permission like a first request', () => {
    const view = createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    view.update('unknown');
    expect(state()).toBe('prompt');
    expect(button('Continue')).toBeDefined();
  });

  it('while Chrome asks, keeps Continue focused but inert and points at the prompt', async () => {
    let answer!: (r: MicRequestResult) => void;
    const s = sample(new Promise<MicRequestResult>((r) => (answer = r)), 'prompt');
    const view = createPermissionView(root, s.handlers, SETTINGS_URL);
    view.update('prompt');
    const cont = button('Continue')!;
    cont.focus();
    cont.click();
    expect(state()).toBe('requesting');
    expect(button('Continue')!.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(button('Continue'));
    expect(text(root)).toContain('Answer Chrome’s prompt next to the address bar.');
    expect(announced()).toBe('Answer Chrome’s prompt next to the address bar.');
    button('Continue')!.click();
    expect(s.calls).toEqual(['request']);
    answer({ ok: false, reason: 'denied', message: 'Microphone access was blocked.' });
    await until(() => state() !== 'requesting');
  });
});

describe('permission page: outcomes', () => {
  it('confirms success, announces it, focuses Close tab', async () => {
    const s = sample({ ok: true }, 'granted');
    const view = createPermissionView(root, s.handlers, SETTINGS_URL);
    view.update('prompt');
    button('Continue')!.focus();
    button('Continue')!.click();
    await until(() => state() === 'granted');
    expect(text(root.querySelector('h1'))).toBe('Your voice will be included');
    expect(text(root)).toContain('Chrome now allows the microphone for Minute Book. You can close this tab.');
    expect(root.querySelector('.perm-tile .glyph-done')).not.toBeNull();
    expect(announced()).toBe('Your voice will be included.');
    expect(document.activeElement).toBe(button('Close tab'));
    button('Close tab')!.click();
    expect(s.calls).toEqual(['request', 'close']);
  });

  it('explains how to unblock a denied microphone, in numbered steps', () => {
    const s = sample({ ok: true }, 'granted');
    const view = createPermissionView(root, s.handlers, SETTINGS_URL);
    view.update('denied');
    expect(state()).toBe('denied');
    expect(text(root.querySelector('h1'))).toBe('The microphone is blocked');
    expect(root.querySelector('.perm-tile .glyph-caution')).not.toBeNull();
    const steps = [...root.querySelectorAll('ol > li')].map((li) => text(li));
    expect(steps).toEqual([
      'Open site settings for Minute Book.',
      'Set Microphone to Allow.',
      'Come back here and choose Try again.',
    ]);
    expect(root.querySelector('code')?.textContent).toBe(SETTINGS_URL);
    const open = button('Open site settings')!;
    expect(open.classList.contains('prominent')).toBe(true);
    open.click();
    expect(s.calls).toEqual(['openSiteSettings']);
    expect(button('Try again')).toBeDefined();
    // Blocked is not a pre-alert: no Continue.
    expect(button('Continue')).toBeUndefined();
  });

  it('Try again asks Chrome again', async () => {
    const s = sample({ ok: true }, 'granted');
    const view = createPermissionView(root, s.handlers, SETTINGS_URL);
    view.update('denied');
    button('Try again')!.click();
    await until(() => state() === 'granted');
    expect(s.calls).toEqual(['request']);
  });

  it("asks again when Chrome's prompt closed without an answer", async () => {
    const view = createPermissionView(
      root,
      sample({ ok: false, reason: 'denied', message: 'Microphone access was blocked.' }, 'prompt').handlers,
      SETTINGS_URL,
    );
    view.update('prompt');
    button('Continue')!.focus();
    button('Continue')!.click();
    await until(() => state() !== 'requesting');
    expect(state()).toBe('prompt');
    const alert = root.querySelector('[role="alert"]')!;
    expect(text(alert)).toBe('Chrome’s prompt closed without an answer. Choose Continue to ask again.');
    expect(alert.querySelector('.glyph-caution')).not.toBeNull();
    // The same Continue keeps focus.
    expect(document.activeElement).toBe(button('Continue'));
  });

  it('reports a missing microphone, naming the button to choose next', async () => {
    const message = 'No microphone was found. Plug one in and try again.';
    const view = createPermissionView(
      root,
      sample({ ok: false, reason: 'no-device', message }, 'prompt').handlers,
      SETTINGS_URL,
    );
    view.update('prompt');
    button('Continue')!.click();
    await until(() => !!root.querySelector('[role="alert"]'));
    expect(text(root.querySelector('[role="alert"]'))).toBe('No microphone was found. Plug one in, then choose Continue.');
  });

  it('reports a busy microphone with the next step', async () => {
    const message = 'The microphone could not be opened. Another app may be using it.';
    const view = createPermissionView(root, sample({ ok: false, reason: 'error', message }, 'prompt').handlers, SETTINGS_URL);
    view.update('prompt');
    button('Continue')!.click();
    await until(() => !!root.querySelector('[role="alert"]'));
    expect(text(root.querySelector('[role="alert"]'))).toBe(`${message} Choose Continue to try again.`);
  });

  it('follows permission changes made elsewhere, without taking focus', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const view = createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    view.update('denied');
    view.update('granted');
    expect(state()).toBe('granted');
    expect(announced()).toBe('Your voice will be included.');
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('shows nothing but a quiet line while it checks', () => {
    createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    expect(state()).toBe('checking');
    expect(root.querySelectorAll('button')).toHaveLength(0);
    expect(root.querySelector('h1')).toBeNull();
  });
});
