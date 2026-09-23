/**
 * Settings › Share: export the stored profiles and settings to a manet-config file, and
 * import one back. Export opens an inline form in its own row; import reads a chosen file,
 * previews what it would change (profileConfig() does the diffing), and applies the merge
 * in one write. Pure DOM, driven entirely by the handlers it's given, so it renders the
 * same in tests and on the page.
 */
import { buildConfigFile, configFileName, mergeConfig, parseConfigFile, previewConfig, serializeConfig, type ConfigFile } from '../config';
import type { Settings } from '../types';
import { button, field, setDisabled, switchRow, textInput } from './controls';
import { h } from './dom';
import { svg } from './icons';
import { section } from './controls';
import type { FormatOptions } from './sessionView';
import { shortDay } from './sessionView';

export interface ShareHandlers {
  /** The stored settings, or null before they load. */
  current(): Settings | null;
  /** Stores the whole merged settings; resolves to what was stored. */
  apply(next: Settings): Promise<Settings>;
  /** Hands the file to the browser as a download. */
  download(fileName: string, text: string): void;
  /** After an import: check every profile's database. */
  imported(): void;
}

export interface ShareViewOptions {
  /** The current time, for "Exported…" and the export file's timestamp. Defaults to Date.now. */
  now?: () => number;
  format?: FormatOptions;
}

export interface ShareView {
  element: HTMLElement;
}

const HINT = 'Give everyone the same profiles and settings. Your name and meetings are never in the file.';
const KEYS_CAUTION = 'Anyone with this file can use these keys.';
const EXPORTED_MS = 2000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "Import “Acme team”" / "Exported Wed 23 Sep 2026" / one line per profile, setting and key. */
function previewLines(current: Settings, file: ConfigFile, now: number, format: FormatOptions): HTMLElement[] {
  const preview = previewConfig(current, file);
  const lines: HTMLElement[] = [h('p', { class: 'share-preview-title' }, `Import “${preview.name}”`)];
  const exportedAt = Date.parse(preview.exportedAt);
  if (!Number.isNaN(exportedAt)) lines.push(h('p', { class: 'hint' }, `Exported ${shortDay(exportedAt, now, format)}`));

  const profileList = h('ul', { class: 'share-preview-list', role: 'list' });
  for (const p of preview.profiles) {
    const text =
      p.change === 'added'
        ? `New: ${p.name}`
        : p.change === 'changed'
          ? `Changes ${p.name}: ${p.fields.join(', ')}`
          : p.change === 'unchanged'
            ? `Unchanged: ${p.name}`
            : `Kept, only on this computer: ${p.name}`;
    profileList.append(h('li', null, text));
  }
  lines.push(profileList);

  const settingsList = h('ul', { class: 'share-preview-list', role: 'list' });
  if (preview.settings.length === 0) settingsList.append(h('li', null, 'Settings: no changes'));
  else for (const s of preview.settings) settingsList.append(h('li', null, `${s.label}: ${s.from} → ${s.to}`));
  if (preview.defaultProfile) {
    settingsList.append(h('li', null, `Default profile: ${preview.defaultProfile.from} → ${preview.defaultProfile.to}`));
  }
  lines.push(settingsList);

  const keysCaution = preview.keys === 'replaced';
  lines.push(
    h(
      'p',
      { class: 'share-keys' },
      keysCaution ? svg('caution', { class: 'tone-caution' }) : null,
      h('span', null, keysCaution ? 'API keys: replaced with the file’s' : 'API keys: not in the file, yours are kept'),
    ),
  );
  return lines;
}

