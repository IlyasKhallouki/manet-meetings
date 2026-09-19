import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { handleMessages, type BackgroundProtocol, type Handlers } from '@lib/messages';
import { deleteResult, putResult } from '@lib/storage/resultStore';
import { putSession, setActiveRecording } from '@lib/storage/sessionStore';
import type { SessionMeta, SessionResult } from '@lib/types';
import {
  listResultIds,
  loadPopupInput,
  openExtensionPage,
  openSettings,
  siteSettingsUrl,
  startRecording,
  watchResultIds,
} from '@lib/ui/extension';

type Background = { [K in keyof BackgroundProtocol]: BackgroundProtocol[K] };

const RESULT: SessionResult = {
  title: 'Weekly sync',
  attendees: ['Ilya'],
  transcript: { turns: [], source: 'captions-only', notes: [] },
  summary: null,
  transcription: null,
  createdAt: 1,
};

function meta(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt: 1,
    status: 'recording',
    idempotencyKey: 'abc-defg-hij-1970-01-01',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('openExtensionPage', () => {
  it('opens the page in a new tab', async () => {
    await openExtensionPage('/dashboard.html');
    const tabs = await browser.tabs.query({ url: browser.runtime.getURL('/dashboard.html') });
    expect(tabs).toHaveLength(1);
  });

  it('brings back a tab that already shows the page instead of opening another', async () => {
    const url = browser.runtime.getURL('/dashboard.html');
    const existing = await browser.tabs.create({ url, active: false });
    await browser.tabs.create({ url: 'https://example.com/', active: true });
    await openExtensionPage('/dashboard.html');
    expect(await browser.tabs.query({ url })).toHaveLength(1);
    const [active] = await browser.tabs.query({ active: true });
    expect(active?.id).toBe(existing.id);
  });

  it('opens Settings on a field: options.html#<field>', async () => {
    await openExtensionPage('/options.html#geminiApiKey');
    const [tab] = await browser.tabs.query({ active: true });
    expect(tab?.url).toBe(browser.runtime.getURL('/options.html') + '#geminiApiKey');
  });

  it('moves a Settings tab that is already open to the field, without opening another', async () => {
    const base = browser.runtime.getURL('/options.html');
    const existing = await browser.tabs.create({ url: base, active: false });
    await browser.tabs.create({ url: 'https://example.com/', active: true });
    await openExtensionPage('/options.html#notionToken');
    const tabs = (await browser.tabs.query({})).filter((t) => t.url?.startsWith(base));
    expect(tabs.map((t) => t.id)).toEqual([existing.id]);
    const [active] = await browser.tabs.query({ active: true });
    expect(active).toMatchObject({ id: existing.id, url: `${base}#notionToken` });
  });
});

describe('openSettings', () => {
  it('opens Settings, on a field when one is named', async () => {
    const base = browser.runtime.getURL('/options.html');
    await openSettings();
    expect((await browser.tabs.query({ active: true }))[0]?.url).toBe(base);
    await openSettings('geminiApiKey');
    expect((await browser.tabs.query({})).filter((t) => t.url?.startsWith(base))).toHaveLength(1);
    expect((await browser.tabs.query({ active: true }))[0]?.url).toBe(`${base}#geminiApiKey`);
  });

  it('only brings an open Settings tab forward when no field is named: its page is not reloaded', async () => {
    const base = browser.runtime.getURL('/options.html');
    const existing = await browser.tabs.create({ url: base, active: false });
    const updates: object[] = [];
    browser.tabs.onUpdated.addListener((_id, info) => void updates.push(info));
    await openSettings();
    expect((await browser.tabs.query({ active: true }))[0]?.id).toBe(existing.id);
    expect(updates.some((u) => 'url' in u)).toBe(false);
  });
});

describe('siteSettingsUrl', () => {
  it("points Chrome's site settings at the extension origin", () => {
    const origin = browser.runtime.getURL('/').replace(/\/$/, '');
    expect(origin).toMatch(/^chrome-extension:\/\/[^/]+$/);
    expect(siteSettingsUrl()).toBe(`chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}`);
  });
});

describe('result ids', () => {
  it('lists sessions that have a stored transcript', async () => {
    expect(await listResultIds()).toEqual(new Set());
    await putResult('a', RESULT);
    await putResult('b', RESULT);
    await putSession(meta('c'));
    expect(await listResultIds()).toEqual(new Set(['a', 'b']));
  });

  it('reports results as they are stored and deleted', async () => {
    const seen: [string, boolean][] = [];
    const stop = watchResultIds((id, present) => seen.push([id, present]));
    await putResult('a', RESULT);
    await putSession(meta('c'));
    await deleteResult('a');
    stop();
    await putResult('z', RESULT);
    expect(seen).toEqual([
      ['a', true],
      ['a', false],
    ]);
  });
});

describe('startRecording', () => {
  it('asks the background to record the tab and returns the session id', async () => {
    const requests: unknown[] = [];
    const handlers: Handlers<Background> = {
      'session/start': (req) => {
        requests.push(req);
        return { ok: true, sessionId: 's1' };
      },
    };
    const stop = handleMessages<Background>('background', handlers);
    expect(await startRecording(7)).toBe('s1');
    expect(requests).toEqual([{ tabId: 7 }]);
    stop();
  });

  it('turns a refusal into an error with the background message', async () => {
    const stop = handleMessages<Background>('background', {
      'session/start': () => ({ ok: false, error: 'Another tab is already recording.' }),
    });
    await expect(startRecording(7)).rejects.toThrow('Another tab is already recording.');
    stop();
  });
});

describe('loadPopupInput', () => {
  // fakeBrowser's tabs.query({ currentWindow }) needs a focused window, as Chrome always has for a popup.
  beforeEach(async () => {
    await browser.windows.create({ focused: true });
  });

  it('reads the active tab and the recording in progress', async () => {
    const win = await browser.windows.getCurrent();
    const tab = await browser.tabs.create({ url: 'https://meet.google.com/abc-defg-hij', active: true, windowId: win.id });
    const session = meta('s1');
    await putSession(session);
    await setActiveRecording({ sessionId: 's1', tabId: tab.id!, meetCode: 'abc-defg-hij' });
    const input = await loadPopupInput();
    expect(input.tab).toMatchObject({ id: tab.id, url: 'https://meet.google.com/abc-defg-hij' });
    expect(input.active).toEqual({ sessionId: 's1', tabId: tab.id, meetCode: 'abc-defg-hij' });
    expect(input.session).toEqual(session);
  });

  it('copes with no active tab and no recording', async () => {
    expect(await loadPopupInput()).toEqual({ tab: null, active: null, session: null });
  });
});
