/**
 * Profile editor: the drill-in Settings opens for one profile (Task 12 mounts it). Same
 * apply-as-you-go rules as optionsView.ts: a field commits on blur, Enter (Ctrl/⌘+Enter in
 * a textarea) or is discarded on Esc; a successful save flashes "✓ Saved" beside the
 * label; an invalid value writes nothing and shows why under the field.
 *
 * Every write — a field, a structural section change, Use as default, Delete — goes
 * through one queue (write()), one at a time. A field's candidate is built twice: once
 * synchronously at commit time, only to show a validation error without waiting, and
 * once for real inside the queued closure, from whatever `profile` the queue has already
 * caught up to. That second build is what makes two quick commits (blur name, then blur
 * databaseId before the first save resolves) land on top of each other instead of one
 * overwriting the other with a stale snapshot.
 *
 * Structural changes to the sections list (add, move, format, remove) build the same way
 * and can't make the profile invalid, so there is nothing to check first.
 *
 * Pure DOM: no chrome.* here. The owner supplies handlers and calls load() with the
 * settings whenever storage changes, so the module renders in any DOM (tested with jsdom
 * via a real browser project, mounted for real by Task 12).
 */
import { ACTION_ITEMS_TITLE, newSection, PROFILE_LIMITS, profileProblems } from '../profiles';
import type { VerifyResult } from '../notion/verify';
import type { NoteSection, Profile, Settings } from '../types';
import {
  button,
  field,
  section,
  segmented,
  setDisabled,
  setFieldMessage,
  setSegmented,
  switchInput,
  textInput,
  visuallyHidden,
} from './controls';
import { h } from './dom';
import { svg } from './icons';
import { databaseCheckMessage, parseVocabulary } from './settingsForm';

export interface ProfileEditorHandlers {
  /** Stores `profile` in place of the one with its id; resolves to the stored settings. */
  save(profile: Profile): Promise<Settings>;
  /** Deletes the profile; resolves to the stored settings. */
  remove(profileId: string): Promise<Settings>;
  makeDefault(profileId: string): Promise<Settings>;
  /** Checks a database with the stored Notion token (notion/verify.ts verifyDatabase). */
  verifyDatabase(databaseId: string): Promise<VerifyResult>;
  /** Back to Settings. */
  back(): void;
}

export type ProfileField = 'name' | 'databaseId' | 'prompt' | 'vocabulary';

export interface ProfileEditorView {
  readonly element: HTMLElement;
  /** Shows the profile from these settings; a field being edited keeps its edit. */
  load(settings: Settings): void;
  focus(field: ProfileField): void;
  /** Commits edits still in their fields; true while anything is unsaved. */
  flush(): boolean;
}

const quoted = (s: string) => `“${s}”`;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A field wired to commit-on-blur/Enter, Esc-restore and re-sync from the profile. */
interface EditableField {
  input: HTMLInputElement | HTMLTextAreaElement;
  shown: () => string;
  commit: () => Promise<void>;
  /** Updates the input from `shown()`, unless it holds an edit or a write for it is pending. */
  sync: () => void;
}

/** A profile candidate that passed profileProblems, or the problems that stopped it (none
 *  when the profile itself is gone). */
type SaveOutcome = { ok: true; profile: Profile } | { ok: false; problems: string[] };

