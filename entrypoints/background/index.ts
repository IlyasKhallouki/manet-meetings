import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { errorMessage, handleMessages } from '@lib/messages';
import { createChromeDeps } from './chromeDeps';
import { backgroundHandlers, createSessionManager, type BackgroundMessages } from './sessionManager';

export default defineBackground(() => {
  const manager = createSessionManager(createChromeDeps());
  const run = (task: Promise<unknown>) => {
    task.catch((err: unknown) => console.error('[manet]', errorMessage(err)));
  };

  // Registered synchronously: Chrome only delivers the event that woke the worker to
  // listeners added during its first turn.
  handleMessages<BackgroundMessages>('background', backgroundHandlers(manager));
  browser.tabs.onRemoved.addListener((tabId) => run(manager.onTabRemoved(tabId)));
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.url) run(manager.onTabUrlChanged(tabId, change.url));
  });
  browser.alarms.onAlarm.addListener((alarm) => run(manager.onAlarm(alarm.name)));
  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-recording') run(manager.toggle(tab?.id));
  });
  browser.notifications.onClicked.addListener((id) => run(manager.onNotificationClicked(id)));
  browser.runtime.onStartup.addListener(() => run(manager.boot({ full: true })));
  browser.runtime.onInstalled.addListener(() => run(manager.boot({ full: true })));

  run(manager.boot());
});
