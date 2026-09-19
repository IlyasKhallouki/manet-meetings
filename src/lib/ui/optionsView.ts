/**
 * The options form. Loading, saving and verification come in as handlers, so the form
 * renders in any DOM; parsing and validation live in settingsForm.ts.
 */
import type { VerifyResult } from '../notion/verify';
import type { Route, Settings } from '../types';
import { h, mount, type Child } from './dom';
import type { MicPermission } from './mic';
import { micView } from './popupView';
import { parseSettingsForm, settingsToForm, type SettingsErrors, type SettingsFormValues } from './settingsForm';

export interface OptionsHandlers {
  save(settings: Settings): Promise<void>;
  verifyGemini(apiKey: string): Promise<{ ok: true } | { ok: false; error: string }>;
  verifyNotion(token: string, databaseId: string): Promise<VerifyResult>;
  openPermissionPage(): void;
}

export interface OptionsView {
  load(settings: Settings): void;
  setMic(permission: MicPermission): void;
}

type TextName =
  | 'displayName'
  | 'geminiApiKey'
  | 'notionToken'
  | 'notionTeamDbId'
  | 'notionPersonalDbId'
  | 'retentionDays'
  | 'languageCodes';
type CheckName = 'autoTranscribe' | 'includeMic';

/** Form order, for focusing the first problem. */
const ORDER: (keyof Settings)[] = [
  'displayName',
  'geminiApiKey',
  'customVocabulary',
  'languageCodes',
  'notionToken',
  'notionTeamDbId',
  'notionPersonalDbId',
  'defaultRoute',
  'includeMic',
  'autoTranscribe',
  'retentionDays',
];

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createOptionsView(root: HTMLElement, handlers: OptionsHandlers): OptionsView {
  const inputs = new Map<TextName, HTMLInputElement>();
  const checks = new Map<CheckName, HTMLInputElement>();
  const errorSlots = new Map<keyof Settings, HTMLElement>();
  const focusTargets = new Map<keyof Settings, HTMLElement>();
  let permission: MicPermission | null = null;
  let saving = false;

  const saveStatus = h('p', { class: 'save-status', 'data-role': 'save-status', role: 'status' });
  const geminiResult = h('p', { class: 'check-result', 'data-role': 'gemini-result', role: 'status' });
  const notionResult = h('div', { class: 'check-result', 'data-role': 'notion-result', role: 'status' });
  const micStatus = h('div', { 'data-role': 'mic' });

  function hintAndError(name: keyof Settings, hint?: string): Child[] {
    const error = h('p', { id: `${name}-error`, class: 'error', hidden: true });
    errorSlots.set(name, error);
    return [hint ? h('p', { id: `${name}-hint`, class: 'hint' }, hint) : null, error];
  }

  function describedBy(name: keyof Settings, hint: boolean): string | undefined {
    return hint ? `${name}-hint` : undefined;
  }

  function textField(
    name: TextName,
    label: string,
    hint: string | undefined,
    attrs: Record<string, string | boolean> = {},
    extra: Child[] = [],
  ): HTMLElement {
    const input = h('input', {
      id: name,
      name,
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': describedBy(name, !!hint),
      ...attrs,
    });
    inputs.set(name, input);
    focusTargets.set(name, input);
    return h(
      'div',
      { class: 'field' },
      h('label', { for: name }, label),
      h('div', { class: 'input-row' }, input, extra),
      hintAndError(name, hint),
    );
  }

  function secretField(name: 'geminiApiKey' | 'notionToken', label: string, hint: string, extra: Child[] = []) {
    const toggle = h(
      'button',
      { type: 'button', class: 'quiet', 'aria-controls': name, 'aria-pressed': 'false' },
      'Show',
    );
    toggle.addEventListener('click', () => {
      const input = inputs.get(name)!;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.textContent = show ? 'Hide' : 'Show';
    });
    return textField(name, label, hint, { type: 'password' }, [toggle, ...extra]);
  }

  function checkField(name: CheckName, label: string, hint: string): HTMLElement {
    const input = h('input', { id: name, name, type: 'checkbox', 'aria-describedby': `${name}-hint` });
    checks.set(name, input);
    focusTargets.set(name, input);
    return h(
      'div',
      { class: 'field check' },
      h('label', { for: name }, input, ' ', label),
      hintAndError(name, hint),
    );
  }

  const vocabulary = h('textarea', {
    id: 'customVocabulary',
    name: 'customVocabulary',
    rows: 6,
    spellcheck: 'false',
    'aria-describedby': 'customVocabulary-hint',
  });
  focusTargets.set('customVocabulary', vocabulary);

  const routeRadios = (['team', 'personal'] as Route[]).map((route) =>
    h('input', { type: 'radio', name: 'defaultRoute', value: route, id: `defaultRoute-${route}` }),
  );
  focusTargets.set('defaultRoute', routeRadios[0]!);

  const testGemini = h('button', { type: 'button', onclick: () => void checkGemini() }, 'Test Gemini key');
  const testNotion = h('button', { type: 'button', onclick: () => void checkNotion() }, 'Test Notion databases');

  const form = h(
    'form',
    { class: 'options', novalidate: true },
    h(
      'section',
      null,
      h('h2', null, 'You'),
      textField(
        'displayName',
        'Your name',
        'Fills "Recorded by" in Notion and replaces Meet\'s "You" caption label.',
        { autocomplete: 'name' },
      ),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Gemini'),
      secretField('geminiApiKey', 'Gemini API key', 'Create one at aistudio.google.com/apikey.', [testGemini]),
      geminiResult,
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'customVocabulary' }, 'Custom vocabulary'),
        vocabulary,
        hintAndError(
          'customVocabulary',
          'One term per line: names, products and jargon Gemini should spell correctly. ' +
            'Attendee names are added automatically.',
        ),
      ),
      textField(
        'languageCodes',
        'Language hints',
        'Comma-separated codes such as en-US, fr-FR. Leave empty for automatic detection, which handles ' +
          'meetings that mix languages.',
        { placeholder: 'Automatic' },
      ),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Notion'),
      secretField(
        'notionToken',
        'Notion integration token',
        'The secret of your internal integration. Share both databases with it (••• → Connections).',
      ),
      textField('notionTeamDbId', 'Team database', 'Link or id of the Team meetings database.', {
        placeholder: 'https://www.notion.so/…',
      }),
      textField('notionPersonalDbId', 'Personal database', 'Link or id of your Personal meetings database.', {
        placeholder: 'https://www.notion.so/…',
      }),
      h('div', { class: 'field input-row' }, testNotion),
      notionResult,
      h(
        'fieldset',
        { class: 'field', 'aria-describedby': 'defaultRoute-hint' },
        h('legend', null, 'Default destination'),
        routeRadios.map((radio) =>
          h('label', { class: 'radio', for: radio.id }, radio, ' ', radio.value === 'team' ? 'Team' : 'Personal'),
        ),
        hintAndError(
          'defaultRoute',
          'Highlighted when a meeting ends, and used if you do not choose within a minute.',
        ),
      ),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Recording'),
      checkField(
        'includeMic',
        'Include my microphone',
        'Meet does not play your own voice back, so without the mic only the other participants are recorded.',
      ),
      micStatus,
      checkField(
        'autoTranscribe',
        'Transcribe automatically',
        'Transcribe and save to Notion as soon as the destination is chosen.',
      ),
      textField(
        'retentionDays',
        'Keep audio for (days)',
        'After the transcript is saved to Notion. 0 deletes it at the next cleanup.',
        { type: 'number', inputmode: 'numeric', min: '0', max: '365', step: '1' },
      ),
    ),
    h('div', { class: 'form-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Save'), saveStatus),
  );
  mount(root, form);

  function readForm(): SettingsFormValues {
    const text = (name: TextName) => inputs.get(name)!.value;
    return {
      displayName: text('displayName'),
      geminiApiKey: text('geminiApiKey'),
      notionToken: text('notionToken'),
      notionTeamDbId: text('notionTeamDbId'),
      notionPersonalDbId: text('notionPersonalDbId'),
      defaultRoute: routeRadios.find((r) => r.checked)?.value ?? '',
      autoTranscribe: checks.get('autoTranscribe')!.checked,
      retentionDays: text('retentionDays'),
      customVocabulary: vocabulary.value,
      languageCodes: text('languageCodes'),
      includeMic: checks.get('includeMic')!.checked,
    };
  }

  function showErrors(errors: SettingsErrors): void {
    for (const [name, slot] of errorSlots) {
      const message = errors[name];
      const target = focusTargets.get(name);
      slot.textContent = message ?? '';
      slot.hidden = !message;
      if (!target) continue;
      const hint = name === 'defaultRoute' ? null : document.getElementById(`${name}-hint`);
      const ids = [hint ? hint.id : null, message ? slot.id : null].filter(Boolean).join(' ');
      if (ids) target.setAttribute('aria-describedby', ids);
      else target.removeAttribute('aria-describedby');
      if (message) target.setAttribute('aria-invalid', 'true');
      else target.removeAttribute('aria-invalid');
    }
  }

  function setStatus(message: string, tone?: 'ok' | 'error'): void {
    saveStatus.textContent = message;
    saveStatus.className = `save-status${tone ? ` ${tone}` : ''}`;
  }

  function renderMic(): void {
    if (permission === null) {
      mount(micStatus, h('p', { class: 'muted' }, 'Checking microphone permission…'));
      return;
    }
    const view = micView(permission, checks.get('includeMic')!.checked);
    micStatus.className = `notice ${view.tone}`;
    mount(
      micStatus,
      h('span', null, view.text),
      view.canRequest
        ? h(
            'button',
            { type: 'button', class: 'link', onclick: () => handlers.openPermissionPage() },
            'Grant microphone access',
          )
        : null,
    );
  }

  async function checkGemini(): Promise<void> {
    geminiResult.className = 'check-result muted';
    geminiResult.textContent = 'Checking…';
    testGemini.disabled = true;
    try {
      const result = await handlers.verifyGemini(inputs.get('geminiApiKey')!.value.trim());
      geminiResult.className = `check-result ${result.ok ? 'ok' : 'error'}`;
      geminiResult.textContent = result.ok ? 'The key works.' : result.error;
    } catch (err) {
      geminiResult.className = 'check-result error';
      geminiResult.textContent = errorText(err);
    } finally {
      testGemini.disabled = false;
    }
  }

  async function checkNotion(): Promise<void> {
    const token = inputs.get('notionToken')!.value.trim();
    const dbs: { key: Route; label: string; id: string }[] = [
      { key: 'team', label: 'Team', id: inputs.get('notionTeamDbId')!.value.trim() },
      { key: 'personal', label: 'Personal', id: inputs.get('notionPersonalDbId')!.value.trim() },
    ];
    mount(notionResult, h('p', { class: 'muted' }, 'Checking…'));
    testNotion.disabled = true;
    try {
      const results = await Promise.all(
        dbs.map(async (db): Promise<VerifyResult | null> => {
          if (!db.id) return null;
          try {
            return await handlers.verifyNotion(token, db.id);
          } catch (err) {
            return { ok: false, problems: [errorText(err)] };
          }
        }),
      );
      mount(
        notionResult,
        dbs.map((db, i) => {
          const result = results[i];
          if (!result) return h('div', { 'data-db': db.key, class: 'muted' }, `${db.label}: not set.`);
          if (result.ok) {
            return h('div', { 'data-db': db.key, class: 'ok' }, `${db.label}: "${result.title}" is ready.`);
          }
          return h(
            'div',
            { 'data-db': db.key, class: 'error' },
            `${db.label}:`,
            h('ul', null, result.problems.map((p) => h('li', null, p))),
          );
        }),
      );
    } finally {
      testNotion.disabled = false;
    }
  }

  form.addEventListener('input', () => {
    if (!saving) setStatus('Unsaved changes.');
  });
  form.addEventListener('change', (e) => {
    if (e.target === checks.get('includeMic')) renderMic();
    if (!saving) setStatus('Unsaved changes.');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void save();
  });

  async function save(): Promise<void> {
    if (saving) return;
    const parsed = parseSettingsForm(readForm());
    if (!parsed.ok) {
      showErrors(parsed.errors);
      setStatus('Fix the highlighted fields, then save again.', 'error');
      const first = ORDER.find((name) => parsed.errors[name]);
      if (first) focusTargets.get(first)?.focus();
      return;
    }
    showErrors({});
    saving = true;
    setStatus('Saving…');
    try {
      await handlers.save(parsed.settings);
      setStatus('Saved.', 'ok');
    } catch (err) {
      setStatus(`Could not save: ${errorText(err)}`, 'error');
    } finally {
      saving = false;
    }
  }

  renderMic();
  return {
    load(settings) {
      const v = settingsToForm(settings);
      for (const [name, input] of inputs) input.value = v[name];
      vocabulary.value = v.customVocabulary;
      for (const radio of routeRadios) radio.checked = radio.value === v.defaultRoute;
      checks.get('autoTranscribe')!.checked = v.autoTranscribe;
      checks.get('includeMic')!.checked = v.includeMic;
      showErrors({});
      setStatus('');
      renderMic();
    },
    setMic(next) {
      permission = next;
      renderMic();
    },
  };
}
