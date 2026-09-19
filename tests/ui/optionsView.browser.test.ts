import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@lib/ui/styles.css';
import { verifyApiKey } from '@lib/gemini/rest';
import type { VerifyResult } from '@lib/notion/verify';
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

/** Everything needed to save meetings (Team is the default and has a database). */
const COMPLETE: Settings = { ...SETTINGS, defaultRoute: 'team' };

const EMPTY: Settings = {
  ...SETTINGS,
  geminiApiKey: '',
  notionToken: '',
  notionTeamDbId: '',
  notionPersonalDbId: '',
  defaultRoute: 'team',
  displayName: '',
};

let root: HTMLElement;
beforeEach(() => {
  document.body.className = 'page page-settings';
  root = document.createElement('main');
  document.body.append(root);
});
afterEach(() => root.remove());

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const field = <T extends HTMLElement = HTMLInputElement>(name: string) =>
  root.querySelector<T>(`[name="${name}"]`)!;
const msg = (name: string) => root.querySelector<HTMLElement>(`#${name}-msg`)!;
const saved = (name: string) => root.querySelector<HTMLElement>(`[data-saved-for="${name}"]`)!;
const button = (label: string) =>
  [...root.querySelectorAll('button')].find((b) => text(b) === label || b.getAttribute('aria-label') === label);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (check: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(25);
  }
};
/** Types like a person: focus, then one input event per character. */
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.focus();
  el.value = '';
  for (const ch of value) {
    el.value += ch;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (!value) el.dispatchEvent(new Event('input', { bubbles: true }));
};
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

/** chrome.storage kept in memory: update() merges a patch, like settings.ts updateSettings. */
function store(initial: Settings = SETTINGS, overrides: Partial<OptionsHandlers> = {}) {
  let current = { ...initial };
  const patches: Partial<Settings>[] = [];
  const calls: string[] = [];
  const handlers: OptionsHandlers = {
    update: async (patch) => {
      patches.push(patch);
      current = { ...current, ...patch };
      return current;
    },
    verifyGemini: (k) => verifyApiKey(k),
    verifyNotion: (token, db) => verifyDatabase(token, db),
    openPermissionPage: () => void calls.push('openPermissionPage'),
    ...overrides,
  };
  return { patches, calls, handlers, current: () => current };
}

const FAST = { savedMs: 60, fadeMs: 20 };