export function createProfileEditorView(
  profileId: string,
  handlers: ProfileEditorHandlers,
  timing: Partial<{ savedMs: number; fadeMs: number }> = {},
): ProfileEditorView {
  const { savedMs = 2000, fadeMs = 300 } = timing;
  let settings: Settings | null = null;
  let profile: Profile | null = null;
  let writing = 0;
  let confirmingDelete = false;
  /** While Use as default is being written, so a reload can't flip the switch back. */
  let savingDefault = false;

  function currentProfile(s: Settings): Profile | null {
    return s.profiles.find((p) => p.id === profileId) ?? null;
  }

  // ---- Writes: one at a time, each built from the latest resolved profile ----------------
  let queue: Promise<unknown> = Promise.resolve();
  /** Runs `fn` once every earlier write has settled, so nothing is ever lost to a race. */
  function write<T>(fn: () => Promise<T>): Promise<T> {
    writing++;
    const run = queue.then(fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      writing--;
    });
  }

  /** Builds a candidate from the profile the queue has caught up to, and saves it if valid. */
  function writeProfile(build: (base: Profile) => Profile): Promise<SaveOutcome> {
    return write(async (): Promise<SaveOutcome> => {
      if (!profile) return { ok: false, problems: [] };
      const candidate = build(profile);
      const problems = profileProblems(candidate, settings!.profiles);
      if (problems.length) return { ok: false, problems };
      const next = await handlers.save(candidate);
      settings = next;
      profile = currentProfile(next);
      // Deleted meanwhile (another tab, or this editor's own Delete): nothing left to show.
      return profile ? { ok: true, profile } : { ok: false, problems: [] };
    });
  }

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

  // ---- Fields: name, database, prompt, vocabulary, and each section's title/instruction --
  const fields: EditableField[] = [];
  function unregisterField(f: EditableField): void {
    const i = fields.indexOf(f);
    if (i >= 0) fields.splice(i, 1);
  }

  function createField(o: {
    input: HTMLInputElement | HTMLTextAreaElement;
    fieldEl: HTMLElement;
    saved?: HTMLElement;
    label: string;
    shown: () => string;
    /** Applies this field's edit to `base` (the profile the write queue has caught up to). */
    change: (base: Profile, raw: string) => Profile;
    display: (p: Profile) => string;
  }): EditableField {
    /** The value a write is in flight for, so Esc and a reload don't show something stale. */
    let pendingRaw: string | null = null;
    /** The last value this field put in the input itself: null until the first sync. What
     *  the input shows besides this is an uncommitted edit, focused or not (a blur that's
     *  still validating, or — for a section row — one a structural save elsewhere raced
     *  past without touching), so sync() must leave it alone. */
    let lastSyncedValue: string | null = null;

    function commit(): Promise<void> {
      if (!profile) return Promise.resolve();
      const raw = o.input.value;
      // Enter, then blur: that value is already on its way.
      if (raw === pendingRaw) return Promise.resolve();
      const shownValue = o.shown();
      if (raw === shownValue) {
        lastSyncedValue = shownValue;
        setFieldMessage(o.fieldEl, null);
        return Promise.resolve();
      }
      // A quick, synchronous check against what's known right now: it can show an error
      // without waiting, but the queued write below re-checks against the real thing.
      const guess = o.change(profile, raw);
      const guessDisplay = o.display(guess);
      if (guessDisplay === shownValue) {
        // Only whitespace or order-preserving clean-up changed: show it, write nothing.
        o.input.value = shownValue;
        lastSyncedValue = shownValue;
        setFieldMessage(o.fieldEl, null);
        return Promise.resolve();
      }
      const guessProblems = profileProblems(guess, settings!.profiles);
      if (guessProblems.length) {
        setFieldMessage(o.fieldEl, guessProblems[0]!, 'caution');
        return Promise.resolve();
      }
      pendingRaw = raw;
      return writeProfile((base) => o.change(base, raw)).then(
        (result) => {
          pendingRaw = null;
          if (!result.ok) {
            if (result.problems[0]) setFieldMessage(o.fieldEl, result.problems[0], 'caution');
            else syncAll(); // the profile is gone: show that
            return;
          }
          const value = o.display(result.profile);
          if (o.input.value === raw) o.input.value = value;
          lastSyncedValue = value;
          setFieldMessage(o.fieldEl, null);
          if (o.saved) flashSaved(o.saved, o.label);
          syncAll();
        },
        (err: unknown) => {
          pendingRaw = null;
          setFieldMessage(o.fieldEl, `Couldn’t save: ${errorText(err)}`, 'caution');
        },
      );
    }

    function restore(): void {
      // Mid-flight, Esc can't cancel the write already under way: show what it's writing,
      // not the stale saved value, so the field still catches up once it resolves.
      const value = pendingRaw ?? o.shown();
      o.input.value = value;
      if (pendingRaw === null) lastSyncedValue = value;
      setFieldMessage(o.fieldEl, null);
    }

    function sync(): void {
      if (pendingRaw !== null) return;
      // An uncommitted edit (never blurred, so never even reached commit()) still shows
      // in the input without matching what we last put there: leave it be. A field that is
      // merely focused follows storage, or its blur would write the old value back.
      if (lastSyncedValue !== null && o.input.value !== lastSyncedValue) return;
      const value = o.shown();
      if (o.input.value !== value) o.input.value = value;
      lastSyncedValue = value;
    }

    o.input.addEventListener('focusout', () => void commit());
    o.input.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') {
        e.preventDefault();
        restore();
        return;
      }
      if (e.key !== 'Enter' || e.isComposing) return;
      if (o.input instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      void commit();
    });

    return { input: o.input, shown: o.shown, commit, sync };
  }

  function registerField(o: Parameters<typeof createField>[0]): EditableField {
    const f = createField(o);
    fields.push(f);
    return f;
  }

  // ---- Header: back, name -------------------------------------------------------------
  const heading = h('h1', { class: 'profile-editor-title' });
  const backBtn = button('‹ Settings', {
    kind: 'plain',
    onClick: () => handlers.back(),
    attrs: { 'data-key': 'back' },
  });
  const header = h('div', { class: 'profile-editor-header' }, backBtn, heading);

  // ---- Name -----------------------------------------------------------------------------
  const nameSaved = savedSlot('name');
  const nameInput = textInput({ id: 'name', name: 'name', 'data-key': 'name' });
  const nameFieldEl = field({ id: 'name', label: 'Name', control: nameInput, status: nameSaved });
  const nameField = registerField({
    input: nameInput,
    fieldEl: nameFieldEl,
    saved: nameSaved,
    label: 'Name',
    shown: () => profile!.name,
    change: (base, raw) => ({ ...base, name: raw.trim() }),
    display: (p) => p.name,
  });

  // ---- Notion database + Check ------------------------------------------------------------
  const dbSaved = savedSlot('databaseId');
  const dbInput = textInput({
    id: 'databaseId',
    name: 'databaseId',
    placeholder: 'Paste the database link',
    'data-key': 'databaseId',
  });
  const checkBtn = button('Check', {
    class: 'settings-check',
    attrs: { 'data-key': 'check', 'aria-label': 'Check the database' },
    onClick: () => void checkDatabase(),
  });
  const dbFieldEl = field({ id: 'databaseId', label: 'Notion database', control: [dbInput, checkBtn], status: dbSaved });
  const dbField = registerField({
    input: dbInput,
    fieldEl: dbFieldEl,
    saved: dbSaved,
    label: 'Notion database',
    shown: () => profile!.databaseId,
    change: (base, raw) => ({ ...base, databaseId: raw.trim() }),
    display: (p) => p.databaseId,
  });

  function busy(el: HTMLButtonElement, on: boolean): void {
    setDisabled(el, on);
    el.textContent = on ? 'Checking…' : 'Check';
  }
  async function checkDatabase(): Promise<void> {
    const value = dbInput.value.trim();
    if (!value) {
      setFieldMessage(dbFieldEl, 'Paste the database link first.', 'caution');
      return;
    }
    busy(checkBtn, true);
    try {
      const result = await handlers.verifyDatabase(value);
      const message = databaseCheckMessage(result);
      setFieldMessage(dbFieldEl, message.text, message.tone);
    } catch (err) {
      setFieldMessage(dbFieldEl, `Couldn’t check: ${errorText(err)}`, 'caution');
    } finally {
      busy(checkBtn, false);
    }
  }

  // ---- Use as default ---------------------------------------------------------------------
  const defaultSaved = savedSlot('default');
  const defaultMsg = h('p', { class: 'field-msg', id: 'default-msg', role: 'status' });
  const defaultInput = switchInput({
    id: 'default',
    checked: false,
    describedBy: 'default-hint default-msg',
    attrs: { 'data-key': 'default' },
    onChange: (checked) => void commitDefault(checked),
  });
  const defaultRow = h(
    'div',
    { class: 'switch-row' },
    h(
      'div',
      { class: 'switch-row-text' },
      h('div', { class: 'field-head' }, h('label', { class: 'field-label', for: 'default' }, 'Use as default'), defaultSaved),
      h('p', { class: 'hint', id: 'default-hint' }, 'Preselected in the popup and used by the keyboard shortcut.'),
      defaultMsg,
    ),
    defaultInput,
  );
  async function commitDefault(checked: boolean): Promise<void> {
    if (!checked || !profile || profile.id === settings?.defaultProfileId) return;
    const id = profile.id;
    setDisabled(defaultInput, true);
    savingDefault = true;
    // The default can't be deleted: an open confirm goes now, not once the write lands.
    confirmingDelete = false;
    renderDelete();
    try {
      await write(async () => {
        const next = await handlers.makeDefault(id);
        settings = next;
        profile = currentProfile(next);
        return next;
      });
      savingDefault = false;
      defaultMsg.textContent = '';
      flashSaved(defaultSaved, 'Use as default');
      syncAll();
    } catch (err) {
      savingDefault = false;
      defaultInput.checked = false;
      defaultMsg.textContent = `Couldn’t save: ${errorText(err)}`;
      setDisabled(defaultInput, false);
    }
  }

  // ---- Prompt ------------------------------------------------------------------------------
  const promptSaved = savedSlot('prompt');
  const promptInput = h('textarea', {
    class: 'input',
    id: 'prompt',
    name: 'prompt',
    rows: 4,
    spellcheck: 'false',
    'data-key': 'prompt',
  });
  const promptFieldEl = field({
    id: 'prompt',
    label: 'Prompt',
    control: promptInput,
    status: promptSaved,
    hint: 'What these meetings are, and how to write their notes.',
  });
  const promptField = registerField({
    input: promptInput,
    fieldEl: promptFieldEl,
    saved: promptSaved,
    label: 'Prompt',
    shown: () => profile!.prompt,
    change: (base, raw) => ({ ...base, prompt: raw.trim() }),
    display: (p) => p.prompt,
  });

  // ---- Sections ------------------------------------------------------------------------------
  interface SectionRow {
    el: HTMLElement;
    titleField: EditableField;
    instrField: EditableField;
    formatEl: HTMLElement;
    upBtn: HTMLButtonElement;
    downBtn: HTMLButtonElement;
  }
  const sectionRows = new Map<string, SectionRow>();
  const sectionsList = h('div', { class: 'profile-sections' });

  function sectionOf(id: string): NoteSection | undefined {
    return profile?.sections.find((s) => s.id === id);
  }

  function buildSection(base: Profile, id: string, patch: Partial<NoteSection>): Profile {
    return { ...base, sections: base.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  }

  /** Add, move, format and remove all build from the queue's latest profile, then re-render. */
  function saveStructural(build: (base: Profile) => Profile): void {
    void writeProfile(build).then(
      () => syncAll(),
      () => syncAll(),
    );
  }

  function moveSection(id: string, dir: -1 | 1): void {
    saveStructural((base) => {
      const idx = base.sections.findIndex((s) => s.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= base.sections.length) return base;
      const sections = [...base.sections];
      const tmp = sections[idx]!;
      sections[idx] = sections[swapIdx]!;
      sections[swapIdx] = tmp;
      return { ...base, sections };
    });
  }

  function removeSection(id: string): void {
    saveStructural((base) => ({ ...base, sections: base.sections.filter((s) => s.id !== id) }));
  }

  function setSectionFormat(id: string, format: NoteSection['format']): void {
    saveStructural((base) => buildSection(base, id, { format }));
  }

  function addSection(): void {
    saveStructural((base) => ({ ...base, sections: [...base.sections, newSection(base.sections)] }));
  }

  function unregisterRow(row: SectionRow): void {
    unregisterField(row.titleField);
    unregisterField(row.instrField);
  }

  function buildSectionRow(s: NoteSection): SectionRow {
    const id = s.id;
    const titleKey = `section-${id}-title`;
    const formatKey = `section-${id}-format`;
    const instrKey = `section-${id}-instruction`;
    const upKey = `section-${id}-up`;
    const downKey = `section-${id}-down`;
    const removeKey = `section-${id}-remove`;

    const titleInput = textInput({ id: titleKey, 'data-key': titleKey });
    const formatEl = segmented<NoteSection['format']>({
      label: 'Format',
      options: [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'bullets', label: 'Bullets' },
      ],
      value: s.format,
      onSelect: (value) => setSectionFormat(id, value),
      attrs: { 'data-key': formatKey },
    });
    const titleFieldEl = field({ id: titleKey, label: 'Title', control: [titleInput, formatEl] });

    const instrInput = h('textarea', {
      class: 'input',
      id: instrKey,
      rows: 2,
      spellcheck: 'false',
      'data-key': instrKey,
    });
    const instrFieldEl = field({ id: instrKey, label: 'Instruction', control: instrInput });

    const upBtn = button('Move up', { kind: 'plain', attrs: { 'data-key': upKey }, onClick: () => moveSection(id, -1) });
    const downBtn = button('Move down', { kind: 'plain', attrs: { 'data-key': downKey }, onClick: () => moveSection(id, 1) });
    const removeBtn = button('Remove', {
      kind: 'plain',
      attrs: { 'data-key': removeKey },
      onClick: () => removeSection(id),
    });
    const actions = h('div', { class: 'profile-section-actions' }, upBtn, downBtn, removeBtn);

    const el = h('div', { class: 'profile-section' }, titleFieldEl, instrFieldEl, actions);

    const titleField = registerField({
      input: titleInput,
      fieldEl: titleFieldEl,
      label: 'Title',
      shown: () => sectionOf(id)?.title ?? '',
      change: (base, raw) => buildSection(base, id, { title: raw.trim() }),
      display: (p) => p.sections.find((x) => x.id === id)?.title ?? '',
    });
    const instrField = registerField({
      input: instrInput,
      fieldEl: instrFieldEl,
      label: 'Instruction',
      shown: () => sectionOf(id)?.instruction ?? '',
      change: (base, raw) => buildSection(base, id, { instruction: raw.trim() }),
      display: (p) => p.sections.find((x) => x.id === id)?.instruction ?? '',
    });

    return { el, titleField, instrField, formatEl, upBtn, downBtn };
  }

  const addSectionBtn = button('Add section', { attrs: { 'data-key': 'add-section' }, onClick: () => addSection() });
  const addSectionNote = h('p', { class: 'hint' }, `Up to ${PROFILE_LIMITS.sections} sections.`);
  const addSectionRow = h('div', { class: 'settings-action' }, addSectionBtn, addSectionNote);
  const actionItemsHint = h('p', { class: 'hint' }, `“${ACTION_ITEMS_TITLE}” is always added after the sections.`);

  /**
   * Reuses each row whose section id still exists (patching only what changed, and never
   * touching an edited or mid-write field), creates rows for new ids, drops rows for gone
   * ids, then reorders the surviving nodes with the fewest possible moves. A row that had
   * focus keeps it even if reordering it briefly detaches it from the document.
   */
  function renderSections(): void {
    const activeBefore = document.activeElement;
    if (!profile) {
      for (const row of sectionRows.values()) unregisterRow(row);
      sectionRows.clear();
      sectionsList.replaceChildren();
      setDisabled(addSectionBtn, false);
      return;
    }
    const ids = new Set(profile.sections.map((s) => s.id));
    for (const [id, row] of [...sectionRows]) {
      if (ids.has(id)) continue;
      unregisterRow(row);
      row.el.remove();
      sectionRows.delete(id);
    }
    const total = profile.sections.length;
    profile.sections.forEach((s, i) => {
      let row = sectionRows.get(s.id);
      if (!row) {
        row = buildSectionRow(s);
        sectionRows.set(s.id, row);
      }
      row.titleField.sync();
      row.instrField.sync();
      setSegmented(row.formatEl, s.format);
      setDisabled(row.upBtn, i === 0);
      setDisabled(row.downBtn, i === total - 1);
    });
    let node = sectionsList.firstChild;
    for (const s of profile.sections) {
      const row = sectionRows.get(s.id)!;
      if (node !== row.el) sectionsList.insertBefore(row.el, node);
      node = row.el.nextSibling;
    }
    if (activeBefore instanceof HTMLElement && activeBefore.isConnected && document.activeElement !== activeBefore) {
      activeBefore.focus({ preventScroll: true });
    }
    setDisabled(addSectionBtn, total >= PROFILE_LIMITS.sections);
  }

  // ---- Vocabulary ----------------------------------------------------------------------------
  const vocabSaved = savedSlot('vocabulary');
  const vocabInput = h('textarea', {
    class: 'input',
    id: 'vocabulary',
    name: 'vocabulary',
    rows: 4,
    spellcheck: 'false',
    'data-key': 'vocabulary',
  });
  const vocabFieldEl = field({
    id: 'vocabulary',
    label: 'Vocabulary',
    control: vocabInput,
    status: vocabSaved,
    hint: 'Added to the vocabulary in Settings for these meetings only.',
  });
  const vocabField = registerField({
    input: vocabInput,
    fieldEl: vocabFieldEl,
    saved: vocabSaved,
    label: 'Vocabulary',
    shown: () => profile!.vocabulary.join('\n'),
    change: (base, raw) => ({ ...base, vocabulary: parseVocabulary(raw) }),
    display: (p) => p.vocabulary.join('\n'),
  });

  // ---- Delete ------------------------------------------------------------------------------
  const deleteMsg = h('p', { class: 'field-msg', role: 'status' });
  const deleteBtn = button('Delete profile…', {
    kind: 'link',
    class: 'profile-delete-link',
    attrs: { 'data-key': 'delete' },
    onClick: () => {
      confirmingDelete = true;
      renderDelete();
    },
  });
  const deleteHint = h('p', { class: 'hint' }, 'Make another profile the default first.');
  const confirmText = h('p', null);
  const cancelBtn = button('Cancel', {
    kind: 'plain',
    attrs: { 'data-key': 'delete-cancel' },
    onClick: () => {
      confirmingDelete = false;
      renderDelete();
    },
  });
  const confirmBtn = button('Delete', {
    kind: 'plain',
    attrs: { 'data-key': 'delete-confirm' },
    onClick: () => void confirmDelete(),
  });
  const confirmActions = h('div', { class: 'profile-delete-actions' }, cancelBtn, confirmBtn);
  const deleteArea = h('div', { class: 'profile-delete' });

  /** Patches the delete row in place; its nodes change only when the confirm opens or closes. */
  function renderDelete(): void {
    if (!profile || !settings) {
      confirmingDelete = false;
      deleteArea.replaceChildren();
      return;
    }
    const isDefault = profile.id === settings.defaultProfileId;
    // The default can't be deleted, even from a confirm opened before it became the default.
    if (isDefault) confirmingDelete = false;
    setDisabled(deleteBtn, isDefault);
    confirmText.textContent = `Delete ${quoted(profile.name)}? Meetings recorded with it will ask for another profile.`;
    const nodes = confirmingDelete
      ? [confirmText, confirmActions, deleteMsg]
      : isDefault
        ? [deleteBtn, deleteHint, deleteMsg]
        : [deleteBtn, deleteMsg];
    const children = [...deleteArea.children];
    if (children.length === nodes.length && children.every((c, i) => c === nodes[i])) return;
    const hadFocus = deleteArea.contains(document.activeElement);
    deleteArea.replaceChildren(...nodes);
    // Opening or closing the confirm removes the focused button: focus its counterpart.
    if (hadFocus && !deleteArea.contains(document.activeElement)) {
      (confirmingDelete ? cancelBtn : deleteBtn).focus({ preventScroll: true });
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!profile) return;
    const id = profile.id;
    try {
      const next = await write(async () => {
        // Made the default by a write queued before this one: not deletable any more.
        if (settings?.defaultProfileId === id) return null;
        return handlers.remove(id);
      });
      if (!next) {
        confirmingDelete = false;
        renderDelete();
        return;
      }
      settings = next;
      profile = currentProfile(next);
      confirmingDelete = false;
      handlers.back();
    } catch (err) {
      deleteMsg.textContent = `Couldn’t delete: ${errorText(err)}`;
    }
  }

  // ---- Layout ----------------------------------------------------------------------------
  const profileSection = section({
    title: 'Profile',
    id: 'profile-editor-profile',
    rows: [nameFieldEl, dbFieldEl, defaultRow],
  });
  const notesSection = section({
    title: 'Notes',
    id: 'profile-editor-notes',
    rows: [promptFieldEl, sectionsList, addSectionRow, actionItemsHint],
  });
  const transcriptionSection = section({
    title: 'Transcription',
    id: 'profile-editor-transcription',
    rows: [vocabFieldEl],
  });
  const deletedMsg = h('p', null, 'This profile was deleted.');
  const body = h('div', { class: 'profile-editor-body' });
  const root = h('div', { class: 'profile-editor' }, header, body);

  // ---- Sync -------------------------------------------------------------------------------
  function syncAll(): void {
    if (!profile || !settings) {
      heading.textContent = '';
      renderDelete();
      if (body.firstChild !== deletedMsg) body.replaceChildren(deletedMsg);
      return;
    }
    heading.textContent = profile.name;
    nameField.sync();
    dbField.sync();
    promptField.sync();
    vocabField.sync();
    const isDefault = profile.id === settings.defaultProfileId;
    if (!savingDefault) {
      defaultInput.checked = isDefault;
      setDisabled(defaultInput, isDefault);
    }
    renderSections();
    renderDelete();
    // Only when switching from "deleted": re-inserting the same nodes would detach them, and
    // Chromium would blur whichever field has focus.
    if (body.firstChild !== profileSection) {
      body.replaceChildren(profileSection, notesSection, transcriptionSection, deleteArea);
    }
  }

  return {
    element: root,
    load(next) {
      settings = next;
      profile = currentProfile(next);
      syncAll();
    },
    focus(name) {
      const input = { name: nameInput, databaseId: dbInput, prompt: promptInput, vocabulary: vocabInput }[name];
      input.scrollIntoView({ block: 'center' });
      input.focus({ preventScroll: true });
    },
    flush() {
      let unsaved = writing > 0;
      if (!profile) return unsaved;
      for (const f of fields) {
        if (f.input.value === f.shown()) continue;
        unsaved = true;
        void f.commit();
      }
      return unsaved;
    },
  };
}
