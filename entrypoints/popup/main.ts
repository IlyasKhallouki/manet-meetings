import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage, sendToBackground } from '@lib/messages';
import { getSettings, missingSettings } from '@lib/settings';
import { loadPopupInput, openExtensionPage, startRecording } from '@lib/ui/extension';
import { queryMicPermission, watchMicPermission } from '@lib/ui/mic';
import { createPopupView, micView, popupState, type PopupModel } from '@lib/ui/popupView';

const root = document.getElementById('app')!;
let model: PopupModel | null = null;

function leaveTo(open: Promise<void>): void {
  open.then(
    () => window.close(),
    (err: unknown) => console.error('[manet]', errorMessage(err)),
  );
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
  grantMic: () => leaveTo(openExtensionPage('/permission.html')),
  openSettings: () => leaveTo(browser.runtime.openOptionsPage()),
  openDashboard: () => leaveTo(openExtensionPage('/dashboard.html')),
});

async function refresh(): Promise<void> {
  const [input, settings, mic] = await Promise.all([loadPopupInput(), getSettings(), queryMicPermission()]);
  model = {
    state: popupState(input),
    mic: micView(mic, settings.includeMic),
    missing: missingSettings(settings, settings.defaultRoute),
  };
  view.update(model, Date.now());
}

let pending: ReturnType<typeof setTimeout> | undefined;
function refreshSoon(): void {
  // Captions and chunks rewrite the session every few seconds while recording.
  clearTimeout(pending);
  pending = setTimeout(() => void refresh().catch(report), 150);
}

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

browser.storage.onChanged.addListener(refreshSoon);
void watchMicPermission(refreshSoon);
setInterval(() => {
  if (model) view.update(model, Date.now());
}, 1000);
refresh().catch(report);
