import '@lib/ui/styles.css';
import { verifyApiKey } from '@lib/gemini/rest';
import { errorMessage } from '@lib/messages';
import { verifyDatabase } from '@lib/notion/verify';
import { getSettings, settingsItem, updateSettings } from '@lib/settings';
import { callout } from '@lib/ui/controls';
import { mount } from '@lib/ui/dom';
import { openExtensionPage } from '@lib/ui/extension';
import { queryMicPermission, watchMicPermission } from '@lib/ui/mic';
import { createOptionsView } from '@lib/ui/optionsView';

const root = document.getElementById('app')!;

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

document.getElementById('open-dashboard')?.addEventListener('click', () => {
  openExtensionPage('/dashboard.html').catch(report);
});

const view = createOptionsView(root, {
  // Each commit writes only its own field, merged into what is stored now.
  update: (patch) => updateSettings(patch),
  verifyGemini: (apiKey) => verifyApiKey(apiKey),
  verifyNotion: (token, databaseId) => verifyDatabase(token, databaseId),
  openPermissionPage: () => {
    openExtensionPage('/permission.html').catch(report);
  },
});

function refresh(): Promise<void> {
  return getSettings().then((settings) => view.load(settings));
}

/**
 * options.html#geminiApiKey (any setting's name) focuses that setting: on load, and when
 * another page's openSettings(field) moves this tab to a new #field. The hash is then
 * dropped, so the next link to the same field is a change again (hashchange fires).
 */
function focusFromHash(): void {
  if (!location.hash) return;
  let name = '';
  try {
    name = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A malformed escape: not a setting.
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  view.focus(name);
}

refresh().then(
  () => {
    focusFromHash();
    window.addEventListener('hashchange', focusFromHash);
    // Changes from another tab (or the popup) show up here; edits in progress are kept.
    settingsItem.watch(() => void refresh().catch(report));
  },
  (err: unknown) => {
    report(err);
    mount(root, callout({ title: 'Couldn’t load settings', body: `${errorMessage(err)} Reload this tab to try again.` }));
  },
);

// Closing the tab doesn't blur the focused field: save what's in it, and let Chrome ask
// before leaving while a value can't be saved or a write is still running.
window.addEventListener('beforeunload', (event) => {
  if (view.flush()) event.preventDefault();
});

queryMicPermission().then((state) => view.setMic(state), report);
void watchMicPermission((state) => view.setMic(state));
