import { afterEach, describe, expect, it, vi } from 'vitest';
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Profile, Settings } from '@lib/types';
import { createProfileEditorView, type ProfileEditorHandlers } from '@lib/ui/profileEditorView';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';

function setup(profiles: Profile[] = starterProfiles(DB, ''), id = 'personal') {
  let settings: Settings = normalizeSettings({ profiles, defaultProfileId: 'team', notionToken: 'ntn_x' });
  const replace = (next: Settings) => {
    settings = next;
    return Promise.resolve(next);
  };
  const handlers: ProfileEditorHandlers = {
    save: vi.fn((p: Profile) => replace({ ...settings, profiles: settings.profiles.map((q) => (q.id === p.id ? p : q)) })),
    remove: vi.fn((pid: string) => replace({ ...settings, profiles: settings.profiles.filter((q) => q.id !== pid) })),
    makeDefault: vi.fn((pid: string) => replace({ ...settings, defaultProfileId: pid })),
    verifyDatabase: vi.fn(async () => ({ ok: true as const, title: 'Personal meetings' })),
    back: vi.fn(),
  };
  const view = createProfileEditorView(id, handlers, { savedMs: 10, fadeMs: 1 });
  document.body.append(view.element);
  view.load(settings);
  const el = <T extends HTMLElement>(key: string) => view.element.querySelector<T>(`[data-key="${key}"]`)!;
  const type = (key: string, value: string) => {
    const input = el<HTMLInputElement | HTMLTextAreaElement>(key);
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { view, handlers, el, type, settle, get: () => settings };
}

/** Like setup(), but save() resolves after `delayMs` so races and in-flight writes can be tested. */
function setupDelayed(delayMs: number, profiles: Profile[] = starterProfiles(DB, ''), id = 'personal') {
  let settings: Settings = normalizeSettings({ profiles, defaultProfileId: 'team', notionToken: 'ntn_x' });
  const replace = (next: Settings) => {
    settings = next;
    return next;
  };
  const handlers: ProfileEditorHandlers = {
    save: vi.fn(
      (p: Profile) =>
        new Promise<Settings>((resolve) => {
          setTimeout(() => resolve(replace({ ...settings, profiles: settings.profiles.map((q) => (q.id === p.id ? p : q)) })), delayMs);
        }),
    ),
    remove: vi.fn((pid: string) => Promise.resolve(replace({ ...settings, profiles: settings.profiles.filter((q) => q.id !== pid) }))),
    makeDefault: vi.fn((pid: string) => Promise.resolve(replace({ ...settings, defaultProfileId: pid }))),
    verifyDatabase: vi.fn(async () => ({ ok: true as const, title: 'Personal meetings' })),
    back: vi.fn(),
  };
  const view = createProfileEditorView(id, handlers, { savedMs: 10, fadeMs: 1 });
  document.body.append(view.element);
  view.load(settings);
  const el = <T extends HTMLElement>(key: string) => view.element.querySelector<T>(`[data-key="${key}"]`)!;
  const settle = (ms = delayMs * 4 + 100) => new Promise((r) => setTimeout(r, ms));
  return { view, handlers, el, settle, get: () => settings };
}

afterEach(() => document.body.replaceChildren());

describe('profile editor', () => {
  it('saves a renamed profile on blur', async () => {
    const { handlers, type, settle, view } = setup();
    type('name', 'Weekly meeting');
    await settle();
    expect(handlers.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'personal', name: 'Weekly meeting' }));
    expect(view.element.querySelector('h1')?.textContent).toBe('Weekly meeting');
  });

  it('refuses a name another profile has, and says why under the field', async () => {
    const { handlers, type, settle, view } = setup();
    type('name', 'team');
    await settle();
    expect(handlers.save).not.toHaveBeenCalled();
    expect(view.element.textContent).toContain('Another profile is already called “team”.');
  });

  it('adds, moves, reformats and removes sections', async () => {
    const { handlers, el, settle, get } = setup();
    el('add-section').click();
    await settle();
    expect(get().profiles[1]!.sections.map((s) => s.title)).toEqual(['Summary', 'Key points', 'Decisions', 'New section']);
    const added = get().profiles[1]!.sections[3]!;
    el(`section-${added.id}-up`).click();
    await settle();
    expect(get().profiles[1]!.sections[2]!.id).toBe(added.id);
    el(`section-${added.id}-format`).querySelector<HTMLElement>('[data-value="paragraph"]')!.click();
    await settle();
    expect(get().profiles[1]!.sections[2]!.format).toBe('paragraph');
    el(`section-${added.id}-remove`).click();
    await settle();
    expect(get().profiles[1]!.sections).toHaveLength(3);
    expect(handlers.save).toHaveBeenCalledTimes(4);
  });

  it('refuses a section called Action items', async () => {
    const { type, settle, view, get } = setup();
    const first = get().profiles[1]!.sections[0]!;
    type(`section-${first.id}-title`, 'Action items');
    await settle();
    expect(view.element.textContent).toContain('“Action items” is always added at the end.');
    expect(get().profiles[1]!.sections[0]!.title).toBe('Summary');
  });

  it('checks the database with the stored token', async () => {
    const { el, type, settle, handlers, view } = setup();
    type('databaseId', DB);
    await settle();
    el('check').click();
    await settle();
    expect(handlers.verifyDatabase).toHaveBeenCalledWith(DB);
    expect(view.element.textContent).toContain('“Personal meetings” is ready.');
  });

  it('makes a profile the default, and keeps the default from being deleted', async () => {
    const { el, settle, handlers } = setup();
    el<HTMLInputElement>('default').click();
    await settle();
    expect(handlers.makeDefault).toHaveBeenCalledWith('personal');
    const team = setup(starterProfiles(DB, ''), 'team');
    expect(team.el('delete').getAttribute('aria-disabled')).toBe('true');
    expect(team.view.element.textContent).toContain('Make another profile the default first.');
  });

  it('deletes after asking, then goes back', async () => {
    const { el, settle, handlers } = setup();
    el('delete').click();
    el('delete-confirm').click();
    await settle();
    expect(handlers.remove).toHaveBeenCalledWith('personal');
    expect(handlers.back).toHaveBeenCalled();
  });

  it('keeps both edits when a second field commits before the first save resolves', async () => {
    const { el, settle, get } = setupDelayed(10);
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    nameInput.value = 'Weekly meeting';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.blur();
    const dbInput = el<HTMLInputElement>('databaseId');
    dbInput.focus();
    dbInput.value = DB;
    dbInput.dispatchEvent(new Event('input', { bubbles: true }));
    dbInput.blur();
    await settle();
    expect(get().profiles[1]).toMatchObject({ id: 'personal', name: 'Weekly meeting', databaseId: DB });
  });

  it('keeps an uncommitted edit and its element when a structural section change saves', async () => {
    const { el, settle, get } = setup();
    const first = get().profiles[1]!.sections[0]!;
    const titleInput = el<HTMLInputElement>(`section-${first.id}-title`);
    titleInput.value = 'Overview';
    titleInput.dispatchEvent(new Event('input', { bubbles: true }));
    el('add-section').click();
    await settle();
    expect(el<HTMLInputElement>(`section-${first.id}-title`)).toBe(titleInput);
    expect(titleInput.value).toBe('Overview');
  });

  it('keeps focus on the field the user moved to once an Enter-commit resolves', async () => {
    const { el, settle } = setupDelayed(10);
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    nameInput.value = 'Weekly meeting';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const dbInput = el<HTMLInputElement>('databaseId');
    dbInput.focus();
    await settle();
    expect(document.activeElement).toBe(dbInput);
  });

  it('keeps focus when the settings reload', () => {
    const { el, view, get } = setup();
    const dbInput = el<HTMLInputElement>('databaseId');
    dbInput.focus();
    view.load({ ...get() });
    expect(document.activeElement).toBe(dbInput);
  });

  it('keeps focus and typing in the next field while the previous one saves', async () => {
    const { el, settle, get } = setupDelayed(10);
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    nameInput.value = 'Weekly meeting';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    const promptInput = el<HTMLTextAreaElement>('prompt');
    promptInput.focus();
    promptInput.value = 'Keep it short';
    promptInput.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(get().profiles[1]!.name).toBe('Weekly meeting');
    expect(document.activeElement).toBe(promptInput);
    expect(promptInput.value).toBe('Keep it short');
  });

  it('never deletes the profile once it becomes the default, even from an open confirm', async () => {
    const { el, settle, handlers, view } = setup();
    el('delete').click();
    const confirm = el('delete-confirm');
    el<HTMLInputElement>('default').click();
    confirm.click();
    await settle();
    expect(handlers.makeDefault).toHaveBeenCalledWith('personal');
    expect(handlers.remove).not.toHaveBeenCalled();
    expect(handlers.back).not.toHaveBeenCalled();
    expect(view.element.querySelector('[data-key="delete-confirm"]')).toBeNull();
    expect(el('delete').getAttribute('aria-disabled')).toBe('true');
  });

  it('closes the delete confirm when another tab makes the profile the default', () => {
    const { el, view, get } = setup();
    el('delete').click();
    view.load({ ...get(), defaultProfileId: 'personal' });
    expect(view.element.querySelector('[data-key="delete-confirm"]')).toBeNull();
    expect(el('delete').getAttribute('aria-disabled')).toBe('true');
  });

  it('follows a change from elsewhere in a focused field that was not edited, and writes nothing back', async () => {
    const { el, view, get, handlers, settle } = setup();
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    const renamed = (name: string): Settings => ({
      ...get(),
      profiles: get().profiles.map((p) => (p.id === 'personal' ? { ...p, name } : p)),
    });
    view.load(renamed('Renamed elsewhere'));
    expect(nameInput.value).toBe('Renamed elsewhere');
    nameInput.blur();
    await settle();
    expect(handlers.save).not.toHaveBeenCalled();
    expect(nameInput.value).toBe('Renamed elsewhere');

    // An edit in progress is still kept.
    nameInput.focus();
    nameInput.value = 'Draft';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    view.load(renamed('Renamed again'));
    expect(nameInput.value).toBe('Draft');
  });

  it('shows the profile as deleted when it goes while a save is in flight', async () => {
    const { el, settle, handlers, view } = setupDelayed(10);
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    nameInput.value = 'Weekly meeting';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.blur();
    await handlers.remove('personal');
    await settle();
    expect(view.element.textContent).toContain('This profile was deleted.');
  });

  it('drops an edit left in a field once its profile is deleted', async () => {
    const { el, settle, handlers, view } = setup();
    el<HTMLInputElement>('name').value = 'Half typed';
    el('delete').click();
    el('delete-confirm').click();
    await settle();
    expect(handlers.back).toHaveBeenCalled();
    view.flush();
    await settle();
    expect(handlers.save).not.toHaveBeenCalled();
  });

  it('shows the committed value once a delayed save resolves, even if Esc fired first', async () => {
    const { el, settle } = setupDelayed(10);
    const nameInput = el<HTMLInputElement>('name');
    nameInput.focus();
    nameInput.value = 'Weekly meeting';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(nameInput.value).toBe('Weekly meeting');
  });
});
