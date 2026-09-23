/**
 * The profile editor Settings drills into (entrypoints/options, src/lib/ui/profileEditorView.ts):
 * a starter profile, a client profile with four sections, and a name that collides with another
 * profile's. Mounted the way options/main.ts shows it, in place of the Settings groups.
 * Every shot asserts there is no horizontal scroll.
 */
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Profile, Settings } from '@lib/types';
import { createProfileEditorView, type ProfileEditorHandlers } from '@lib/ui/profileEditorView';
import optionsHtml from '../../entrypoints/options/index.html?raw';
import { gallery, shell, type Shot } from './harness';

const TEAM_DB = 'https://www.notion.so/lumind/Meetings-0123456789abcdef0123456789abcdef';

/** A client-facing profile with four sections, its own database and vocabulary. */
const CLIENT: Profile = {
  id: 'client',
  name: 'Client meeting',
  databaseId: 'fedcba9876543210fedcba9876543210',
  prompt: 'A call with a client or prospect: what they need, what we proposed, what happens next.',
  sections: [
    { id: 'context', title: 'Context', format: 'paragraph', instruction: 'Who the client is and why they’re meeting us.' },
    { id: 'discussion', title: 'Discussion', format: 'bullets', instruction: 'What was covered, point by point.' },
    { id: 'concerns', title: 'Concerns', format: 'bullets', instruction: 'Objections or open questions the client raised.' },
    { id: 'next-steps', title: 'Next steps', format: 'bullets', instruction: 'What each side agreed to do, and by when.' },
  ],
  vocabulary: ['Lumind', 'Manet', 'Halstead'],
};

function settingsWith(profiles: Profile[], defaultProfileId = 'team'): Settings {
  return normalizeSettings({ profiles, defaultProfileId, notionToken: 'ntn_example_token' });
}

/** Mounts the editor the way options/main.ts does: in place of the Settings groups. */
function mountEditor(settings: Settings, profileId: string): ReturnType<typeof createProfileEditorView> {
  const root = shell(optionsHtml);
  const titleBlock = document.querySelector<HTMLElement>('.page-title-block');
  root.hidden = true;
  if (titleBlock) titleBlock.hidden = true;
  const editorRoot = document.createElement('main');
  editorRoot.className = 'page-body';
  editorRoot.id = 'profile-editor';
  root.after(editorRoot);

  const handlers: ProfileEditorHandlers = {
    save: (profile) => Promise.resolve({ ...settings, profiles: settings.profiles.map((p) => (p.id === profile.id ? profile : p)) }),
    remove: (id) => Promise.resolve({ ...settings, profiles: settings.profiles.filter((p) => p.id !== id) }),
    makeDefault: (id) => Promise.resolve({ ...settings, defaultProfileId: id }),
    verifyDatabase: async () => ({ ok: true, title: 'Meetings' }),
    back: () => {},
  };
  const view = createProfileEditorView(profileId, handlers, { savedMs: 600_000 });
  editorRoot.replaceChildren(view.element);
  view.load(settings);
  return view;
}

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function noSideScroll(): void {
  const over = document.documentElement.scrollWidth - window.innerWidth;
  if (over > 0) throw new Error(`horizontal overflow: ${over}px`);
}

async function starter(): Promise<void> {
  mountEditor(settingsWith(starterProfiles(TEAM_DB, '')), 'team');
  await wait();
  noSideScroll();
}

async function client(): Promise<void> {
  mountEditor(settingsWith([...starterProfiles(TEAM_DB, ''), CLIENT]), 'client');
  await wait();
  noSideScroll();
}

async function nameError(): Promise<void> {
  const view = mountEditor(settingsWith(starterProfiles(TEAM_DB, '')), 'personal');
  const nameInput = document.querySelector<HTMLInputElement>('[data-key="name"]')!;
  nameInput.focus();
  nameInput.value = 'Team';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  nameInput.blur();
  await wait(60);
  void view;
  noSideScroll();
}

const shot = (name: string, width: number, render: () => Promise<void>): Shot => ({
  name: `profile-editor-${name}`,
  width,
  height: 800,
  full: true,
  render: async () => {
    await render();
    window.scrollTo(0, 0);
  },
});

gallery('profileEditor', [
  shot('starter-1100', 1100, starter),
  shot('starter-390', 390, starter),
  shot('client-1100', 1100, client),
  shot('client-390', 390, client),
  shot('name-error-720', 720, nameError),
]);
