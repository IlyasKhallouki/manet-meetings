import { resolve } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Integration keys (GOOGLE_API_KEY, NOTION_TOKEN, NOTION_TEST_DB_ID) come from the
// shell or from a git-ignored .env.test.local file.
const env = loadEnv('test', process.cwd(), '');

const alias = { '@lib': resolve(import.meta.dirname, 'src/lib') };

export default defineConfig({
  test: {
    projects: [
      {
        // Pure logic, chrome.* via WXT's in-memory fake browser, and real network
        // integration tests (Gemini, Notion) gated on their env keys.
        plugins: [WxtVitest()],
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.browser.test.ts'],
          env,
          testTimeout: 30_000,
        },
      },
      {
        // Real Chrome: DOM parsing of caption fixtures, OPFS, AudioContext, MediaRecorder.
        resolve: { alias },
        test: {
          name: 'browser',
          include: ['tests/**/*.browser.test.ts'],
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright({
              launchOptions: {
                channel: 'chrome',
                args: ['--autoplay-policy=no-user-gesture-required'],
              },
            }),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
