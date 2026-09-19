import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { errorMessage, handleMessages, type BackgroundProtocol } from '@lib/messages';
import { createChromeDeps } from './chromeDeps';
import { backgroundHandlers, createSessionManager } from './sessionManager';

/**
 * storage.local holds the API keys and every transcript, and by default content scripts
 * (which share the Meet renderer) can read and write it. Nothing outside the extension's
 * own pages needs it. Set on every worker start, not only at install, so no update or
 * restart leaves it open.
 */
function restrictStorage(): void {
  const failed = (err: unknown) => console.warn('[manet] Could not restrict storage to the extension:', errorMessage(err));
  try {
    browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(failed);
  } catch (err) {
    failed(err); // no such API in this browser
  }
}

export default defineBackground(() => {
  // Issued first; boot() below must still start in this turn so every handler waits for it.
  restrictStorage();
  const manager = createSessionManager(createChromeDeps());
  const run = (task: Promise<unknown>) => {
    task.catch((err: unknown) => {
      const message = errorMessage(err);
      // Tabs closing with the browser: storage is gone and boot recovery takes over next start.
      if (/browser is shutting down/i.test(message)) return;
      console.error('[manet]', message);
    });
  };

  // Registered synchronously: Chrome only delivers the event that woke the worker to
  // listeners added during its first turn.
  handleMessages<BackgroundProtocol>('background', backgroundHandlers(manager));
  browser.tabs.onRemoved.addListener((tabId) => run(manager.onTabRemoved(tabId)));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) run(manager.onTabUrlChanged(tabId, change.url));
  });
  // Closing a paused routing prompt re-arms the default route.
  browser.windows.onRemoved.addListener((windowId) => run(manager.onWindowRemoved(windowId)));
  browser.alarms.onAlarm.addListener((alarm) => run(manager.onAlarm(alarm.name)));
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-recording') run(manager.toggle(tab?.id));
  });
  browser.notifications.onClicked.addListener((id) => run(manager.onNotificationClicked(id)));
  browser.runtime.onStartup.addListener(() => run(manager.boot({ full: true })));
  browser.runtime.onInstalled.addListener(({ reason }) => {
    run(manager.boot({ full: true }));
    // Chrome does not add content scripts to tabs that were already open. A first install
    // also opens Settings, where the setup checklist starts.
    run(manager.onInstalled(reason));
  });

  run(manager.boot());
});