describe('settings page layout', () => {
  it('groups You, Notion, Transcription and Recording, applies changes instantly and ends with the privacy note', () => {
    const view = createOptionsView(root, store(COMPLETE).handlers, FAST);
    view.load(COMPLETE);
    expect([...root.querySelectorAll('.section-header')].map(text)).toEqual([
      'You',
      'Notion',
      'Transcription',
      'Recording',
    ]);
    expect(text(root.querySelector('[data-role="lede"]'))).toBe('Changes are saved as you make them.');
    expect(button('Save')).toBeUndefined();
    expect(root.querySelector('form')).toBeNull();
    expect(text(root.querySelector('[data-role="privacy"]'))).toMatch(/stay in this browser.*There is no Manet Meetings server\.$/);
    // Settings are complete: no checklist.
    expect(root.querySelector('[data-role="setup"]')).toBeNull();
  });

  it('fills every setting into a labelled control', () => {
    const view = createOptionsView(root, store().handlers, FAST);
    view.load(SETTINGS);
    expect(field('displayName').value).toBe('Ilya');
    expect(field('geminiApiKey').value).toBe('manet-test-invalid-key');
    expect(field('notionToken').value).toBe('ntn_example');
    expect(field('notionTeamDbId').value).toBe(SETTINGS.notionTeamDbId);
    expect(field('notionPersonalDbId').value).toBe('');
    const route = root.querySelector('[data-role="defaultRoute"]')!;
    expect(route.getAttribute('role')).toBe('group');
    expect(route.querySelector('[data-value="personal"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(route.querySelector('[data-value="team"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(field('autoTranscribe').checked).toBe(false);
    expect(field('autoTranscribe').getAttribute('role')).toBe('switch');
    expect(field('retentionDays').value).toBe('14');
    expect(field<HTMLTextAreaElement>('customVocabulary').value).toBe('Lumind\nManet');
    expect(field('languageCodes').value).toBe('en-US, fr-FR');
    expect(field('includeMic').checked).toBe(true);

    for (const el of root.querySelectorAll<HTMLInputElement>('input, textarea')) {
      expect(text(el.labels?.[0]), el.name).not.toBe('');
    }
    const routeLabel = document.getElementById(route.getAttribute('aria-labelledby')!);
    expect(text(routeLabel)).toBe('Default destination');
  });

  it('asks for the database link people copy, not a notion.so address it would not look like', () => {
    const view = createOptionsView(root, store(EMPTY).handlers, FAST);
    view.load(EMPTY);
    for (const name of ['notionTeamDbId', 'notionPersonalDbId']) {
      expect(field(name).placeholder, name).toBe('Paste the database link');
    }
    for (const el of root.querySelectorAll<HTMLInputElement>('[placeholder]')) {
      expect(el.placeholder, el.name).not.toMatch(/notion\.so|https?:/);
    }
  });
});

describe('links to a field (options.html#<field>)', () => {
  it('focuses the field a link names: text, secrets, switches and the default destination', () => {
    const view = createOptionsView(root, store().handlers, FAST);
    view.load(SETTINGS);
    const names = [
      'displayName',
      'notionToken',
      'notionTeamDbId',
      'notionPersonalDbId',
      'geminiApiKey',
      'customVocabulary',
      'languageCodes',
      'includeMic',
      'autoTranscribe',
      'retentionDays',
    ];
    for (const name of names) {
      expect(view.focus(name), name).toBe(true);
      expect(document.activeElement, name).toBe(field(name));
    }
    expect(view.focus('defaultRoute')).toBe(true);
    // The pressed segment: Personal in SETTINGS.
    expect(document.activeElement).toBe(root.querySelector('[data-role="defaultRoute"] [data-value="personal"]'));
  });

  it('leaves focus alone for anything that is not a setting', () => {
    const view = createOptionsView(root, store().handlers, FAST);
    view.load(SETTINGS);
    field('displayName').focus();
    for (const name of ['', 'nope', 'settings-notion', 'defaultRoute-label', 'toString']) {
      expect(view.focus(name), name).toBe(false);
    }
    expect(document.activeElement).toBe(field('displayName'));
  });
});

describe('instant apply', () => {
  it('commits a text field when it loses focus, not while typing, and writes only that field', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const name = field('displayName');
    type(name, '  Ilya   K ');
    await tick(20);
    expect(s.patches).toEqual([]);
    expect(text(saved('displayName'))).toBe('');

    name.blur();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ displayName: 'Ilya K' }]);
    await until(() => text(saved('displayName')) !== '');
    // The field shows what was saved.
    expect(name.value).toBe('Ilya K');
    expect(saved('displayName').getAttribute('role')).toBe('status');
    expect(text(saved('displayName'))).toMatch(/Saved$/);
    // Fades after a while, then empties.
    await until(() => saved('displayName').classList.contains('is-fading'));
    await until(() => text(saved('displayName')) === '');

    // Blurring again without a change writes nothing.
    name.focus();
    name.blur();
    await tick(20);
    expect(s.patches).toHaveLength(1);
  });

  it('commits on Enter', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    type(field('retentionDays'), '30');
    key(field('retentionDays'), 'Enter');
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ retentionDays: 30 }]);
    expect(document.activeElement).toBe(field('retentionDays'));
  });

  it('never writes an invalid value; the fix shows under the field until it is valid', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const days = field('retentionDays');
    type(days, 'a week');
    days.blur();
    await tick(20);
    expect(s.patches).toEqual([]);
    expect(days.getAttribute('aria-invalid')).toBe('true');
    expect(msg('retentionDays').dataset.tone).toBe('caution');
    expect(msg('retentionDays').querySelector('.glyph-caution')).not.toBeNull();
    expect(text(msg('retentionDays'))).toBe('Enter a number of days from 0 to 365.');
    expect(days.getAttribute('aria-describedby')!.split(' ')).toContain('retentionDays-msg');
    expect(text(saved('retentionDays'))).toBe('');

    // Clears as soon as the value is valid again, before it is committed.
    type(days, '7');
    expect(days.getAttribute('aria-invalid')).toBeNull();
    expect(text(msg('retentionDays'))).toBe('');
    days.blur();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ retentionDays: 7 }]);
  });

  it('commits secrets only on blur or Enter, and masks them', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const token = field('notionToken');
    expect(token.type).toBe('password');
    expect(field('geminiApiKey').type).toBe('password');
    expect(token.autocomplete).toBe('off');
    type(token, 'ntn_new_secret');
    await tick(20);
    expect(s.patches).toEqual([]);
    key(token, 'Enter');
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ notionToken: 'ntn_new_secret' }]);

    const toggle = root.querySelector<HTMLButtonElement>('button[aria-controls="notionToken"]')!;
    toggle.click();
    expect(token.type).toBe('text');
    expect(text(toggle)).toBe('Hide');
    toggle.click();
    expect(token.type).toBe('password');
  });

  it('Escape puts back the saved value', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const name = field('displayName');
    type(name, 'Someone else');
    key(name, 'Escape');
    expect(name.value).toBe('Ilya');
    name.blur();
    await tick(20);
    expect(s.patches).toEqual([]);
  });

  it('saves the cleaned-up vocabulary and counts its terms', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const vocabulary = field<HTMLTextAreaElement>('customVocabulary');
    expect(text(root.querySelector('[data-role="vocabulary-count"]'))).toBe('2 of 1,000 terms');
    type(vocabulary, 'Lumind\n\nManet\nOPFS\nlumind\n');
    expect(text(root.querySelector('[data-role="vocabulary-count"]'))).toBe('3 of 1,000 terms');
    // Enter makes a new line in the list; it doesn't commit.
    key(vocabulary, 'Enter');
    await tick(20);
    expect(s.patches).toEqual([]);
    vocabulary.blur();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ customVocabulary: ['Lumind', 'Manet', 'OPFS'] }]);
    expect(vocabulary.value).toBe('Lumind\nManet\nOPFS');
  });

  it('notes unlisted language codes while typing and saves them; refuses things that are not codes', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const languages = field('languageCodes');
    expect(text(msg('languageCodes'))).toBe('');

    type(languages, 'fr, cmn-Hans-CN');
    // Shown while typing, as advice (ⓘ), not as an error.
    expect(msg('languageCodes').dataset.tone).toBe('neutral');
    expect(msg('languageCodes').querySelector('.glyph-info')).not.toBeNull();
    expect(text(msg('languageCodes'))).toBe('Gemini doesn’t list “fr” for transcription. Try fr-FR, or leave this empty.');
    expect(languages.getAttribute('aria-invalid')).toBeNull();
    languages.blur();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ languageCodes: ['fr', 'cmn-Hans-CN'] }]);
    expect(text(msg('languageCodes'))).toMatch(/^Gemini doesn’t list “fr”/);

    type(languages, 'english!!');
    languages.blur();
    await tick(20);
    expect(s.patches).toHaveLength(1);
    expect(msg('languageCodes').dataset.tone).toBe('caution');
    // The error names the problem; the hint under it carries the format, said once.
    expect(text(msg('languageCodes'))).toBe('“english!!” isn’t a language code.');
    expect(text(document.getElementById('languageCodes-hint')!)).toMatch(/^Codes like en-US or fr-FR\./);
    expect(languages.getAttribute('aria-invalid')).toBe('true');

    type(languages, 'cmn-Hans-CN');
    expect(text(msg('languageCodes'))).toBe('');
    expect(languages.getAttribute('aria-invalid')).toBeNull();
  });

  it('applies switches as soon as they change', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    field('autoTranscribe').click();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ autoTranscribe: true }]);
    await until(() => text(saved('autoTranscribe')) !== '');
    field('includeMic').click();
    await until(() => s.patches.length === 2);
    expect(s.patches[1]).toEqual({ includeMic: false });
  });

  it('keeps focus on a switch while it saves, and it can’t flip twice', async () => {
    let finish: (s: Settings) => void = () => {};
    const s = store(SETTINGS, { update: () => new Promise<Settings>((r) => (finish = r)) });
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const auto = field('autoTranscribe');
    auto.focus();
    auto.click();
    expect(auto.checked).toBe(true);
    expect(auto.getAttribute('aria-disabled')).toBe('true');
    auto.click();
    expect(auto.checked).toBe(true);
    expect(document.activeElement).toBe(auto);
    await tick(10);
    finish({ ...SETTINGS, autoTranscribe: true });
    await until(() => auto.getAttribute('aria-disabled') === null);
    expect(auto.checked).toBe(true);
  });

  it('sets the default destination with Team | Personal: arrows move focus, activation saves', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const route = root.querySelector<HTMLElement>('[data-role="defaultRoute"]')!;
    const team = route.querySelector<HTMLButtonElement>('[data-value="team"]')!;
    const personal = route.querySelector<HTMLButtonElement>('[data-value="personal"]')!;
    personal.focus();
    key(personal, 'ArrowLeft');
    expect(document.activeElement).toBe(team);
    await tick(20);
    expect(s.patches).toEqual([]);

    team.click();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ defaultRoute: 'team' }]);
    await until(() => team.getAttribute('aria-pressed') === 'true');
    expect(personal.getAttribute('aria-pressed')).toBe('false');
    expect(text(saved('defaultRoute'))).toMatch(/Saved$/);
  });

  it('says why a write failed and tries again on the next commit', async () => {
    let fail = true;
    const s = store();
    const update = s.handlers.update;
    s.handlers.update = (patch) => (fail ? Promise.reject(new Error('Storage is full.')) : update(patch));
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const name = field('displayName');
    type(name, 'Ilya K');
    name.blur();
    await until(() => text(msg('displayName')) !== '');
    expect(text(msg('displayName'))).toBe('Couldn’t save: Storage is full.');
    expect(msg('displayName').dataset.tone).toBe('caution');
    expect(name.value).toBe('Ilya K');

    fail = false;
    name.focus();
    name.blur();
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ displayName: 'Ilya K' }]);
    await until(() => text(msg('displayName')) === '');
  });

  it('refreshes fields from storage without touching one being edited', () => {
    const view = createOptionsView(root, store().handlers, FAST);
    view.load(SETTINGS);
    type(field('displayName'), 'Ilya K');
    view.load({ ...SETTINGS, displayName: 'From another tab', retentionDays: 3, autoTranscribe: true });
    expect(field('displayName').value).toBe('Ilya K');
    expect(field('retentionDays').value).toBe('3');
    expect(field('autoTranscribe').checked).toBe(true);
  });

  it('flush() saves an edit still in its field (the tab is closing) and reports it', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    expect(view.flush()).toBe(false);
    type(field('notionToken'), 'ntn_pasted');
    expect(view.flush()).toBe(true);
    await until(() => s.patches.length === 1);
    expect(s.patches).toEqual([{ notionToken: 'ntn_pasted' }]);
    expect(view.flush()).toBe(false);
  });
});

