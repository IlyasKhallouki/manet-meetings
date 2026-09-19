import { browser, type Browser } from 'wxt/browser';
import { errorMessage, sendToOffscreen, sendToTab } from '@lib/messages';
import { getSettings } from '@lib/settings';
import { presentAction } from './actionState';
import { createOffscreenDocument } from './offscreenDocument';
import { withTimeout, type SessionManagerDeps } from './sessionManager';

const MEET_ORIGIN = 'https://meet.google.com/';
/** The manifest's command that starts and stops a recording. */
const TOGGLE_COMMAND = 'toggle-recording';
/** The content script answers at once; a page that doesn't is busy or frozen. */
const PUSH_TIMEOUT_MS = 3000;

/** Files of the manifest's content scripts that run on Meet. */
function meetContentScripts(): string[] {
  return (browser.runtime.getManifest().content_scripts ?? [])
    .filter((cs) => cs.matches?.some((m) => m.startsWith(MEET_ORIGIN)))
    .flatMap((cs) => cs.js ?? []);
}

/** The session manager's dependencies, backed by the real extension APIs. */
export function createChromeDeps(): SessionManagerDeps {
  const offscreen = createOffscreenDocument();

  return {
    capture: {
      getMediaStreamId: (tabId) => browser.tabCapture.getMediaStreamId({ targetTabId: tabId }),
    },
    offscreen: { ensure: offscreen.ensure, exists: offscreen.exists, send: sendToOffscreen },
    tabs: {
      async get(tabId) {
        try {
          return (await browser.tabs.get(tabId)) ?? null;
        } catch {
          return null; // Chrome rejects for tabs that no longer exist.
        }
      },
      async activeTabId() {
        const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return tab?.id ?? null;
      },
      async meetTabIds() {
        const tabs = await browser.tabs.query({});
        return tabs.flatMap((t) => (t.id !== undefined && t.url?.startsWith(MEET_ORIGIN) ? [t.id] : []));
      },
      async pushRecordingState(tabId, state) {
        try {
          await withTimeout(sendToTab(tabId, 'content/recording-state', state), PUSH_TIMEOUT_MS, 'Tab push');
          return 'delivered';
        } catch (err) {
          // Chrome's wording when nothing listens: no content script, or the tab is gone.
          return /Receiving end does not exist/i.test(errorMessage(err)) ? 'no-receiver' : 'failed';
        }
      },
      async injectContentScript(tabId) {
        const files = meetContentScripts();
        if (files.length === 0) throw new Error('The manifest has no Meet content script');
        // Paths come from the built manifest at runtime; WXT types them as its known public paths.
        type Files = NonNullable<Parameters<typeof browser.scripting.executeScript>[0]['files']>;
        await browser.scripting.executeScript({ target: { tabId }, files: files as Files });
      },
      async open(url) {
        await browser.tabs.create({ url });
      },
    },
    async openDashboard() {
      await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
    },
    async openSettings() {
      await browser.runtime.openOptionsPage();
    },
    async setActionState(state) {
      const view = presentAction(state);
      // Each part on its own: a missing icon file must not keep the badge from showing.
      // Colours go before the text so a new badge never flashes Chrome's default colour.
      const results = await Promise.allSettled([
        browser.action.setIcon({ path: view.icon }),
        browser.action.setBadgeBackgroundColor({ color: view.badge.background }),
        browser.action.setBadgeTextColor({ color: view.badge.color }),
        browser.action.setBadgeText({ text: view.badge.text }),
        browser.action.setTitle({ title: view.title }),
      ]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    },
    async shortcut() {
      try {
        const commands = await browser.commands.getAll();
        return commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut || null;
      } catch {
        return null;
      }
    },
    async openRoutingPrompt(sessionId) {
      const win = await browser.windows.create({
        url: browser.runtime.getURL(`/routing.html?session=${encodeURIComponent(sessionId)}`),
        type: 'popup',
        width: 380,
        height: 280,
        focused: true,
      });
      return win?.id;
    },
    async notify(sessionId, title, message) {
      await browser.notifications.create(`manet:${sessionId}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title,
        message,
      });
    },
    alarms: {
      async create(name, info) {
        // The dep takes one flat shape; Chrome's typings split it into when|delay variants.
        await browser.alarms.create(name, info as Browser.alarms.AlarmCreateInfo);
      },
      async clear(name) {
        await browser.alarms.clear(name);
      },
      async exists(name) {
        return (await browser.alarms.get(name)) !== undefined;
      },
    },
    getSettings,
    now: () => Date.now(),
  };
}
