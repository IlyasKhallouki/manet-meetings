import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage, sendToBackground } from '@lib/messages';
import { getSettings } from '@lib/settings';
import { getSession, watchSessions } from '@lib/storage/sessionStore';
import type { Route, SessionMeta } from '@lib/types';
import { createRoutingView, ROUTE_COUNTDOWN_MS, windowHeightFor } from '@lib/ui/routingView';

const TICK_MS = 250;

const root = document.getElementById('app')!;
const sessionId = new URLSearchParams(location.search).get('session') ?? '';
// The countdown starts when the window opens, not when the meeting ended.
const deadline = Date.now() + ROUTE_COUNTDOWN_MS;

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

const view = createRoutingView(root, {
  choose: (route) => sendToBackground('session/route', { sessionId, route }),
  hold: (hold) => sendToBackground('session/route-hold', { sessionId, hold }),
  open: (url) => {
    browser.tabs.create({ url }).then(() => window.close(), report);
  },
  close: () => window.close(),
});

/**
 * The window is created 380×280 including the OS frame, which leaves about 220 px on
 * Linux and Windows: fit its height to the content so the countdown and Pause are never
 * clipped. Refits when the content changes height (an error line, another state).
 */
let fitted = 0;
async function fitWindow(): Promise<void> {
  const content = root.getBoundingClientRect().height;
  if (content === 0 || Math.abs(content - fitted) < 1) return;
  fitted = content;
  const win = await browser.windows.getCurrent();
  const height = windowHeightFor(content, window.outerHeight, window.innerHeight);
  if (win.id !== undefined && win.height !== height) await browser.windows.update(win.id, { height });
}
new ResizeObserver(() => {
  fitWindow().catch(report);
}).observe(root);

const state: { meta: SessionMeta | null; defaultRoute: Route | null; changed: boolean } = {
  meta: null,
  defaultRoute: null,
  changed: false,
};

function update(): void {
  // Nothing until the default is known: it decides which button is highlighted and focused.
  if (!state.defaultRoute) return;
  view.update({ meta: state.meta, defaultRoute: state.defaultRoute, deadline }, Date.now());
}

// Registered before the first read so a change in between is not missed.
watchSessions((id, meta) => {
  if (id !== sessionId) return;
  state.changed = true;
  state.meta = meta;
  update();
});

async function main(): Promise<void> {
  const [settings, stored] = await Promise.all([getSettings(), sessionId ? getSession(sessionId) : null]);
  if (!state.changed) state.meta = stored;
  state.defaultRoute = settings.defaultRoute;
  update();
  setInterval(update, TICK_MS);
}

main().catch((err: unknown) => {
  report(err); // the raw reason, for the console
  root.textContent = 'Couldn’t load this meeting. Choose Team or Personal in Meetings.';
});
