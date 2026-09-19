import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryMicPermission, requestMicAccess, type MicPermission, type MicRequestResult } from '@lib/ui/mic';
import { createPermissionView, type PermissionHandlers } from '@lib/ui/permissionView';

const SETTINGS_URL = 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fabcdefghijklmnop';

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => root.remove());

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Answers from sample data, for the states headless Chrome cannot produce. */
function sample(result: MicRequestResult, after: MicPermission) {
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
    expect(text(root)).toMatch(/other participants/);
    const initial = await queryMicPermission();
    view.update(initial);
    const action = button('Allow microphone') ?? button('Try again');
    if (initial === 'granted') {
      expect(root.querySelector('[data-state="granted"]')).not.toBeNull();
      return;
    }
    expect(action).toBeDefined();
    action!.click();
    await until(() => !root.querySelector('[data-state="requesting"]'));
    const after = await queryMicPermission();
    const state = root.querySelector('[data-state]')?.getAttribute('data-state');
    if (after === 'granted') expect(state).toBe('granted');
    else expect(['denied', 'prompt']).toContain(state);
    // Headless Chrome under Playwright refuses the mic: the page must say how to fix it.
    if (after === 'denied') {
      expect(text(root)).toContain(SETTINGS_URL);
      button('Open site settings')!.click();
      expect(calls).toEqual(['openSiteSettings']);
    }
  });
});

describe('permission page states', () => {
  it('confirms success and offers to close the tab', async () => {
    const s = sample({ ok: true }, 'granted');
    const view = createPermissionView(root, s.handlers, SETTINGS_URL);
    view.update('prompt');
    button('Allow microphone')!.click();
    await until(() => !!root.querySelector('[data-state="granted"]'));
    expect(text(root.querySelector('[role="status"]'))).toMatch(/granted/i);
    button('Close this tab')!.click();
    expect(s.calls).toEqual(['request', 'close']);
  });

  it('explains how to unblock a denied microphone', () => {
    const view = createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    view.update('denied');
    const denied = root.querySelector('[data-state="denied"]')!;
    expect(text(denied)).toMatch(/blocked/i);
    expect(text(denied)).toMatch(/Microphone.*Allow/);
    expect(denied.querySelector('code')?.textContent).toBe(SETTINGS_URL);
    expect(button('Try again')).toBeDefined();
  });

  it('asks again when the prompt was dismissed rather than blocked', async () => {
    const view = createPermissionView(
      root,
      sample({ ok: false, reason: 'denied', message: 'Microphone access was blocked.' }, 'prompt').handlers,
      SETTINGS_URL,
    );
    view.update('prompt');
    button('Allow microphone')!.click();
    await until(() => !root.querySelector('[data-state="requesting"]'));
    expect(root.querySelector('[data-state="prompt"]')).not.toBeNull();
    expect(text(root.querySelector('[role="alert"]'))).toMatch(/closed without an answer/);
  });

  it('reports a missing or busy microphone', async () => {
    const message = 'No microphone was found. Plug one in and try again.';
    const view = createPermissionView(
      root,
      sample({ ok: false, reason: 'no-device', message }, 'prompt').handlers,
      SETTINGS_URL,
    );
    view.update('prompt');
    button('Allow microphone')!.click();
    await until(() => !!root.querySelector('[role="alert"]'));
    expect(text(root.querySelector('[role="alert"]'))).toBe(message);
  });

  it('follows permission changes made elsewhere', () => {
    const view = createPermissionView(root, sample({ ok: true }, 'granted').handlers, SETTINGS_URL);
    view.update('denied');
    view.update('granted');
    expect(root.querySelector('[data-state="granted"]')).not.toBeNull();
  });
});
