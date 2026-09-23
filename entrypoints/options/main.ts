import '@lib/ui/styles.css';
import { verifyApiKey } from '@lib/gemini/rest';
import { errorMessage } from '@lib/messages';
import { verifyDatabase } from '@lib/notion/verify';
import { getSettings, settingsItem, updateSettings } from '@lib/settings';
import type { Settings } from '@lib/types';
import { callout } from '@lib/ui/controls';
import { h, mount } from '@lib/ui/dom';
import { openExtensionPage } from '@lib/ui/extension';
import { queryMicPermission, watchMicPermission } from '@lib/ui/mic';
import { createOptionsView } from '@lib/ui/optionsView';
import { createProfileEditorView, type ProfileEditorView, type ProfileField } from '@lib/ui/profileEditorView';

const root = document.getElementById('app')!;
const titleBlock = document.querySelector<HTMLElement>('.page-title-block');
/** Where a profile's editor shows, in place of the page title and the groups. */
const editorRoot = h('main', { class: 'page-body', id: 'profile-editor', hidden: true });
root.after(editorRoot);

function report(err: unknown): void {
  console.error('[manet]', errorMessage(err));
}

document.getElementById('open-dashboard')?.addEventListener('click', () => {
  openExtensionPage('/dashboard.html').catch(report);
});

const view = createOptionsView(root, {
  // Each commit writes only its own field, merged into what is stored now.
  update: (patch) => updateSettings(patch),
  verifyGemini: (apiKey) => verifyApiKey(apiKey),
  verifyNotion: (token, databaseId) => verifyDatabase(token, databaseId),
  openPermissionPage: () => {
    openExtensionPage('/permission.html').catch(report);
  },
  openProfile: (profileId, field) => {
    location.hash = `profile/${encodeURIComponent(profileId)}${field ? `/${field}` : ''}`;
  },
});

let latest: Settings | null = null;
/** The profile editor while options.html#profile/<id> is showing. */
let editor: { profileId: string; view: ProfileEditorView } | null = null;

function refresh(): Promise<void> {
  return getSettings().then((settings) => {
    latest = settings;
    view.load(settings);
    editor?.view.load(settings);
  });
}

/** Writes the stored profiles with `change` applied; resolves to what was stored. */
async function updateProfiles(change: (profiles: Settings['profiles']) => Settings['profiles']): Promise<Settings> {
  return updateSettings({ profiles: change((await getSettings()).profiles) });
}

function createEditor(profileId: string): ProfileEditorView {
  return createProfileEditorView(profileId, {
    save: (profile) => updateProfiles((profiles) => profiles.map((p) => (p.id === profile.id ? profile : p))),
    remove: (id) => updateProfiles((profiles) => profiles.filter((p) => p.id !== id)),
    makeDefault: (id) => updateSettings({ defaultProfileId: id }),
    // The stored token: the editor has no token field of its own.
    verifyDatabase: async (databaseId) => verifyDatabase((await getSettings()).notionToken, databaseId),
    back: () => {
      location.hash = '';
    },
  });
}

const PROFILE_FIELDS: readonly string[] = ['name', 'databaseId', 'prompt', 'vocabulary'] satisfies ProfileField[];

/** options.html#profile/<id>[/<field>] → the profile and field; null for any other hash. */
function profileRoute(hash: string): { profileId: string; field?: ProfileField } | null {
  const match = /^#profile\/([^/]+)(?:\/([^/]+))?$/.exec(hash);
  if (!match) return null;
  let profileId: string;
  try {
    profileId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const field = match[2];
  return field && PROFILE_FIELDS.includes(field) ? { profileId, field: field as ProfileField } : { profileId };
}

function showEditor(profileId: string, field?: ProfileField): void {
  if (editor?.profileId !== profileId) {
    leaveEditor();
    // Edits still in a Settings field are saved before the groups hide.
    view.flush();
    editor = { profileId, view: createEditor(profileId) };
    if (latest) editor.view.load(latest);
    editorRoot.replaceChildren(editor.view.element);
    root.hidden = true;
    if (titleBlock) titleBlock.hidden = true;
    editorRoot.hidden = false;
    window.scrollTo(0, 0);
  }
  if (field) editor.view.focus(field);
}

/** Saves what is still in the editor's fields, then drops it. The id it showed, if any. */
function leaveEditor(): string | null {
  if (!editor) return null;
  const { profileId } = editor;
  editor.view.flush();
  editor = null;
  editorRoot.replaceChildren();
  editorRoot.hidden = true;
  root.hidden = false;
  if (titleBlock) titleBlock.hidden = false;
  return profileId;
}

/**
 * options.html#geminiApiKey (any setting's name) focuses that setting: on load, and when
 * another page's openSettings(field) moves this tab to a new #field. The hash is then
 * dropped, so the next link to the same field is a change again (hashchange fires).
 */
function focusFromHash(): void {
  if (!location.hash) return;
  let name = '';
  try {
    name = decodeURIComponent(location.hash.slice(1));
  } catch {
    // A malformed escape: not a setting.
  }
  history.replaceState(history.state, '', location.pathname + location.search);
  view.focus(name);
}

/**
 * #profile/<id>[/<field>] shows that profile's editor; anything else shows the groups
 * (back from an editor: scrolled to its profile's row) and focuses a #setting.
 */
function route(): void {
  const target = profileRoute(location.hash);
  if (target) {
    showEditor(target.profileId, target.field);
    return;
  }
  const left = leaveEditor();
  if (left && !location.hash) view.focus(`profile-${left}`);
  focusFromHash();
}

refresh().then(
  () => {
    route();
    window.addEventListener('hashchange', route);
    // Changes from another tab (or the popup) show up here; edits in progress are kept.
    settingsItem.watch(() => void refresh().catch(report));
  },
  (err: unknown) => {
    report(err);
    mount(root, callout({ title: 'Couldn’t load settings', body: `${errorMessage(err)} Reload this tab to try again.` }));
  },
);

// Closing the tab doesn't blur the focused field: save what's in it, and let Chrome ask
// before leaving while a value can't be saved or a write is still running.
window.addEventListener('beforeunload', (event) => {
  const unsaved = editor ? editor.view.flush() : view.flush();
  if (unsaved) event.preventDefault();
});

queryMicPermission().then((state) => view.setMic(state), report);
void watchMicPermission((state) => view.setMic(state));
