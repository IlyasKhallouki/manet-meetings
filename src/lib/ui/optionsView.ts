/**
 * Settings: grouped sections (You → Notion → Profiles → Transcription → Recording →
 * Share) that apply as you change them. There is no Save button (SPEC §5):
 *   - text fields and secrets commit on blur or Enter, never while typing;
 *   - a value that fails validation is never written: the saved one stays in effect and
 *     the fix shows under the field (settingsForm.parseField);
 *   - switches commit on activation;
 *   - each commit writes only its own field (handlers.update → settings.ts updateSettings),
 *     one at a time, and shows "✓ Saved" beside the label for 2 s (role=status).
 * Profiles are listed, one row each with its database's last check; a row opens the
 * profile editor (handlers.openProfile, profileEditorView.ts), which edits the profile.
 * Share (shareView.ts) exports the settings to a file and imports one in a single write,
 * queued with the field commits and merged into the settings stored when it runs, then
 * checks every profile's database.
 * Check results sit under the field or on the row they describe and say when they tested
 * a value that isn't saved. While meetings can't be saved to Notion, a checklist at the
 * top lists what is missing; each item focuses its field, as options.html#<setting> does
 * (focus()), which the other pages open through extension.ts openSettings(field).
 *
 * Loading, saving and verification come in as handlers, so the page renders in any DOM.
 */
import type { VerifyResult } from '../notion/verify';
import { defaultProfile, newProfile } from '../profiles';
import { MAX_VOCABULARY } from '../transcribe/requests';
import type { Profile, Settings } from '../types';
import {
  button,
  field,
  secretInput,
  section,
  setDisabled,
  setFieldMessage,
  switchInput,
  textInput,
  visuallyHidden,
  type MessageTone,
} from './controls';
import { h, type Child } from './dom';
import { svg, type Glyph } from './icons';
import type { MicPermission } from './mic';
import type { ProfileField } from './profileEditorView';
import { createShareView, type ShareHandlers } from './shareView';
import {
  formValue,
  parseField,
  parseVocabulary,
  profileCheckMessages,
  setupChecklist,
  setupComplete,
  type CheckMessage,
} from './settingsForm';

export interface OptionsHandlers {
  /**
   * The settings stored right now (settings.ts getSettings). A new profile and an import
   * are built from them when their write runs, so a change made meanwhile elsewhere (another
   * tab, the popup) isn't overwritten. Without it, from the last settings this view saw.
   */
  read?(): Promise<Settings>;
  /** Writes only these fields (settings.ts updateSettings) and returns the stored settings. */
  update(patch: Partial<Settings>): Promise<Settings>;
  verifyGemini(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }>;
  verifyNotion(token: string, databaseId: string): Promise<VerifyResult>;
  openPermissionPage(): void;
  /** Shows a profile's editor (options.html#profile/<id>), on `field` when given. */
  openProfile(profileId: string, field?: ProfileField): void;
  /**
   * Settings › Share's storage (the whole merged settings, in one write) and download; the
   * view supplies the stored settings and the check after an import.
   */
  share: { apply(next: Settings): Promise<Settings>; download: ShareHandlers['download'] };
}

export interface OptionsView {
  /**
   * Shows the stored settings. Call it again whenever storage changes: fields with an edit
   * in progress keep it, everything else follows the new value.
   */
  load(settings: Settings): void;
  setMic(permission: MicPermission): void;
  /**
   * Moves focus to a setting by its name (options.html#geminiApiKey): a field, a switch,
   * 'profiles' (the default profile's row: the database the popup and Meetings ask for) or
   * 'profile-<id>' (that profile's row, back from its editor). False, and focus stays, for
   * any other name.
   */
  focus(name: string): boolean;
  /**
   * Commits every edit still in its field (the tab is closing, so blur won't come).
   * True while anything is unsaved: an edit, an invalid value or a write in flight.
   */
  flush(): boolean;
}

export interface OptionsTiming {
  /** How long "✓ Saved" stays before it fades. */
  savedMs: number;
  /** The fade (matches .saved's 300 ms transition). */
  fadeMs: number;
}

