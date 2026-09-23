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
});
