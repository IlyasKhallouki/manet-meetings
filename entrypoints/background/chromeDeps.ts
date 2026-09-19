import { browser } from 'wxt/browser';
import { sendToOffscreen, sendToTab } from '@lib/messages';
import { getSettings } from '@lib/settings';
import { createOffscreenDocument } from './offscreenDocument';
import type { SessionManagerDeps } from './sessionManager';

const KEEPALIVE_INTERVAL_MS = 20_000;
const BADGE_COLORS = { recording: '#d93025', 'captions-only': '#e37400' } as const;

/** The session manager's dependencies, backed by the real extension APIs. */
export function createChromeDeps(): SessionManagerDeps {
  const offscreen = createOffscreenDocument();
  let holds = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

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
      async pushRecordingState(tabId, state) {
        try {
          await sendToTab(tabId, 'content/recording-state', state);
        } catch {
          // Closed, reloading or not injected yet: the page asks again with 'meet/joined'.
        }
      },
      async open(url) {
        await browser.tabs.create({ url });
      },
    },
    async openDashboard() {
      await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
    },
    async setBadge(state) {
      await browser.action.setBadgeText({ text: state ? 'REC' : '' });
      if (state) await browser.action.setBadgeBackgroundColor({ color: BADGE_COLORS[state] });
      await browser.action.setTitle({
        title: state === 'captions-only' ? 'Manet Meetings: recording captions only (no audio)' : 'Manet Meetings',
      });
    },
    async openRoutingPrompt(sessionId) {
      await browser.windows.create({
        url: browser.runtime.getURL(`/routing.html?session=${encodeURIComponent(sessionId)}`),
        type: 'popup',
        width: 380,
        height: 280,
        focused: true,
      });
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
        await browser.alarms.create(name, info);
      },
      async clear(name) {
        await browser.alarms.clear(name);
      },
      async exists(name) {
        return (await browser.alarms.get(name)) !== undefined;
      },
    },
    keepAlive() {
      // Any extension API call resets the worker's 30 s idle timer (Chrome 110+), so a
      // cheap call every 20 s keeps it alive while it waits on a long offscreen job.
      if (holds++ === 0) {
        timer = setInterval(() => {
          Promise.resolve()
            .then(() => browser.runtime.getPlatformInfo())
            .catch(() => undefined);
        }, KEEPALIVE_INTERVAL_MS);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--holds === 0) clearInterval(timer);
      };
    },
    getSettings,
    now: () => Date.now(),
  };
}
