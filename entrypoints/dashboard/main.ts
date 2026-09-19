import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage, sendToBackground } from '@lib/messages';
import { getSettings, settingsItem, updateSettings } from '@lib/settings';
import { listSessions, watchSessions } from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';
import { createDashboardView } from '@lib/ui/dashboardView';
import { listResultIds, watchResultIds } from '@lib/ui/extension';
import { setupProblems } from '@lib/ui/settingsForm';
import { audioBytesOnDisk, storageEstimate } from '@lib/ui/storageInfo';

const DISK_REFRESH_MS = 15_000;

const root = document.getElementById('app')!;
const sessions = new Map<string, SessionMeta>();
const resultIds = new Set<string>();
/** Ids changed by events before the initial read finished: the events are newer. */
const touchedSessions = new Set<string>();
const touchedResults = new Set<string>();
let audioOnDisk: Map<string, number> | null = null;
let estimate: { usage: number; quota: number } | null = null;
let missing: string[] = [];
let geminiKeyMissing = false;
let autoTranscribe = true;
let loaded = false;

const openSettings = () => {
  browser.runtime.openOptionsPage().catch(report);
};
document.getElementById('open-settings')?.addEventListener('click', openSettings);

const view = createDashboardView(root, {
  stop: (sessionId) => sendToBackground('session/stop', { sessionId }),
  transcribe: (sessionId, { force }) =>
    sendToBackground('session/transcribe', force ? { sessionId, force } : { sessionId }),
  save: (sessionId, { force }) => sendToBackground('session/save', force ? { sessionId, force } : { sessionId }),
  remove: async (sessionId) => {
    await sendToBackground('session/delete', { sessionId });
    refreshDiskSoon();
  },
  route: (sessionId, route) => sendToBackground('session/route', { sessionId, route }),
  setAutoTranscribe: async (on) => {
    await updateSettings({ autoTranscribe: on });
    // Before the storage event, so a clock tick in between does not flip the switch back.
    autoTranscribe = on;
    render();
  },
  openSettings,
});

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

function render(): void {
  if (!loaded) return;
  view.update({
    sessions: [...sessions.values()],
    resultIds,
    audioOnDisk,
    estimate,
    missing,
    geminiKeyMissing,
    autoTranscribe,
    now: Date.now(),
  });
}

async function refreshDisk(): Promise<void> {
  [audioOnDisk, estimate] = await Promise.all([audioBytesOnDisk(), storageEstimate()]);
  render();
}

let diskTimer: ReturnType<typeof setTimeout> | undefined;
function refreshDiskSoon(): void {
  clearTimeout(diskTimer);
  diskTimer = setTimeout(() => void refreshDisk().catch(report), 1000);
}

async function refreshSettings(): Promise<void> {
  const settings = await getSettings();
  const problems = setupProblems(settings, settings.defaultRoute);
  missing = problems.blocking;
  geminiKeyMissing = problems.geminiKeyMissing;
  autoTranscribe = settings.autoTranscribe;
  render();
}

async function load(): Promise<void> {
  const [list, ids] = await Promise.all([listSessions(), listResultIds(), refreshSettings(), refreshDisk()]);
  for (const meta of list) if (!touchedSessions.has(meta.id)) sessions.set(meta.id, meta);
  for (const id of ids) if (!touchedResults.has(id)) resultIds.add(id);
  loaded = true;
  render();
}

// Listeners first, so no change between the initial read and the first render is missed.
watchSessions((id, meta) => {
  if (!loaded) touchedSessions.add(id);
  const before = sessions.get(id);
  if (meta) sessions.set(id, meta);
  else sessions.delete(id);
  render();
  if (!meta || meta.status !== before?.status || meta.audio.deletedAt !== before.audio.deletedAt) refreshDiskSoon();
});
watchResultIds((id, present) => {
  if (!loaded) touchedResults.add(id);
  if (present) resultIds.add(id);
  else resultIds.delete(id);
  render();
});
settingsItem.watch(() => void refreshSettings().catch(report));

setInterval(() => {
  // Only recording rows change with time.
  if ([...sessions.values()].some((s) => s.status === 'recording')) render();
}, 1000);
setInterval(() => void refreshDisk().catch(report), DISK_REFRESH_MS);

load().catch((err: unknown) => {
  report(err);
  root.textContent = `Could not load recordings: ${errorMessage(err)}`;
});