type TextName = 'displayName' | 'notionToken' | 'geminiApiKey' | 'customVocabulary' | 'languageCodes' | 'retentionDays';
type SwitchName = 'includeMic' | 'autoTranscribe';

/** What a field's message slot shows, so a newer kind can replace or keep it. */
type MessageKind = 'invalid' | 'save' | 'check' | 'note';

interface TextField {
  name: TextName;
  /** Spoken with "saved" ("Name saved"). */
  label: string;
  input: HTMLInputElement | HTMLTextAreaElement;
  /** The .field element (setFieldMessage). */
  el: HTMLElement;
  saved: HTMLElement;
  message: MessageKind | null;
  /** The raw value being written right now, so blur + Enter don't write it twice. */
  writing: string | null;
}

interface ToggleRow {
  label: string;
  saved: HTMLElement;
  msg: HTMLElement;
}

const GLYPH: Record<MessageTone, Glyph> = { caution: 'caution', done: 'done', neutral: 'info' };
const MESSAGE_KINDS_CLEARED_BY_A_SAVE: MessageKind[] = ['invalid', 'save', 'note'];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function link(href: string, label: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noreferrer' }, label);
}

/** ▲/✓/ⓘ + text in a .field-msg that isn't a field()'s own slot (switch rows, the mic line). */
function renderMessage(slot: HTMLElement, content: Child | Child[] | null, tone: MessageTone = 'caution'): void {
  if (content === null) {
    slot.replaceChildren();
    delete slot.dataset.tone;
    return;
  }
  slot.dataset.tone = tone;
  slot.replaceChildren(svg(GLYPH[tone], { class: `tone-${tone}` }), h('span', null, content));
}

function geminiError(error: string): string {
  return /API key not valid/i.test(error)
    ? 'Gemini doesn’t accept this key. Copy it again from aistudio.google.com/apikey.'
    : error;
}

