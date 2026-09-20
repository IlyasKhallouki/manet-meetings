/**
 * Settings in the states of the Native Restraint wireframe (brief/direction-native.md ›
 * Surface: settings) plus the setup checklist: filled with per-field results, first run,
 * setup just finished, pending Check / mic blocked / advice, and 150% text.
 * Every shot asserts there is no horizontal scroll.
 */
import { DEFAULT_SETTINGS } from '@lib/settingsSchema';
import type { VerifyResult } from '@lib/notion/verify';
import type { Settings } from '@lib/types';
import type { MicPermission } from '@lib/ui/mic';
import { createOptionsView, type OptionsHandlers } from '@lib/ui/optionsView';
import optionsHtml from '../../entrypoints/options/index.html?raw';
import { gallery, never, shell, variant, type Shot } from './harness';
import { FULL_SETTINGS } from './scenarios';

const TEAM_DB = 'https://www.notion.so/lumind/Meetings-0123456789abcdef0123456789abcdef';
const PERSONAL_DB = 'fedcba9876543210fedcba9876543210';

const FILLED: Settings = {
  ...FULL_SETTINGS,
  displayName: 'Ilya',
  geminiApiKey: '',
  notionTeamDbId: TEAM_DB,
  notionPersonalDbId: PERSONAL_DB,
  customVocabulary: ['Lumind', 'Manet', 'OPFS'],
};

const EMPTY: Settings = { ...DEFAULT_SETTINGS };

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => document.querySelector<T>(selector)!;

/** Types a value and leaves the field, like a person would. */
async function commit(name: string, value: string): Promise<void> {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.blur();
  await wait();
}

const notion: OptionsHandlers['verifyNotion'] = async (_token, db) =>
  db === TEAM_DB
    ? { ok: true, title: 'Meetings' }
    : ({
        ok: false,
        // What verifyDatabase says for Notion's object_not_found.
        problems: ['This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.'],
      } satisfies VerifyResult);

function page(settings: Settings, mic: MicPermission, overrides: Partial<OptionsHandlers> = {}) {
  document.documentElement.style.fontSize = '';
  let current = { ...settings };
  const view = createOptionsView(
    shell(optionsHtml),
    {
      update: async (patch) => (current = { ...current, ...patch }),
      verifyGemini: async () => ({ ok: true }),
      verifyNotion: notion,
      openPermissionPage: () => {},
      ...overrides,
    },
    { savedMs: 600_000 },
  );
  view.load(settings);
  view.setMic(mic);
  return view;
}

function noSideScroll(): void {
  const over = document.documentElement.scrollWidth - window.innerWidth;
  if (over > 0) throw new Error(`horizontal overflow: ${over}px`);
}

/** The wireframe's WIDE state: ✓ Saved, a ready and a not-shared database, an invalid code. */
async function filled(): Promise<void> {
  page(FILLED, 'prompt');
  await commit('displayName', 'Ilya Kaplan');
  q<HTMLButtonElement>('[data-role="check-notion"]').click();
  await wait(60);
  await commit('languageCodes', 'english!!');
  noSideScroll();
}

async function firstRun(): Promise<void> {
  page(EMPTY, 'prompt');
  noSideScroll();
}

/** Filled in during this visit: the checklist stays where it was and confirms. */
async function setupDone(): Promise<void> {
  page(EMPTY, 'granted');
  await commit('displayName', 'Ilya Kaplan');
  await commit('notionToken', 'ntn_example_token_0000000000000000000000000000');
  await commit('notionTeamDbId', TEAM_DB);
  noSideScroll();
}

/** Check running, a blocked mic, advice about a code, and keyboard focus on a field. */
async function states(): Promise<void> {
  page({ ...FILLED, geminiApiKey: 'AIzaSyD-example-key-000000000000000000' }, 'denied', { verifyGemini: never });
  await commit('languageCodes', 'en-US, fr-CA');
  q<HTMLButtonElement>('[data-role="check-gemini"]').click();
  await commit('retentionDays', '400');
  q('[name="notionTeamDbId"]').focus();
  await wait();
  noSideScroll();
}

async function largeText(): Promise<void> {
  await filled();
  document.documentElement.style.fontSize = '150%';
  await wait(60);
  noSideScroll();
}

/**
 * Focusing a field scrolls the page, and the floating bar reads the scroll: a full-page
 * shot is of the page as you land on it, so every one of them ends back at the top. The
 * bar carrying its material is a state of its own, shot once below.
 */
const shot = (name: string, width: number, render: () => Promise<void>): Shot => ({
  name: `settings-${name}`,
  width,
  height: 800,
  full: true,
  render: async () => {
    await render();
    window.scrollTo(0, 0);
  },
});

/** Content under the glass bar: the material, its hairline and the compact title arrive. */
const scrolledShot: Shot = {
  name: 'settings-scrolled-1100',
  width: 1100,
  height: 800,
  full: false,
  render: async () => {
    await filled();
    window.scrollTo(0, 360);
  },
};

const statesShot = shot('states-720', 720, states);
const firstRunShot = shot('first-run-390', 390, firstRun);

gallery('settings', [
  shot('filled-1100', 1100, filled),
  shot('filled-390', 390, filled),
  shot('first-run-1100', 1100, firstRun),
  firstRunShot,
  shot('setup-done-720', 720, setupDone),
  statesShot,
  scrolledShot,
  shot('large-text-390', 390, largeText),
  // Accessibility settings: switches, Team | Personal, focus, the checklist glyphs and the
  // field messages must survive the system palette and read in more contrast. (Reduced
  // motion only removes the "✓ Saved" fade, which a still can't show.)
  variant(statesShot, 'forced-colors', { forcedColors: true }),
  variant(firstRunShot, 'forced-colors', { forcedColors: true }),
  variant(statesShot, 'more-contrast', { moreContrast: true }),
]);