describe('setup checklist', () => {
  const setup = () => root.querySelector<HTMLElement>('[data-role="setup"]');
  const item = (k: string) => setup()!.querySelector<HTMLElement>(`[data-item="${k}"]`)!;

  it('lists what saving to Notion still needs, and each item goes to its field', async () => {
    const initial = { ...EMPTY, displayName: 'Ilya' };
    const view = createOptionsView(root, store(initial).handlers, FAST);
    view.load(initial);
    expect(setup()!.dataset.state).toBe('incomplete');
    expect(text(setup()!.querySelector('h2'))).toBe('Meetings can’t be saved to Notion yet');
    expect([...setup()!.querySelectorAll('[data-item]')].map((li) => li.getAttribute('data-item'))).toEqual([
      'displayName',
      'notionToken',
      'notionTeamDbId',
      'geminiApiKey',
    ]);
    expect(item('displayName').dataset.done).toBe('true');
    expect(item('displayName').querySelector('.glyph-done')).not.toBeNull();
    expect(item('notionToken').dataset.done).toBe('false');
    expect(item('notionToken').querySelector('.glyph-caution')).not.toBeNull();
    expect(text(item('geminiApiKey'))).toMatch(/Gemini API key.*optional/);
    expect(item('geminiApiKey').querySelector('.glyph-caution')).toBeNull();

    item('notionToken').querySelector('button')!.click();
    expect(document.activeElement).toBe(field('notionToken'));

    type(field('notionToken'), 'ntn_x');
    field('notionToken').blur();
    await until(() => item('notionToken').dataset.done === 'true');
    expect(setup()!.dataset.state).toBe('incomplete');
    type(field('notionTeamDbId'), 'https://www.notion.so/lumind/Meetings-0123456789abcdef0123456789abcdef');
    field('notionTeamDbId').blur();
    // Stays in place (nothing below it moves) and turns into a confirmation.
    await until(() => setup()!.dataset.state === 'complete');
    expect(text(setup()!.querySelector('h2'))).toBe('Meetings will be saved to Notion');
    expect(text(setup()!.querySelector('[role="status"]'))).toMatch(/saved to Notion/);
  });

  it('adds the Personal database when that is the default destination', () => {
    const view = createOptionsView(root, store(EMPTY).handlers, FAST);
    view.load({ ...EMPTY, defaultRoute: 'personal' });
    expect(setup()!.querySelector('[data-item="notionPersonalDbId"]')).not.toBeNull();
  });
});