export function createOptionsView(
  root: HTMLElement,
  handlers: OptionsHandlers,
  timing: Partial<OptionsTiming> = {},
): OptionsView {
  const { savedMs = 2000, fadeMs = 300 } = timing;
  let stored: Settings | null = null;
  let permission: MicPermission | null = null;

  // ---- Writes: one at a time, so two quick commits can't overwrite each other ----------
  let queue: Promise<unknown> = Promise.resolve();
  let writing = 0;
  function enqueue(store: () => Promise<Settings>): Promise<Settings> {
    writing++;
    const run = queue.then(store);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      (next) => {
        writing--;
        return next;
      },
      (err: unknown) => {
        writing--;
        throw err;
      },
    );
  }
  /** The settings stored now, read when a write runs (after every write queued before it). */
  async function latest(): Promise<Settings> {
    return handlers.read ? handlers.read() : stored!;
  }
  /** Writes `patch`, or the patch built from the settings stored when the write runs. */
  function write(patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<Settings> {
    return enqueue(async () => handlers.update(typeof patch === 'function' ? patch(await latest()) : patch)).then(
      (next) => (stored = next),
    );
  }
  /** An import: the whole settings at once. Every field then follows them, as on load(). */
  function applyImport(merge: (current: Settings) => Settings): Promise<Settings> {
    return enqueue(async () => handlers.share.apply(merge(await latest()))).then((saved) => {
      load(saved);
      return saved;
    });
  }
  /** Commits in progress (validation, write, then their message), for Check to wait on. */
  const commits = new Set<Promise<void>>();
  /** Resolves once every commit and write started so far has finished, whatever the outcome. */
  const settled = () => Promise.all([queue, ...commits]).then(() => undefined);

  // ---- "✓ Saved" --------------------------------------------------------------------------
  const timers = new WeakMap<HTMLElement, number[]>();
  function savedSlot(name: string): HTMLElement {
    return h('span', { class: 'saved', role: 'status', 'data-saved-for': name });
  }
  function flashSaved(slot: HTMLElement, label: string): void {
    for (const t of timers.get(slot) ?? []) clearTimeout(t);
    slot.classList.remove('is-fading');
    slot.replaceChildren(svg('check'), visuallyHidden(`${label} `), 'Saved');
    const fade = window.setTimeout(() => {
      slot.classList.add('is-fading');
      const clear = window.setTimeout(() => {
        slot.replaceChildren();
        slot.classList.remove('is-fading');
      }, fadeMs);
      timers.set(slot, [clear]);
    }, savedMs);
    timers.set(slot, [fade]);
  }

  // ---- Text fields ------------------------------------------------------------------------
  const texts = new Map<TextName, TextField>();

  function textField(
    name: TextName,
    label: string,
    control: HTMLInputElement | HTMLTextAreaElement,
    /** row: what goes under the label instead of the bare control (a secret's field-row, or
     *  [control, unit] to lay out on one line). */
    options: { row?: HTMLElement | HTMLElement[]; hint?: Child | Child[]; spoken?: string } = {},
  ): HTMLElement {
    const saved = savedSlot(name);
    const el = field({
      id: name,
      label,
      control: options.row ?? control,
      hint: options.hint,
      status: saved,
    });
    const f: TextField = { name, label: options.spoken ?? label, input: control, el, saved, message: null, writing: null };
    texts.set(name, f);
    control.addEventListener('input', () => onInput(f));
    control.addEventListener('focusout', () => void commit(f));
    control.addEventListener('keydown', (e) => onKeydown(f, e as KeyboardEvent));
    return el;
  }

  function showMessage(f: TextField, kind: MessageKind, text: string, tone: MessageTone): void {
    setFieldMessage(f.el, text, tone);
    f.message = kind;
  }

  function clearMessage(f: TextField, kinds: MessageKind[]): void {
    if (f.message === null || !kinds.includes(f.message)) return;
    setFieldMessage(f.el, null);
    f.message = null;
  }

  /** Advice that doesn't block saving (unlisted language codes), or nothing. */
  function showNote(f: TextField, note: string | undefined): void {
    if (note) showMessage(f, 'note', note, 'neutral');
    else clearMessage(f, ['note']);
  }

  const isDirty = (f: TextField) => stored !== null && f.input.value !== formValue(stored, f.name);

  function onInput(f: TextField): void {
    if (f.name === 'customVocabulary') renderCount();
    // A Check result describes the value that was checked, not this one.
    clearMessage(f, ['check']);
    if (f.name === 'notionToken' && checks.size) {
      // The rows' results were checked with the token that was there.
      checks.clear();
      renderProfiles();
    }
    const result = parseField(f.name, f.input.value);
    if (f.message === 'invalid') {
      // Once a problem is showing, clear it the moment the value is valid. It isn't
      // rewritten on every keystroke (it's a live region): the next commit updates it.
      if (result.ok) {
        clearMessage(f, ['invalid']);
        showNote(f, result.note);
      }
      return;
    }
    if (f.name === 'languageCodes') showNote(f, result.ok ? result.note : undefined);
  }

  function onKeydown(f: TextField, e: KeyboardEvent): void {
    if (e.key === 'Escape' && stored) {
      if (!isDirty(f) && f.message !== 'invalid') return;
      e.preventDefault();
      f.input.value = formValue(stored, f.name);
      clearMessage(f, ['invalid', 'check']);
      if (f.name === 'languageCodes') {
        const result = parseField('languageCodes', f.input.value);
        showNote(f, result.ok ? result.note : undefined);
      }
      if (f.name === 'customVocabulary') renderCount();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    // In the vocabulary, Enter starts a new term; Ctrl/⌘+Enter commits.
    if (f.input instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    void commit(f);
  }

  function commit(f: TextField): Promise<void> {
    const run = commitText(f);
    commits.add(run);
    void run.finally(() => commits.delete(run));
    return run;
  }

  async function commitText(f: TextField): Promise<void> {
    if (!stored) return;
    const raw = f.input.value;
    if (raw === f.writing) return;
    const shown = formValue(stored, f.name);
    if (raw === shown) {
      clearMessage(f, ['invalid']);
      return;
    }
    const result = parseField(f.name, raw);
    if (!result.ok) {
      showMessage(f, 'invalid', result.error, 'caution');
      return;
    }
    // Only whitespace or order-preserving clean-up changed: show the clean value, write nothing.
    if (formValue({ ...stored, ...result.patch }, f.name) === shown && f.message !== 'save') {
      f.input.value = shown;
      clearMessage(f, ['invalid']);
      showNote(f, result.note);
      return;
    }
    f.writing = raw;
    try {
      const next = await write(result.patch);
      // Show what was saved (trimmed, deduped, recased) unless typing went on meanwhile.
      if (f.input.value === raw) f.input.value = formValue(next, f.name);
      clearMessage(f, MESSAGE_KINDS_CLEARED_BY_A_SAVE);
      showNote(f, result.note);
      flashSaved(f.saved, f.label);
      afterSave();
    } catch (err) {
      showMessage(f, 'save', `Couldn’t save: ${errorText(err)}`, 'caution');
    } finally {
      f.writing = null;
    }
  }

  // ---- Switches ------------------------------------------------------------------------------
  const switches = new Map<SwitchName, HTMLInputElement>();
  const toggleRows = new Map<SwitchName, ToggleRow>();

  function switchField(name: SwitchName, label: string, hint: string, extra: HTMLElement | null = null): HTMLElement {
    const saved = savedSlot(name);
    const msg = h('p', { class: 'field-msg', id: `${name}-msg`, role: 'status' });
    const input = switchInput({
      id: name,
      checked: false,
      describedBy: `${name}-hint${extra ? ` ${extra.id}` : ''} ${name}-msg`,
      attrs: { name },
      onChange: (checked) => void commitSwitch(name, input, checked),
    });
    switches.set(name, input);
    toggleRows.set(name, { label, saved, msg });
    return h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'switch-row-text' },
        h('div', { class: 'field-head' }, h('label', { class: 'field-label', for: name }, label), saved),
        h('p', { class: 'hint', id: `${name}-hint` }, hint),
        extra,
        msg,
      ),
      input,
    );
  }

  async function commitSwitch(name: SwitchName, input: HTMLInputElement, checked: boolean): Promise<void> {
    const row = toggleRows.get(name)!;
    if (name === 'includeMic') renderMic();
    if (!stored) return;
    setDisabled(input, true);
    try {
      await write({ [name]: checked });
      renderMessage(row.msg, null);
      flashSaved(row.saved, row.label);
      afterSave();
    } catch (err) {
      input.checked = !checked;
      renderMessage(row.msg, `Couldn’t save: ${errorText(err)}`);
      if (name === 'includeMic') renderMic();
    } finally {
      setDisabled(input, false);
    }
  }

  // ---- Microphone --------------------------------------------------------------------------
  const micLine = h('p', { class: 'field-msg settings-mic', id: 'includeMic-status', 'data-role': 'mic', role: 'status' });

  function renderMic(): void {
    const on = switches.get('includeMic')?.checked ?? false;
    if (!on || permission === null) {
      renderMessage(micLine, null);
      return;
    }
    const open = (label: string) =>
      button(label, { kind: 'link', onClick: () => handlers.openPermissionPage() });
    if (permission === 'granted') renderMessage(micLine, 'Chrome allows the microphone.', 'done');
    else if (permission === 'denied') {
      renderMessage(micLine, ['Chrome blocks the microphone for Minute Book. ', open('Fix in Chrome…')]);
    } else renderMessage(micLine, ['Chrome hasn’t allowed the microphone yet. ', open('Allow microphone…')]);
  }

  // ---- Vocabulary count ----------------------------------------------------------------------
  const count = h('span', { class: 'num', 'data-role': 'vocabulary-count' });
  function renderCount(): void {
    const terms = parseVocabulary(texts.get('customVocabulary')?.input.value ?? '').length;
    count.textContent = `${terms.toLocaleString('en-US')} of ${MAX_VOCABULARY.toLocaleString('en-US')} terms`;
  }

  // ---- Check buttons -----------------------------------------------------------------------
  function busy(el: HTMLButtonElement, on: boolean, idle: string, name: string): void {
    setDisabled(el, on);
    el.textContent = on ? 'Checking…' : idle;
    el.setAttribute('aria-label', on ? `Checking ${name}…` : `Check ${name}`);
  }

  const checkGeminiButton = button('Check', {
    class: 'settings-check',
    onClick: () => void checkGemini(),
    attrs: { 'data-role': 'check-gemini', 'aria-label': 'Check Gemini API key' },
  });

  async function checkGemini(): Promise<void> {
    const f = texts.get('geminiApiKey')!;
    busy(checkGeminiButton, true, 'Check', 'Gemini API key');
    try {
      await settled();
      const key = f.input.value.trim();
      if (!key) {
        showMessage(f, 'check', 'Paste a key from aistudio.google.com/apikey first.', 'caution');
        return;
      }
      if (f.message === 'invalid') return; // its fix is already showing
      let result: { ok: true } | { ok: false; error: string };
      try {
        result = await handlers.verifyGemini(key);
      } catch (err) {
        result = { ok: false, error: errorText(err) };
      }
      const unsaved = stored !== null && key !== stored.geminiApiKey ? ' Checked the key in the field, which isn’t saved.' : '';
      if (result.ok) showMessage(f, 'check', `The key works.${unsaved}`, 'done');
      else showMessage(f, 'check', `${geminiError(result.error)}${unsaved}`, 'caution');
    } finally {
      busy(checkGeminiButton, false, 'Check', 'Gemini API key');
    }
  }

  const checkNotionButton = button('Check', {
    class: 'settings-check',
    onClick: () => void checkDatabases(),
    attrs: {
      'data-role': 'check-notion',
      'aria-label': 'Check databases',
      'aria-describedby': 'check-notion-hint',
    },
  });

  /**
   * Checks every profile's database with the token in the Token field. A token problem
   * shows once, under the token; everything else on each profile's row.
   */
  async function checkDatabases(): Promise<void> {
    const token = texts.get('notionToken')!;
    busy(checkNotionButton, true, 'Check', 'databases');
    try {
      await settled();
      clearMessage(token, ['check']);
      const tokenValue = token.input.value.trim();
      if (!tokenValue) {
        showMessage(token, 'check', 'Paste a token first.', 'caution');
        return;
      }
      if (token.message === 'invalid' || !stored) return;
      const tokenUnsaved = tokenValue !== stored.notionToken;
      const profiles = stored.profiles;
      const results = new Map<string, VerifyResult | null>(
        await Promise.all(
          profiles.map(async (p): Promise<[string, VerifyResult | null]> => {
            const id = p.databaseId.trim();
            if (!id) return [p.id, null];
            try {
              return [p.id, await handlers.verifyNotion(tokenValue, id)];
            } catch (err) {
              return [p.id, { ok: false, problems: [errorText(err)] }];
            }
          }),
        ),
      );
      const messages = profileCheckMessages(results);
      checks.clear();
      if (messages.token) {
        const note = tokenUnsaved ? ' Checked the token in the field, which isn’t saved.' : '';
        showMessage(token, 'check', `${messages.token.text}${note}`, messages.token.tone);
      } else {
        for (const p of profiles) {
          const message = messages.profiles.get(p.id);
          if (!message || results.get(p.id) === null) continue;
          const note = tokenUnsaved ? ' Checked with the token in the field, which isn’t saved.' : '';
          checks.set(p.id, { databaseId: p.databaseId, message: { ...message, text: `${message.text}${note}` } });
        }
      }
      renderProfiles();
    } finally {
      busy(checkNotionButton, false, 'Check', 'databases');
    }
  }

  // ---- Profiles ------------------------------------------------------------------------------
  /** Each profile's last check, for the database it checked (a new link isn't checked). */
  const checks = new Map<string, { databaseId: string; message: CheckMessage }>();
  const profileRows = new Map<string, HTMLButtonElement>();

  const addProfileMsg = h('p', { class: 'field-msg', id: 'add-profile-msg', role: 'status' });
  const addProfileButton = button('Add profile', {
    kind: 'link',
    onClick: () => void addProfile(),
    attrs: { 'data-key': 'add-profile', 'aria-describedby': 'add-profile-msg' },
  });
  const addProfileRow = h('div', { class: 'profile-add' }, addProfileButton, addProfileMsg);

  async function addProfile(): Promise<void> {
    if (!stored) return;
    const id = crypto.randomUUID();
    setDisabled(addProfileButton, true);
    try {
      // Added to the profiles stored when the write runs, not the ones shown now.
      await write((current) => ({ profiles: [...current.profiles, newProfile(current.profiles, id)] }));
      renderMessage(addProfileMsg, null);
      renderProfiles();
      afterSave();
      handlers.openProfile(id);
    } catch (err) {
      renderMessage(addProfileMsg, `Couldn’t add a profile: ${errorText(err)}`);
    } finally {
      setDisabled(addProfileButton, false);
    }
  }

  /** The line under a profile's name: its database's state. */
  function databaseLine(profile: Profile): { tone: MessageTone | null; text: string } {
    if (!profile.databaseId.trim()) return { tone: 'caution', text: 'No database yet' };
    const check = checks.get(profile.id);
    if (check && check.databaseId === profile.databaseId) return check.message;
    return { tone: null, text: 'Not checked' };
  }

  function profileRow(profile: Profile): HTMLButtonElement {
    let row = profileRows.get(profile.id);
    if (!row) {
      const id = profile.id;
      row = h('button', { type: 'button', class: 'profile-row', 'data-key': `profile-${id}` });
      row.addEventListener('click', () => handlers.openProfile(id));
      profileRows.set(id, row);
    }
    const line = databaseLine(profile);
    const isDefault = stored !== null && defaultProfile(stored).id === profile.id;
    row.replaceChildren(
      h(
        'span',
        { class: 'profile-row-text' },
        h(
          'span',
          { class: 'profile-row-head' },
          h('span', { class: 'profile-row-name' }, profile.name),
          isDefault ? h('span', { class: 'profile-row-tag' }, 'Default') : null,
        ),
        h(
          'span',
          { class: 'profile-row-db', 'data-tone': line.tone ?? 'none' },
          line.tone ? svg(GLYPH[line.tone], { class: `tone-${line.tone}` }) : null,
          h('span', null, line.text),
        ),
      ),
      svg('chevron', { class: 'profile-row-chevron' }),
    );
    return row;
  }

  function renderProfiles(): void {
    if (!stored) return;
    const ids = new Set(stored.profiles.map((p) => p.id));
    for (const id of [...profileRows.keys()]) {
      if (ids.has(id)) continue;
      profileRows.delete(id);
      checks.delete(id);
    }
    const rows: HTMLElement[] = [...stored.profiles.map(profileRow), addProfileRow, checkDatabasesRow];
    for (const row of rows) row.classList.add('group-row');
    const children = [...profilesGroup.children];
    // Only rebuilt when rows come, go or move, so a focused row keeps focus.
    if (children.length !== rows.length || children.some((c, i) => c !== rows[i])) profilesGroup.replaceChildren(...rows);
  }

  // ---- Setup checklist -----------------------------------------------------------------------
  let setup: {
    el: HTMLElement;
    glyph: SVGSVGElement;
    title: HTMLElement;
    list: HTMLUListElement;
    status: HTMLElement;
    complete: boolean;
  } | null = null;

  function renderSetup(): void {
    if (!stored) return;
    const items = setupChecklist(stored);
    const complete = setupComplete(items);
    // Shown while meetings can't be saved; once shown it stays (turning into a
    // confirmation) so nothing below it moves while someone is filling in fields.
    if (!setup) {
      if (complete) return;
      const title = h('h2', { class: 'setup-title', id: 'setup-title' });
      const list = h('ul', { class: 'setup-list', role: 'list' });
      const status = h('p', { class: 'visually-hidden', role: 'status' });
      const glyph = svg('caution', { class: 'setup-glyph' });
      const el = h(
        'section',
        { class: 'setup', 'data-role': 'setup', 'aria-labelledby': 'setup-title' },
        glyph,
        title,
        list,
        status,
      );
      lede.after(el);
      setup = { el, glyph, title, list, status, complete };
    }
    const wasComplete = setup.complete;
    setup.complete = complete;
    setup.el.dataset.state = complete ? 'complete' : 'incomplete';
    const glyph = svg(complete ? 'done' : 'caution', { class: `setup-glyph tone-${complete ? 'done' : 'caution'}` });
    setup.glyph.replaceWith(glyph);
    setup.glyph = glyph;
    setup.title.textContent = complete ? 'Meetings will be saved to Notion' : 'Meetings can’t be saved to Notion yet';
    setup.list.replaceChildren(
      ...items.map((item) => {
        const state = item.done ? 'done' : item.optional ? 'neutral' : 'caution';
        const spoken = item.done ? 'done' : item.optional ? 'not set' : 'missing';
        return h(
          'li',
          { class: 'setup-item', 'data-item': item.key, 'data-done': String(item.done) },
          svg(state, { class: `tone-${state}` }),
          button([item.label, visuallyHidden(`, ${spoken}`)], {
            kind: 'link',
            onClick: () => {
              // The default profile's database is in its editor.
              if (item.key === 'profiles') handlers.openProfile(defaultProfile(stored!).id, 'databaseId');
              else focusField(item.key);
            },
          }),
          item.optional ? h('span', { class: 'setup-optional' }, 'optional') : null,
        );
      }),
    );
    if (complete && !wasComplete) setup.status.textContent = 'Setup done. Meetings will be saved to Notion.';
    else if (!complete) setup.status.textContent = '';
  }

  /** The control a setting's name points at, for the checklist and options.html#<name>. */
  function controlFor(name: string): HTMLElement | null {
    if (texts.has(name as TextName)) return texts.get(name as TextName)!.input;
    if (switches.has(name as SwitchName)) return switches.get(name as SwitchName)!;
    // The default profile's: its database is the one the popup and Meetings ask for.
    if (name === 'profiles') return stored ? (profileRows.get(defaultProfile(stored).id) ?? null) : null;
    if (name.startsWith('profile-')) return profileRows.get(name.slice('profile-'.length)) ?? null;
    return null;
  }

  function focusField(name: string): boolean {
    const control = controlFor(name);
    if (!control) return false;
    control.scrollIntoView({ block: 'center' });
    control.focus({ preventScroll: true });
    return true;
  }

  function afterSave(): void {
    renderSetup();
  }

  // ---- Page ----------------------------------------------------------------------------------
  const checkDatabasesRow = h(
    'div',
    { class: 'settings-action' },
    h(
      'div',
      { class: 'settings-action-text' },
      h('p', { class: 'field-label' }, 'Check databases'),
      h('p', { class: 'hint', id: 'check-notion-hint' }, 'Checks access and the columns Minute Book writes.'),
    ),
    checkNotionButton,
  );
  const profilesSection = section({ title: 'Profiles', id: 'settings-profiles', rows: [] });
  const profilesGroup = profilesSection.querySelector<HTMLElement>('.group')!;

  const lede = h('p', { class: 'settings-lede', 'data-role': 'lede' }, 'Changes are saved as you make them.');

  const notionToken = secretInput({ id: 'notionToken', name: 'notionToken', placeholder: 'Not set' });
  const gemini = secretInput({ id: 'geminiApiKey', name: 'geminiApiKey', placeholder: 'Not set' }, [checkGeminiButton]);
  // Show (and Check) stay together when the row wraps under large text.
  for (const { row, input } of [notionToken, gemini]) {
    row.classList.add('settings-secret');
    row.append(h('div', { class: 'settings-secret-buttons' }, ...[...row.children].filter((c) => c !== input)));
  }
  const days = textInput({
    id: 'retentionDays',
    name: 'retentionDays',
    type: 'number',
    inputmode: 'numeric',
    min: 0,
    max: 365,
    step: 1,
    class: 'settings-days',
  });
  const daysUnit = h('span', { class: 'settings-days-unit', id: 'retentionDays-unit' }, 'days after saving to Notion');

  const share = createShareView({
    current: () => stored,
    apply: applyImport,
    download: (fileName, text) => handlers.share.download(fileName, text),
    imported: () => void checkDatabases(),
  });

  const groups = [
    section({
      title: 'You',
      id: 'settings-you',
      rows: [
        textField('displayName', 'Name', textInput({ id: 'displayName', name: 'displayName', autocomplete: 'name' }), {
          hint: 'Shown as “Recorded by” in Notion, and used instead of “You” in transcripts.',
        }),
      ],
    }),
    section({
      title: 'Notion',
      id: 'settings-notion',
      rows: [
        textField('notionToken', 'Token', notionToken.input, {
          row: notionToken.row,
          spoken: 'Notion token',
          hint: [
            'A personal access token from ',
            link('https://www.notion.so/developers/tokens', 'notion.so/developers/tokens'),
            ', or an integration secret shared with every profile’s database.',
          ],
        }),
      ],
    }),
    profilesSection,
    section({
      title: 'Transcription',
      id: 'settings-transcription',
      rows: [
        textField('geminiApiKey', 'Gemini API key', gemini.input, {
          row: gemini.row,
          hint: [
            'Create one at ',
            link('https://aistudio.google.com/apikey', 'aistudio.google.com/apikey'),
            '. Without a key, transcripts come from Meet’s captions only.',
          ],
        }),
        textField(
          'customVocabulary',
          'Vocabulary',
          h('textarea', { class: 'input', id: 'customVocabulary', name: 'customVocabulary', rows: 4, spellcheck: 'false' }),
          {
            hint: [
              'One term per line: names, products and jargon to spell right. Speakers’ names are added automatically. ',
              count,
            ],
          },
        ),
        textField(
          'languageCodes',
          'Languages',
          textInput({ id: 'languageCodes', name: 'languageCodes', placeholder: 'Automatic' }),
          {
            hint: 'Codes like en-US or fr-FR. Leave empty to detect languages automatically — best for calls that switch between English and French.',
          },
        ),
      ],
    }),
    section({
      title: 'Recording',
      id: 'settings-recording',
      rows: [
        switchField(
          'includeMic',
          'Include your microphone',
          'Meet doesn’t play your own voice back, so without the mic only the others are recorded.',
          micLine,
        ),
        switchField(
          'autoTranscribe',
          'Transcribe automatically',
          'Each meeting is transcribed and saved to Notion when the call ends.',
        ),
        textField('retentionDays', 'Keep audio', days, {
          row: [days, daysUnit],
          hint: '0 deletes it at the next cleanup. Transcripts stay in Notion.',
        }),
      ],
    }),
    share.element,
  ];
  for (const group of groups) group.querySelector('.group')?.classList.add('roomy');
  days.setAttribute('aria-describedby', `retentionDays-unit ${days.getAttribute('aria-describedby') ?? ''}`.trim());

  const privacy = h(
    'p',
    { class: 'settings-privacy', 'data-role': 'privacy' },
    'Recordings and keys stay in this browser. Audio and transcripts go to Gemini to be transcribed and summarized, ' +
      'and each meeting is saved as a page in the Notion database you choose. There is no Minute Book server.',
  );

  root.replaceChildren(lede, ...groups, privacy);
  renderCount();

  /** Shows the stored settings: see OptionsView.load. */
  function load(settings: Settings): void {
    const previous = stored;
    stored = settings;
    for (const f of texts.values()) {
      const value = formValue(settings, f.name);
      if (f.input.value === value) continue;
      // Keep an edit in progress; everything else follows storage.
      if (previous && f.input.value !== formValue(previous, f.name)) continue;
      f.input.value = value;
      clearMessage(f, ['invalid', 'check']);
      if (f.name === 'languageCodes') {
        const result = parseField('languageCodes', f.input.value);
        showNote(f, result.ok ? result.note : undefined);
      }
    }
    for (const [name, input] of switches) {
      if (input.getAttribute('aria-disabled') !== 'true') input.checked = settings[name];
    }
    renderProfiles();
    renderCount();
    renderMic();
    renderSetup();
    share.refresh();
  }

  return {
    load,
    setMic(next) {
      permission = next;
      renderMic();
    },
    focus: (name) => focusField(name),
    flush() {
      let unsaved = writing > 0;
      for (const f of texts.values()) {
        if (!isDirty(f)) continue;
        unsaved = true;
        void commit(f);
      }
      return unsaved;
    },
  };
}
