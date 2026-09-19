import '@lib/ui/styles.css';
import { verifyApiKey } from '@lib/gemini/rest';
import { errorMessage } from '@lib/messages';
import { verifyDatabase } from '@lib/notion/verify';
import { getSettings, settingsItem } from '@lib/settings';
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
  save: (settings) => settingsItem.setValue(settings),
  verifyGemini: (apiKey) => verifyApiKey(apiKey),
  verifyNotion: (token, databaseId) => verifyDatabase(token, databaseId),
  openPermissionPage: () => {
    openExtensionPage('/permission.html').catch(report);
  },
});

getSettings().then(
  (settings) => view.load(settings),
  (err: unknown) => {
    report(err);
    root.textContent = `Could not load settings: ${errorMessage(err)}`;
  },
);
queryMicPermission().then((state) => view.setMic(state), report);
void watchMicPermission((state) => view.setMic(state));
