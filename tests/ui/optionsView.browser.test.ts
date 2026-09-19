import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyApiKey } from '@lib/gemini/rest';
import { verifyDatabase } from '@lib/notion/verify';
import type { Settings } from '@lib/types';
import { createOptionsView, type OptionsHandlers } from '@lib/ui/optionsView';

const SETTINGS: Settings = {
  geminiApiKey: 'manet-test-invalid-key',
  notionToken: 'ntn_example',
  notionTeamDbId: '1a2b3c4d5e6f40718293a4b5c6d7e8f9',
  notionPersonalDbId: '',
  defaultRoute: 'personal',
  autoTranscribe: false,
  retentionDays: 14,
  displayName: 'Ilya',
  customVocabulary: ['Lumind', 'Manet'],
  languageCodes: ['en-US', 'fr-FR'],
  includeMic: true,
};

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => root.remove());

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const field = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  root.querySelector<T>(`[name="${name}"]`)!;
const button = (label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** Settings persistence (chrome.storage in the extension) kept in memory; verification is real. */
function handlers() {
  const saved: Settings[] = [];
  const calls: string[] = [];
  const h: OptionsHandlers = {
    save: async (s) => {
      saved.push(s);
    },
    verifyGemini: (key) => verifyApiKey(key),
    verifyNotion: (token, db) => verifyDatabase(token, db),
    openPermissionPage: () => void calls.push('openPermissionPage'),
  };
  return { saved, calls, handlers: h };
}

describe('options view (real DOM)', () => {
  it('fills every setting into a labelled field', () => {
    const view = createOptionsView(root, handlers().handlers);
    view.load(SETTINGS);
    expect(field('displayName').value).toBe('Ilya');
    expect(field('geminiApiKey').value).toBe('manet-test-invalid-key');
    expect(field('notionToken').value).toBe('ntn_example');
    expect(field('notionTeamDbId').value).toBe(SETTINGS.notionTeamDbId);
    expect(field('notionPersonalDbId').value).toBe('');
    expect(root.querySelector<HTMLInputElement>('[name="defaultRoute"][value="personal"]')!.checked).toBe(true);
    expect(field('autoTranscribe').checked).toBe(false);
    expect(field('retentionDays').value).toBe('14');
    expect(field<HTMLTextAreaElement>('customVocabulary').value).toBe('Lumind\nManet');
    expect(field('languageCodes').value).toBe('en-US, fr-FR');
    expect(field('includeMic').checked).toBe(true);

    for (const el of root.querySelectorAll<HTMLInputElement>('input:not([type="radio"]), textarea')) {
      const label = el.labels?.[0];
      expect(text(label), el.name).not.toBe('');
    }
  });

  it('masks keys and can reveal them', () => {
    const view = createOptionsView(root, handlers().handlers);
    view.load(SETTINGS);
    const key = field('geminiApiKey');
    expect(key.type).toBe('password');
    expect(field('notionToken').type).toBe('password');
    const toggle = root.querySelector<HTMLButtonElement>('button[aria-controls="geminiApiKey"]')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(key.type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    toggle.click();
    expect(key.type).toBe('password');
  });

  it('saves the parsed form', async () => {
    const h = handlers();
    const view = createOptionsView(root, h.handlers);
    view.load(SETTINGS);
    type(field('displayName'), '  Ilya   K ');
    type(field<HTMLTextAreaElement>('customVocabulary'), 'Lumind\n\nManet\nOPFS\n');
    type(field('languageCodes'), 'fr-fr');
    type(field('retentionDays'), '30');
    root.querySelector<HTMLInputElement>('[name="defaultRoute"][value="team"]')!.click();
    field('autoTranscribe').click();
    expect(text(root.querySelector('[data-role="save-status"]'))).toBe('Unsaved changes.');
    button('Save')!.click();
    await until(() => h.saved.length === 1);
    expect(h.saved[0]).toEqual({
      ...SETTINGS,
      displayName: 'Ilya K',
      customVocabulary: ['Lumind', 'Manet', 'OPFS'],
      languageCodes: ['fr-FR'],
      retentionDays: 30,
      defaultRoute: 'team',
      autoTranscribe: true,
    });
    await until(() => text(root.querySelector('[data-role="save-status"]')) === 'Saved.');
  });

  it('shows every problem next to its field and saves nothing', async () => {
    const h = handlers();
    const view = createOptionsView(root, h.handlers);
    view.load(SETTINGS);
    type(field('retentionDays'), 'a week');
    type(field('languageCodes'), 'english');
    type(field('notionPersonalDbId'), 'my personal db');
    button('Save')!.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.saved).toEqual([]);
    for (const name of ['retentionDays', 'languageCodes', 'notionPersonalDbId']) {
      const el = field(name);
      expect(el.getAttribute('aria-invalid'), name).toBe('true');
      const described = el.getAttribute('aria-describedby')!.split(' ');
      const message = described.map((id) => root.querySelector(`#${id}`)).find((n) => n?.classList.contains('error'));
      expect(text(message), name).not.toBe('');
    }
    expect(field('displayName').getAttribute('aria-invalid')).toBeNull();
    // Focus goes to the first problem in form order (You, Gemini, Notion, Recording).
    expect(document.activeElement).toBe(field('languageCodes'));
    expect(text(root.querySelector('[data-role="save-status"]'))).toMatch(/Fix/);

    type(field('retentionDays'), '7');
    type(field('languageCodes'), '');
    type(field('notionPersonalDbId'), '');
    button('Save')!.click();
    await until(() => h.saved.length === 1);
    expect(field('retentionDays').getAttribute('aria-invalid')).toBeNull();
  });

  it('saves language codes Gemini does not list, and warns next to the field', async () => {
    const h = handlers();
    const view = createOptionsView(root, h.handlers);
    const warning = () => root.querySelector<HTMLElement>('[data-role="languageCodes-warning"]');
    view.load(SETTINGS);
    expect(warning()?.hidden ?? true).toBe(true);

    type(field('languageCodes'), 'fr, cmn-Hans-CN');
    // Shown while typing, not only after saving.
    expect(warning()?.hidden).toBe(false);
    expect(text(warning())).toContain('"fr" (try fr-FR)');
    expect(field('languageCodes').getAttribute('aria-describedby')!.split(' ')).toContain(warning()!.id);
    button('Save')!.click();
    await until(() => h.saved.length === 1);
    expect(h.saved[0]!.languageCodes).toEqual(['fr', 'cmn-Hans-CN']);
    expect(field('languageCodes').getAttribute('aria-invalid')).toBeNull();
    await until(() => text(root.querySelector('[data-role="save-status"]')) === 'Saved.');
    expect(warning()?.hidden).toBe(false);

    // Settings saved by an older version, which rewrote cmn-Hans-CN.
    view.load({ ...SETTINGS, languageCodes: ['zh-Hans-CN'] });
    expect(text(warning())).toContain('"zh-Hans-CN" (try cmn-Hans-CN or yue-Hant-HK)');
    type(field('languageCodes'), 'cmn-Hans-CN');
    expect(warning()?.hidden).toBe(true);
    expect(field('languageCodes').getAttribute('aria-describedby')).toBe('languageCodes-hint');
  });

  it('tests the Gemini key typed in the form against the real API', async () => {
    const view = createOptionsView(root, handlers().handlers);
    view.load({ ...SETTINGS, geminiApiKey: '' });
    button('Test Gemini key')!.click();
    const result = () => text(root.querySelector('[data-role="gemini-result"]'));
    await until(() => result() !== '' && result() !== 'Checking…');
    expect(result()).toBe('No API key entered.');

    type(field('geminiApiKey'), 'manet-test-invalid-key');
    button('Test Gemini key')!.click();
    expect(result()).toBe('Checking…');
    await until(() => result() !== 'Checking…');
    // Needs network access to generativelanguage.googleapis.com.
    expect(result()).toMatch(/API key not valid/);
    expect(root.querySelector('[data-role="gemini-result"]')!.classList.contains('error')).toBe(true);
  });

  it('tests both Notion databases and lists their problems', async () => {
    const view = createOptionsView(root, handlers().handlers);
    view.load({ ...SETTINGS, notionToken: '', notionPersonalDbId: '' });
    button('Test Notion databases')!.click();
    const result = () => root.querySelector('[data-role="notion-result"]')!;
    await until(() => !text(result()).includes('Checking'));
    const team = result().querySelector('[data-db="team"]')!;
    expect(text(team)).toMatch(/^Team/);
    expect(text(team)).toMatch(/Notion integration token/);
    expect(text(result().querySelector('[data-db="personal"]'))).toMatch(/not set/i);

    type(field('notionToken'), 'ntn_example');
    type(field('notionTeamDbId'), 'Team meetings');
    button('Test Notion databases')!.click();
    await until(() => !text(result()).includes('Checking'));
    expect(text(result().querySelector('[data-db="team"] li'))).toMatch(/not a Notion database id or link/);
  });

  it('shows the microphone permission and links to the permission page', () => {
    const h = handlers();
    const view = createOptionsView(root, h.handlers);
    view.load(SETTINGS);
    view.setMic('prompt');
    const mic = () => root.querySelector('[data-role="mic"]')!;
    expect(text(mic())).toMatch(/not allowed yet/);
    button('Grant microphone access')!.click();
    expect(h.calls).toEqual(['openPermissionPage']);

    field('includeMic').click();
    expect(text(mic())).toMatch(/off in settings/i);
    view.setMic('granted');
    field('includeMic').click();
    expect(text(mic())).toMatch(/Microphone on/);
    expect(button('Grant microphone access')).toBeUndefined();
  });
});
