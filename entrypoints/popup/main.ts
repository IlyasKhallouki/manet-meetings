import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage, sendToBackground } from '@lib/messages';
import { getSettings } from '@lib/settings';
import { getActiveRecording, getSession, listSessions, needsYou, sessionKey } from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';
import { openExtensionPage, openSettings, startRecording } from '@lib/ui/extension';
import { queryMicPermission, watchMicPermission } from '@lib/ui/mic';
import { createPopupView, popupState, setupGaps, type PopupInput, type PopupModel } from '@lib/ui/popupView';

/** The manifest command that starts and stops a recording. */
const TOGGLE_COMMAND = 'toggle-recording';

const root = document.getElementById('app')!;
let model: PopupModel | null = null;
/** Every session, newest first; re-read only when a session other than the recording changes. */
let sessions: SessionMeta[] | null = null;
let sessionsStale = true;
let activeSessionKey: string | null = null;
let shortcut: Promise<string | null> | null = null;
let rendered = false;
let interacted = false;
window.addEventListener('keydown', () => (interacted = true), { capture: true, once: true });
window.addEventListener('pointerdown', () => (interacted = true), { capture: true, once: true });

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

function leaveTo(open: Promise<unknown>): void {
  open.then(() => window.close(), report);
}

async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

const view = createPopupView(root, {
  async record(tabId) {
    await startRecording(tabId);
    await refresh();
  },
  async stop(sessionId) {
    await sendToBackground('session/stop', { sessionId });
    await refresh();
  },
  goToCall: (tabId) => leaveTo(focusTab(tabId)),
  grantMic: () => leaveTo(openExtensionPage('/permission.html')),
  openSettings: (field) => leaveTo(openSettings(field)),
  openDashboard: () => leaveTo(openExtensionPage('/dashboard.html')),
  openNotion: (url) => leaveTo(browser.tabs.create({ url, active: true })),
});

async function activeTab(): Promise<PopupInput['tab']> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    const out: NonNullable<PopupInput['tab']> = {};
    if (tab.id !== undefined) out.id = tab.id;
    if (tab.url !== undefined) out.url = tab.url;
    if (tab.title !== undefined) out.title = tab.title;
    return out;
  } catch {
    return null;
  }
}

/** The record shortcut as Chrome shows it ("Alt+Shift+R", "⌥⇧R"), or null when unset. */
async function recordShortcut(): Promise<string | null> {
  try {
    const commands = await browser.commands.getAll();
    return commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut || null;
  } catch {
    return null;
  }
}

async function refresh(): Promise<void> {
  shortcut ??= recordShortcut();
  const [tab, active, settings, mic, keys] = await Promise.all([
    activeTab(),
    getActiveRecording(),
    getSettings(),
    queryMicPermission(),
    shortcut,
  ]);
  const session = active ? await getSession(active.sessionId) : null;
  const state = popupState({ tab, active, session });
  activeSessionKey = state.kind === 'recording' ? sessionKey(state.sessionId) : null;
  // While recording, the session meta changes with every caption batch; the list only
  // feeds Recent (hidden then) and the footer count, so it isn't re-read for those writes.
  if (!sessions || sessionsStale || state.kind !== 'recording') {
    sessionsStale = false;
    sessions = await listSessions();
  }
  model = {
    state,
    mic,
    includeMic: settings.includeMic,
    setup: setupGaps(settings),
    geminiKeyMissing: !settings.geminiApiKey,
    recent: sessions,
    needsYou: sessions.filter(needsYou).length,
    shortcut: keys,
  };
  const first = !rendered;
  view.update(model, Date.now());
  rendered = true;
  if (first) dropAutofocus();
}

/** Nothing is focused when the popup opens, so a stray Enter can't start or stop a recording. */
function dropAutofocus(): void {
  const focused = document.activeElement;
  if (!interacted && focused instanceof HTMLElement && focused !== document.body) focused.blur();
}

let pending: ReturnType<typeof setTimeout> | undefined;
function refreshSoon(): void {
  // Chunks and caption batches rewrite the session every few seconds while recording.
  clearTimeout(pending);
  pending = setTimeout(() => void refresh().catch(report), 150);
}

browser.storage.onChanged.addListener((changes, area) => {
  const keys = Object.keys(changes);
  // Caption text and stored transcripts aren't shown here; the roll comes from the meta.
  if (area === 'local' && keys.every((k) => k.startsWith('captions:') || k.startsWith('result:'))) return;
  if (area !== 'local' || keys.some((k) => k.startsWith('session:') && k !== activeSessionKey)) sessionsStale = true;
  refreshSoon();
});
void watchMicPermission(refreshSoon);
setInterval(() => {
  if (model) view.update(model, Date.now());
}, 1000);
refresh().catch(report);
