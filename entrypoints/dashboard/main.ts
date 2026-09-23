import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage, sendToBackground } from '@lib/messages';
import { defaultProfile } from '@lib/profiles';
import { getSettings, settingsItem, updateSettings } from '@lib/settings';
import { getResult } from '@lib/storage/resultStore';
import { listSessions, watchSessions } from '@lib/storage/sessionStore';
import type { Profile, SessionMeta } from '@lib/types';
import { createDashboardView } from '@lib/ui/dashboardView';
import { listResultIds, openSettings as openSettingsPage, watchResultIds } from '@lib/ui/extension';
import { setupProblems, type FieldName } from '@lib/ui/settingsForm';
import { audioBytesOnDisk } from '@lib/ui/storageInfo';

const DISK_REFRESH_MS = 15_000;

const root = document.getElementById('app')!;
const sessions = new Map<string, SessionMeta>();
const resultIds = new Set<string>();
/** Ids changed by events before the initial read finished: the events are newer. */
const touchedSessions = new Set<string>();
const touchedResults = new Set<string>();
/** Bylines of meetings recorded before speakers were kept: the transcript's attendees. */
const attendees = new Map<string, readonly string[]>();
const attendeesAsked = new Set<string>();
let audioOnDisk: Map<string, number> | null = null;
let missing: string[] = [];
let geminiKeyMissing = false;
let profiles: Pick<Profile, 'id' | 'name'>[] = [];
let autoTranscribe = true;
let retentionDays = 7;
let pinHint = false;
let loaded = false;

const openSettings = (field?: FieldName) => {
  openSettingsPage(field).catch(report);
};
document.getElementById('open-settings')?.addEventListener('click', () => openSettings());

const view = createDashboardView(root, {
  stop: (sessionId) => sendToBackground('session/stop', { sessionId }),
  transcribe: (sessionId, { force }) =>
    sendToBackground('session/transcribe', force ? { sessionId, force } : { sessionId }),
  save: (sessionId, { force }) => sendToBackground('session/save', force ? { sessionId, force } : { sessionId }),
  remove: async (sessionId) => {
    await sendToBackground('session/delete', { sessionId });
    refreshDiskSoon();
  },
  setProfile: (sessionId, profileId) => sendToBackground('session/set-profile', { sessionId, profileId }),
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
    attendees,
    missing,
    geminiKeyMissing,
    profiles,
    autoTranscribe,
    retentionDays,
    pinHint,
    now: Date.now(),
  });
  void fetchAttendees();
}

/** Reads the stored transcript's attendees once for each meeting that has no speakers. */
async function fetchAttendees(): Promise<void> {
  const wanted = [...sessions.values()].filter(
    (s) => !s.speakers?.length && resultIds.has(s.id) && !attendeesAsked.has(s.id),
  );
  if (wanted.length === 0) return;
  for (const s of wanted) attendeesAsked.add(s.id);
  let found = false;
  for (const s of wanted) {
    const result = await getResult(s.id).catch(() => null);
    if (result?.attendees.length) {
      attendees.set(s.id, result.attendees);
      found = true;
    }
  }
  if (found) render();
}

async function refreshDisk(): Promise<void> {
  audioOnDisk = await audioBytesOnDisk();
  render();
}

let diskTimer: ReturnType<typeof setTimeout> | undefined;
function refreshDiskSoon(): void {
  clearTimeout(diskTimer);
  diskTimer = setTimeout(() => void refreshDisk().catch(report), 1000);
}

async function refreshSettings(): Promise<void> {
  const settings = await getSettings();
  const profile = defaultProfile(settings);
  const problems = setupProblems(settings, profile);
  missing = problems.blocking;
  geminiKeyMissing = problems.geminiKeyMissing;
  profiles = settings.profiles.map(({ id, name }) => ({ id, name }));
  autoTranscribe = settings.autoTranscribe;
  retentionDays = settings.retentionDays;
  render();
}

/** The empty state says how to pin the toolbar button while it isn't pinned. */
async function refreshPinHint(): Promise<void> {
  try {
    const settings = await browser.action.getUserSettings();
    pinHint = settings.isOnToolbar === false;
  } catch {
    pinHint = false;
  }
  render();
}

async function load(): Promise<void> {
  const [list, ids] = await Promise.all([listSessions(), listResultIds(), refreshSettings(), refreshDisk(), refreshPinHint()]);
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
// Pinning happens in Chrome's menu, outside the page: check again when the page comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshPinHint();
});

const TICKING = new Set<SessionMeta['status']>(['recording', 'processing', 'saving']);
setInterval(() => {
  // The recording clock and its problems ("No audio for 20 s"), and "running for 3 min"
  // change with time.
  if ([...sessions.values()].some((s) => TICKING.has(s.status))) render();
}, 1000);
setInterval(() => void refreshDisk().catch(report), DISK_REFRESH_MS);

load().catch((err: unknown) => {
  report(err);
  root.textContent = `Couldn’t load meetings: ${errorMessage(err)}`;
});
