import '@lib/ui/styles.css';
import { browser } from 'wxt/browser';
import { errorMessage } from '@lib/messages';
import { siteSettingsUrl } from '@lib/ui/extension';
import { queryMicPermission, requestMicAccess, watchMicPermission } from '@lib/ui/mic';
import { createPermissionView } from '@lib/ui/permissionView';

const root = document.getElementById('app')!;
const settingsUrl = siteSettingsUrl();

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

async function closeThisTab(): Promise<void> {
  const tab = await browser.tabs.getCurrent();
  if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
  else window.close();
}

const view = createPermissionView(
  root,
  {
    request: requestMicAccess,
    query: queryMicPermission,
    openSiteSettings: () => {
      browser.tabs.create({ url: settingsUrl }).catch(report);
    },
    close: () => {
      closeThisTab().catch(report);
    },
  },
  settingsUrl,
);

queryMicPermission().then((state) => view.update(state), report);
void watchMicPermission((state) => view.update(state));