describe('Check buttons', () => {
  it('tests the Gemini key in the field against the real API and says so under the field', async () => {
    const view = createOptionsView(root, store({ ...SETTINGS, geminiApiKey: '' }).handlers, FAST);
    view.load({ ...SETTINGS, geminiApiKey: '' });
    const check = root.querySelector<HTMLButtonElement>('[data-role="check-gemini"]')!;
    expect(text(check)).toBe('Check');
    check.click();
    await until(() => text(msg('geminiApiKey')) !== '');
    expect(text(msg('geminiApiKey'))).toBe('Paste a key from aistudio.google.com/apikey first.');

    type(field('geminiApiKey'), 'manet-test-invalid-key');
    check.focus();
    check.click();
    expect(text(check)).toBe('Checking…');
    expect(check.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(check);
    // Needs access to generativelanguage.googleapis.com.
    await until(() => text(check) === 'Check');
    expect(text(msg('geminiApiKey'))).toBe(
      'Gemini doesn’t accept this key. Copy it again from aistudio.google.com/apikey.',
    );
    expect(msg('geminiApiKey').dataset.tone).toBe('caution');
    expect(document.activeElement).toBe(check);
  });

  it('shows a passing key with ✓, and clears the result when the key changes', async () => {
    const view = createOptionsView(root, store(SETTINGS, { verifyGemini: async () => ({ ok: true }) }).handlers, FAST);
    view.load(SETTINGS);
    root.querySelector<HTMLButtonElement>('[data-role="check-gemini"]')!.click();
    await until(() => text(msg('geminiApiKey')) !== '');
    expect(text(msg('geminiApiKey'))).toBe('The key works.');
    expect(msg('geminiApiKey').dataset.tone).toBe('done');
    type(field('geminiApiKey'), 'AIzaOther');
    expect(text(msg('geminiApiKey'))).toBe('');
  });

  it('says when it checked a value that is not saved', async () => {
    const s = store(SETTINGS, { verifyGemini: async () => ({ ok: true }) });
    s.handlers.update = () => Promise.reject(new Error('Storage is full.'));
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    type(field('geminiApiKey'), 'AIzaNewKey');
    const check = root.querySelector<HTMLButtonElement>('[data-role="check-gemini"]')!;
    field('geminiApiKey').blur();
    check.click();
    await until(() => text(msg('geminiApiKey')).startsWith('The key works'));
    expect(text(msg('geminiApiKey'))).toBe('The key works. Checked the key in the field, which isn’t saved.');
  });

  it('checks both databases and puts each result under its own field', async () => {
    const asked: string[] = [];
    const verifyNotion = async (_token: string, db: string): Promise<VerifyResult> => {
      asked.push(db);
      return { ok: true, title: 'Meetings' };
    };
    const view = createOptionsView(root, store(SETTINGS, { verifyNotion }).handlers, FAST);
    view.load(SETTINGS);
    const check = root.querySelector<HTMLButtonElement>('[data-role="check-notion"]')!;
    expect(text(check)).toBe('Check');
    expect(check.getAttribute('aria-label')).toBe('Check both databases');
    check.click();
    await until(() => text(msg('notionTeamDbId')) !== '');
    expect(asked).toEqual([SETTINGS.notionTeamDbId]);
    expect(text(msg('notionTeamDbId'))).toBe('“Meetings” is ready.');
    expect(msg('notionTeamDbId').dataset.tone).toBe('done');
    expect(text(msg('notionPersonalDbId'))).toBe('Not set yet. Add it to save meetings to Personal.');
    expect(msg('notionPersonalDbId').dataset.tone).toBe('neutral');
  });

  it('skips a database whose field holds no link and keeps its fix', async () => {
    const asked: string[] = [];
    const s = store(SETTINGS, {
      verifyNotion: async (_t, db) => {
        asked.push(db);
        return { ok: true, title: 'Meetings' };
      },
    });
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    type(field('notionPersonalDbId'), 'my personal db');
    field('notionPersonalDbId').blur();
    root.querySelector<HTMLButtonElement>('[data-role="check-notion"]')!.click();
    await until(() => text(msg('notionTeamDbId')) !== '');
    expect(asked).toEqual([SETTINGS.notionTeamDbId]);
    expect(text(msg('notionPersonalDbId'))).toBe('Paste the database link or ID from Notion.');
  });

  it('reports a rejected token once, under the token', async () => {
    // What verifyDatabase says for a 401. (The real API can't be called from this page:
    // Notion sends no CORS headers; the extension gets through with host permissions.)
    const rejected: VerifyResult = {
      ok: false,
      problems: ['Notion rejected this token. Copy it again from Notion.'],
      tokenProblem: true,
    };
    const verifyNotion = () => new Promise<VerifyResult>((r) => setTimeout(() => r(rejected), 30));
    const view = createOptionsView(root, store(SETTINGS, { verifyNotion }).handlers, FAST);
    view.load({ ...SETTINGS, notionPersonalDbId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0' });
    const check = root.querySelector<HTMLButtonElement>('[data-role="check-notion"]')!;
    check.click();
    expect(text(check)).toBe('Checking…');
    await until(() => text(check) === 'Check');
    expect(text(msg('notionToken'))).toBe('Notion rejected this token. Copy it again from Notion.');
    expect(field('notionToken').getAttribute('aria-invalid')).toBe('true');
    expect(text(msg('notionTeamDbId'))).toBe('');
    expect(text(msg('notionPersonalDbId'))).toBe('');
  });

  it('asks for a token before checking databases', async () => {
    const asked: string[] = [];
    const s = store({ ...SETTINGS, notionToken: '' }, { verifyNotion: async (_t, db) => (asked.push(db), { ok: true, title: 'x' }) });
    const view = createOptionsView(root, s.handlers, FAST);
    view.load({ ...SETTINGS, notionToken: '' });
    root.querySelector<HTMLButtonElement>('[data-role="check-notion"]')!.click();
    await until(() => text(msg('notionToken')) !== '');
    expect(text(msg('notionToken'))).toBe('Paste a token first.');
    expect(asked).toEqual([]);
  });
});

describe('microphone', () => {
  it('shows what Chrome allows under the switch, with the way to fix it', async () => {
    const s = store();
    const view = createOptionsView(root, s.handlers, FAST);
    view.load(SETTINGS);
    const mic = () => root.querySelector<HTMLElement>('[data-role="mic"]')!;
    expect(mic().getAttribute('role')).toBe('status');

    view.setMic('prompt');
    expect(text(mic())).toBe('Chrome hasn’t allowed the microphone yet. Allow microphone…');
    expect(mic().dataset.tone).toBe('caution');
    expect(mic().querySelector('.glyph-caution')).not.toBeNull();
    button('Allow microphone…')!.click();
    expect(s.calls).toEqual(['openPermissionPage']);

    view.setMic('denied');
    expect(text(mic())).toBe('Chrome blocks the microphone for Manet Meetings. Fix in Chrome…');
    button('Fix in Chrome…')!.click();
    expect(s.calls).toEqual(['openPermissionPage', 'openPermissionPage']);

    view.setMic('granted');
    expect(text(mic())).toBe('Chrome allows the microphone.');
    expect(mic().dataset.tone).toBe('done');

    // With the mic off, Chrome's permission doesn't matter.
    view.setMic('prompt');
    field('includeMic').click();
    expect(text(mic())).toBe('');
    await until(() => s.patches.length === 1);
  });
});
