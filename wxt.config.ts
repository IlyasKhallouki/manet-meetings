import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  alias: {
    '@lib': resolve(import.meta.dirname, 'src/lib'),
  },
  manifest: {
    name: 'Manet Meetings',
    description:
      'Records Google Meet calls, transcribes them with Gemini and files them into Notion.',
    minimum_chrome_version: '116',
    permissions: [
      'tabCapture',
      'offscreen',
      'storage',
      'unlimitedStorage',
      'alarms',
      'notifications',
      'tabs',
    ],
    host_permissions: [
      'https://meet.google.com/*',
      'https://generativelanguage.googleapis.com/*',
      'https://api.notion.com/*',
    ],
    action: {
      default_title: 'Manet Meetings',
    },
    commands: {
      'toggle-recording': {
        suggested_key: { default: 'Alt+Shift+R' },
        description: 'Start or stop recording the current Meet call',
      },
    },
  },
});
