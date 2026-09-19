import '@lib/ui/styles.css';
import { errorMessage, sendToBackground } from '@lib/messages';
import { getSettings } from '@lib/settings';
import { getSession, watchSessions } from '@lib/storage/sessionStore';
import type { Route, SessionMeta } from '@lib/types';
import { createRoutingView, ROUTE_COUNTDOWN_MS } from '@lib/ui/routingView';

const TICK_MS = 250;

const root = document.getElementById('app')!;
const sessionId = new URLSearchParams(location.search).get('session') ?? '';
// The countdown starts when the window opens, not when the meeting ended.
const deadline = Date.now() + ROUTE_COUNTDOWN_MS;

const view = createRoutingView(root, {
  choose: (route) => sendToBackground('session/route', { sessionId, route }),
  close: () => window.close(),
});

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
  if (state.meta) document.title = `${state.meta.meetingTitle?.trim() || state.meta.meetCode} · Destination`;
  update();
  setInterval(update, TICK_MS);
}

main().catch((err: unknown) => {
  console.error('[manet]', errorMessage(err));
  root.textContent = `Could not load this meeting: ${errorMessage(err)}`;
});