export function createShareView(handlers: ShareHandlers, options: ShareViewOptions = {}): ShareView {
  const now = () => options.now?.() ?? Date.now();
  const format = options.format ?? {};

  // ---- Export ------------------------------------------------------------------------------
  const exportButton = button('Export config…', { attrs: { 'data-key': 'export' }, onClick: () => openExport() });
  const exportHint = h('p', { class: 'hint' }, HINT);
  const exportActionBar = h(
    'div',
    { class: 'settings-action' },
    h('div', { class: 'settings-action-text' }, exportHint),
    exportButton,
  );

  const nameInput = textInput({ id: 'export-name', 'data-key': 'export-name', value: 'Manet config' });
  const nameField = field({ id: 'export-name', label: 'Name', control: nameInput });

  const keysCaution = h(
    'p',
    { class: 'field-msg', 'data-role': 'export-keys-caution' },
    svg('caution', { class: 'tone-caution' }),
    h('span', null, KEYS_CAUTION),
  );
  keysCaution.hidden = true;
  const keysRow = switchRow({
    id: 'export-keys',
    label: 'Include API keys',
    checked: false,
    onChange: (checked) => {
      keysCaution.hidden = !checked;
    },
    extra: keysCaution,
    attrs: { 'data-key': 'export-keys' },
  });

  const exportCancelButton = button('Cancel', { attrs: { 'data-key': 'export-cancel' }, onClick: () => closeExport() });
  const exportGoButton = button('Export', { attrs: { 'data-key': 'export-go' }, onClick: () => void doExport() });
  const exportForm = h(
    'div',
    { class: 'share-form', 'data-role': 'export-form' },
    nameField,
    keysRow,
    h('div', { class: 'share-form-actions' }, exportCancelButton, exportGoButton),
  );
  exportForm.hidden = true;

  const exportDone = h('p', { class: 'field-msg', 'data-role': 'export-done', role: 'status' }, svg('done', { class: 'tone-done' }), h('span', null, 'Exported'));
  exportDone.hidden = true;
  let exportDoneTimer: ReturnType<typeof setTimeout> | undefined;

  function openExport(): void {
    nameInput.value = 'Manet config';
    keysRow.querySelector('input')!.checked = false;
    keysCaution.hidden = true;
    clearTimeout(exportDoneTimer);
    exportDone.hidden = true;
    exportActionBar.hidden = true;
    exportForm.hidden = false;
    nameInput.focus();
  }

  function closeExport(): void {
    exportForm.hidden = true;
    exportActionBar.hidden = false;
  }

  async function doExport(): Promise<void> {
    const current = handlers.current();
    if (!current) return;
    const name = nameInput.value;
    const includeKeys = keysRow.querySelector('input')!.checked;
    setDisabled(exportGoButton, true);
    try {
      const file = buildConfigFile(current, { name, includeKeys, now: now() });
      const text = serializeConfig(file);
      handlers.download(configFileName(name), text);
      exportForm.hidden = true;
      exportActionBar.hidden = true;
      exportDone.hidden = false;
      clearTimeout(exportDoneTimer);
      exportDoneTimer = setTimeout(() => {
        exportDone.hidden = true;
        exportActionBar.hidden = false;
      }, EXPORTED_MS);
    } finally {
      setDisabled(exportGoButton, false);
    }
  }

  const exportRow = h('div', { class: 'share-row', 'data-role': 'export-row' }, exportActionBar, exportForm, exportDone);

  // ---- Import ------------------------------------------------------------------------------
  const importButton = button('Import config…', { attrs: { 'data-key': 'import' }, onClick: () => fileInput.click() });
  const importHint = h('p', { class: 'hint' }, HINT);
  const importActionBar = h(
    'div',
    { class: 'settings-action' },
    h('div', { class: 'settings-action-text' }, importHint),
    importButton,
  );

  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: () => void onFileChosen() });

  const importError = h('p', { class: 'field-msg', role: 'alert', 'data-role': 'import-error' });
  importError.hidden = true;

  let pendingFile: ConfigFile | null = null;
  const importPreview = h('div', { class: 'share-form', 'data-role': 'import-preview' });
  importPreview.hidden = true;

  async function onFileChosen(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    importError.hidden = true;
    importPreview.hidden = true;
    importPreview.replaceChildren();
    const text = await file.text();
    const result = parseConfigFile(text);
    if (!result.ok) {
      pendingFile = null;
      importError.textContent = result.error;
      importError.hidden = false;
      return;
    }
    pendingFile = result.file;
    renderImportPreview(result.file);
  }

  function renderImportPreview(file: ConfigFile): void {
    const current = handlers.current();
    if (!current) return;
    const cancelButton = button('Cancel', { attrs: { 'data-key': 'import-cancel' }, onClick: () => closeImport() });
    const goButton = button('Import', { kind: 'prominent', attrs: { 'data-key': 'import-go' }, onClick: () => void doImport() });
    const importMsg = h('p', { class: 'field-msg' });
    importPreview.replaceChildren(
      ...previewLines(current, file, now(), format),
      h('div', { class: 'share-form-actions' }, cancelButton, goButton),
      importMsg,
    );
    importActionBar.hidden = true;
    importPreview.hidden = false;
  }

  function closeImport(): void {
    pendingFile = null;
    importPreview.hidden = true;
    importPreview.replaceChildren();
    importActionBar.hidden = false;
  }

  async function doImport(): Promise<void> {
    const file = pendingFile;
    const current = handlers.current();
    if (!file || !current) return;
    const goButton = importPreview.querySelector<HTMLButtonElement>('[data-key="import-go"]');
    const cancelButton = importPreview.querySelector<HTMLButtonElement>('[data-key="import-cancel"]');
    const msg = importPreview.querySelector<HTMLElement>('.field-msg:last-child');
    if (goButton) setDisabled(goButton, true);
    if (cancelButton) setDisabled(cancelButton, true);
    try {
      await handlers.apply(mergeConfig(current, file));
      importPreview.replaceChildren(
        h('p', { class: 'field-msg', role: 'status' }, svg('done', { class: 'tone-done' }), h('span', null, `Imported “${file.name}”`)),
      );
      pendingFile = null;
      handlers.imported();
    } catch (err) {
      if (msg) {
        msg.dataset.tone = 'caution';
        msg.replaceChildren(svg('caution', { class: 'tone-caution' }), h('span', null, `Couldn’t import: ${errorText(err)}`));
      }
      if (goButton) setDisabled(goButton, false);
      if (cancelButton) setDisabled(cancelButton, false);
    }
  }

  const importRow = h('div', { class: 'share-row', 'data-role': 'import-row' }, importActionBar, fileInput, importError, importPreview);

  // ---- Group -------------------------------------------------------------------------------
  const group = section({ title: 'Share', id: 'settings-share', rows: [exportRow, importRow] });

  return { element: group };
}
