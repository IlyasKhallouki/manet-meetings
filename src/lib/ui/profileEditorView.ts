/**
 * Profile editor: the drill-in Settings opens for one profile (Task 12 mounts it). Same
 * apply-as-you-go rules as optionsView.ts: a field commits on blur, Enter (Ctrl/⌘+Enter in
 * a textarea) or is discarded on Esc; a successful save flashes "✓ Saved" beside the
 * label; an invalid value writes nothing and shows why under the field.
 *
 * Structural changes to the sections list (add, move, format, remove) save at once: they
 * can't make the profile invalid, so there is nothing to check first.
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
import { h, mount } from './dom';
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

interface EditableField {
  input: HTMLInputElement | HTMLTextAreaElement;
  shown: () => string;
  commit: () => Promise<void>;
  restore: () => void;
}

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

  function currentProfile(s: Settings): Profile | null {
    return s.profiles.find((p) => p.id === profileId) ?? null;
  }

  // ---- Writes: one at a time -------------------------------------------------------------
  let queue: Promise<unknown> = Promise.resolve();
  function write(candidate: Profile): Promise<Settings> {
    writing++;
    const run = queue.then(() => handlers.save(candidate));
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(
      (next) => {
        writing--;
        settings = next;
        profile = currentProfile(next);
        return next;
      },
      (err: unknown) => {
        writing--;
        throw err;
      },
    );
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

  const focused = (el: Element) => document.activeElement === el;
  function syncValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    if (!focused(input)) input.value = value;
  }

  // ---- Generic field commit (name, database, prompt, vocabulary, section title/instr) ----
  function commitValue(o: {
    input: HTMLInputElement | HTMLTextAreaElement;
    fieldEl: HTMLElement;
    saved?: HTMLElement;
    label: string;
    shown: () => string;
    toCandidate: (raw: string) => Profile;
    display: (p: Profile) => string;
  }): Promise<void> {
    if (!profile) return Promise.resolve();
    const raw = o.input.value;
    const shownValue = o.shown();
    if (raw === shownValue) {
      setFieldMessage(o.fieldEl, null);
      return Promise.resolve();
    }
    const candidate = o.toCandidate(raw);
    const candidateDisplay = o.display(candidate);
    if (candidateDisplay === shownValue) {
      // Only whitespace or order-preserving clean-up changed: show it, write nothing.
      o.input.value = shownValue;
      setFieldMessage(o.fieldEl, null);
      return Promise.resolve();
    }
    const problems = profileProblems(candidate, settings!.profiles);
    if (problems.length) {
      setFieldMessage(o.fieldEl, problems[0]!, 'caution');
      return Promise.resolve();
    }
    return write(candidate).then(
      (next) => {
        const updated = currentProfile(next);
        if (updated && o.input.value === raw) o.input.value = o.display(updated);
        setFieldMessage(o.fieldEl, null);
        if (o.saved) flashSaved(o.saved, o.label);
        syncAll();
      },
      (err: unknown) => {
        setFieldMessage(o.fieldEl, `Couldn’t save: ${errorText(err)}`, 'caution');
      },
    );
  }

  const fields: EditableField[] = [];

  function wireField(
    input: HTMLInputElement | HTMLTextAreaElement,
    commit: () => Promise<void>,
    shown: () => string,
  ): void {
    const restore = () => {
      input.value = shown();
      const fieldEl = input.closest('.field');
      if (fieldEl) setFieldMessage(fieldEl, null);
    };
    input.addEventListener('focusout', () => void commit());
    input.addEventListener('keydown', (event) => {
      const e = event as KeyboardEvent;
      if (e.key === 'Escape') {
        e.preventDefault();
        restore();
        return;
      }
      if (e.key !== 'Enter' || e.isComposing) return;
      if (input instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      void commit();
    });
    fields.push({ input, shown, commit, restore });
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
  function commitName(): Promise<void> {
    return commitValue({
      input: nameInput,
      fieldEl: nameFieldEl,
      saved: nameSaved,
      label: 'Name',
      shown: () => profile!.name,
      toCandidate: (raw) => ({ ...profile!, name: raw.trim() }),
      display: (p) => p.name,
    });
  }
  wireField(nameInput, commitName, () => profile!.name);

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
  function commitDatabaseId(): Promise<void> {
    return commitValue({
      input: dbInput,
      fieldEl: dbFieldEl,
      saved: dbSaved,
      label: 'Notion database',
      shown: () => profile!.databaseId,
      toCandidate: (raw) => ({ ...profile!, databaseId: raw.trim() }),
      display: (p) => p.databaseId,
    });
  }
  wireField(dbInput, commitDatabaseId, () => profile!.databaseId);

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
    if (!checked || !profile || !settings || profile.id === settings.defaultProfileId) return;
    setDisabled(defaultInput, true);
    writing++;
    try {
      const next = await handlers.makeDefault(profile.id);
      writing--;
      settings = next;
      profile = currentProfile(next);
      defaultMsg.textContent = '';
      flashSaved(defaultSaved, 'Use as default');
      syncAll();
    } catch (err) {
      writing--;
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
  function commitPrompt(): Promise<void> {
    return commitValue({
      input: promptInput,
      fieldEl: promptFieldEl,
      saved: promptSaved,
      label: 'Prompt',
      shown: () => profile!.prompt,
      toCandidate: (raw) => ({ ...profile!, prompt: raw.trim() }),
      display: (p) => p.prompt,
    });
  }
  wireField(promptInput, commitPrompt, () => profile!.prompt);

  // ---- Sections ------------------------------------------------------------------------------
  interface SectionRow {
    el: HTMLElement;
    titleInput: HTMLInputElement;
    titleFieldEl: HTMLElement;
    instrInput: HTMLTextAreaElement;
    instrFieldEl: HTMLElement;
    formatEl: HTMLElement;
    upBtn: HTMLButtonElement;
    downBtn: HTMLButtonElement;
  }
  const sectionRows = new Map<string, SectionRow>();
  const sectionsList = h('div', { class: 'profile-sections' });
  let lastSectionsKey: string | null = null;

  function sectionOf(id: string): NoteSection | undefined {
    return profile?.sections.find((s) => s.id === id);
  }

  function buildSection(id: string, patch: Partial<NoteSection>): Profile {
    return { ...profile!, sections: profile!.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
  }

  function saveStructural(candidate: Profile): Promise<void> {
    return write(candidate).then(
      () => syncAll(),
      () => syncAll(),
    );
  }

  function moveSection(id: string, dir: -1 | 1): void {
    if (!profile) return;
    const idx = profile.sections.findIndex((s) => s.id === id);
    const swapIdx = idx + dir;
    if (idx < 0 || swapIdx < 0 || swapIdx >= profile.sections.length) return;
    const sections = [...profile.sections];
    const tmp = sections[idx]!;
    sections[idx] = sections[swapIdx]!;
    sections[swapIdx] = tmp;
    void saveStructural({ ...profile, sections });
  }

  function removeSection(id: string): void {
    if (!profile) return;
    void saveStructural({ ...profile, sections: profile.sections.filter((s) => s.id !== id) });
  }

  function setSectionFormat(id: string, format: NoteSection['format']): void {
    if (!profile) return;
    void saveStructural(buildSection(id, { format }));
  }

  function buildSectionRow(s: NoteSection): SectionRow {
    const titleKey = `section-${s.id}-title`;
    const formatKey = `section-${s.id}-format`;
    const instrKey = `section-${s.id}-instruction`;
    const upKey = `section-${s.id}-up`;
    const downKey = `section-${s.id}-down`;
    const removeKey = `section-${s.id}-remove`;

    const titleInput = textInput({ id: titleKey, 'data-key': titleKey });
    const formatEl = segmented<NoteSection['format']>({
      label: 'Format',
      options: [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'bullets', label: 'Bullets' },
      ],
      value: s.format,
      onSelect: (value) => setSectionFormat(s.id, value),
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

    const upBtn = button('Move up', { kind: 'plain', attrs: { 'data-key': upKey }, onClick: () => moveSection(s.id, -1) });
    const downBtn = button('Move down', { kind: 'plain', attrs: { 'data-key': downKey }, onClick: () => moveSection(s.id, 1) });
    const removeBtn = button('Remove', {
      kind: 'plain',
      attrs: { 'data-key': removeKey },
      onClick: () => removeSection(s.id),
    });
    const actions = h('div', { class: 'profile-section-actions' }, upBtn, downBtn, removeBtn);

    const el = h('div', { class: 'profile-section' }, titleFieldEl, instrFieldEl, actions);

    function commitTitle(): Promise<void> {
      return commitValue({
        input: titleInput,
        fieldEl: titleFieldEl,
        label: 'Title',
        shown: () => sectionOf(s.id)?.title ?? '',
        toCandidate: (raw) => buildSection(s.id, { title: raw.trim() }),
        display: (p) => p.sections.find((x) => x.id === s.id)?.title ?? '',
      });
    }
    function commitInstruction(): Promise<void> {
      return commitValue({
        input: instrInput,
        fieldEl: instrFieldEl,
        label: 'Instruction',
        shown: () => sectionOf(s.id)?.instruction ?? '',
        toCandidate: (raw) => buildSection(s.id, { instruction: raw.trim() }),
        display: (p) => p.sections.find((x) => x.id === s.id)?.instruction ?? '',
      });
    }
    wireField(titleInput, commitTitle, () => sectionOf(s.id)?.title ?? '');
    wireField(instrInput, commitInstruction, () => sectionOf(s.id)?.instruction ?? '');

    return { el, titleInput, titleFieldEl, instrInput, instrFieldEl, formatEl, upBtn, downBtn };
  }

  const addSectionBtn = button('Add section', { attrs: { 'data-key': 'add-section' }, onClick: () => addSection() });
  const addSectionNote = h('p', { class: 'hint' }, `Up to ${PROFILE_LIMITS.sections} sections.`);
  const addSectionRow = h('div', { class: 'settings-action' }, addSectionBtn, addSectionNote);
  const actionItemsHint = h(
    'p',
    { class: 'hint' },
    `“${ACTION_ITEMS_TITLE}” is always added after the sections.`,
  );

  function addSection(): void {
    if (!profile) return;
    void saveStructural({ ...profile, sections: [...profile.sections, newSection(profile.sections)] });
  }

  function sectionsKey(sections: readonly NoteSection[]): string {
    return sections.map((s) => `${s.id}:${s.format}`).join('|');
  }

  function renderSections(): void {
    if (!profile) {
      sectionsList.replaceChildren();
      sectionRows.clear();
      lastSectionsKey = null;
      return;
    }
    const key = sectionsKey(profile.sections);
    if (key !== lastSectionsKey) {
      lastSectionsKey = key;
      sectionRows.clear();
      sectionsList.replaceChildren(
        ...profile.sections.map((s) => {
          const row = buildSectionRow(s);
          sectionRows.set(s.id, row);
          return row.el;
        }),
      );
    }
    profile.sections.forEach((s, i) => {
      const row = sectionRows.get(s.id);
      if (!row) return;
      syncValue(row.titleInput, s.title);
      setSegmented(row.formatEl, s.format);
      syncValue(row.instrInput, s.instruction);
      setDisabled(row.upBtn, i === 0);
      setDisabled(row.downBtn, i === profile!.sections.length - 1);
    });
    setDisabled(addSectionBtn, profile.sections.length >= PROFILE_LIMITS.sections);
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
  function commitVocabulary(): Promise<void> {
    return commitValue({
      input: vocabInput,
      fieldEl: vocabFieldEl,
      saved: vocabSaved,
      label: 'Vocabulary',
      shown: () => profile!.vocabulary.join('\n'),
      toCandidate: (raw) => ({ ...profile!, vocabulary: parseVocabulary(raw) }),
      display: (p) => p.vocabulary.join('\n'),
    });
  }
  wireField(vocabInput, commitVocabulary, () => profile!.vocabulary.join('\n'));

  // ---- Delete ------------------------------------------------------------------------------
  const deleteMsg = h('p', { class: 'field-msg', role: 'status' });
  const deleteArea = h('div', { class: 'profile-delete' });

  function renderDelete(): void {
    if (!profile || !settings) {
      deleteArea.replaceChildren();
      return;
    }
    const isDefault = profile.id === settings.defaultProfileId;
    if (confirmingDelete) {
      const cancel = button('Cancel', {
        kind: 'plain',
        attrs: { 'data-key': 'delete-cancel' },
        onClick: () => {
          confirmingDelete = false;
          renderDelete();
        },
      });
      const confirm = button('Delete', {
        kind: 'plain',
        attrs: { 'data-key': 'delete-confirm' },
        onClick: () => void confirmDelete(),
      });
      deleteArea.replaceChildren(
        h(
          'p',
          null,
          `Delete ${quoted(profile.name)}? Meetings recorded with it will ask for another profile.`,
        ),
        h('div', { class: 'profile-delete-actions' }, cancel, confirm),
        deleteMsg,
      );
      return;
    }
    const deleteBtn = button('Delete profile…', {
      kind: 'link',
      class: 'profile-delete-link',
      disabled: isDefault,
      attrs: { 'data-key': 'delete' },
      onClick: () => {
        confirmingDelete = true;
        renderDelete();
      },
    });
    mount(
      deleteArea,
      deleteBtn,
      isDefault ? h('p', { class: 'hint' }, 'Make another profile the default first.') : null,
      deleteMsg,
    );
  }

  async function confirmDelete(): Promise<void> {
    if (!profile) return;
    const id = profile.id;
    writing++;
    try {
      await handlers.remove(id);
      writing--;
      confirmingDelete = false;
      handlers.back();
    } catch (err) {
      writing--;
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
      body.replaceChildren(deletedMsg);
      return;
    }
    heading.textContent = profile.name;
    syncValue(nameInput, profile.name);
    syncValue(dbInput, profile.databaseId);
    syncValue(promptInput, profile.prompt);
    syncValue(vocabInput, profile.vocabulary.join('\n'));
    const isDefault = profile.id === settings.defaultProfileId;
    if (document.activeElement !== defaultInput) {
      defaultInput.checked = isDefault;
      setDisabled(defaultInput, isDefault);
    }
    renderSections();
    renderDelete();
    body.replaceChildren(profileSection, notesSection, transcriptionSection, deleteArea);
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
      for (const f of fields) {
        if (f.input.value === f.shown()) continue;
        unsaved = true;
        void f.commit();
      }
      return unsaved;
    },
  };
}
