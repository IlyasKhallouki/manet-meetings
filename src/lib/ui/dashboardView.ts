/**
 * The dashboard table. Data comes in through update(); requests go out through the
 * handlers, so this module needs no extension APIs and renders in any DOM.
 *
 * Cells are patched only when what they show changes. A recording row updates every
 * second (clock) and every chunk (size); rebuilding its buttons each time could eat a
 * click that lands between mousedown and mouseup.
 */
import type { Route, SessionMeta } from '../types';
import { h, keepFocus, mount, type Child } from './dom';
import {
  ANYWAY_NOTE,
  canChooseRoute,
  compareSessions,
  sessionActions,
  sessionRow,
  storageSummary,
  type ActionView,
  type FormatOptions,
  type SessionAction,
  type SessionRowView,
} from './sessionView';

export interface DashboardData {
  sessions: readonly SessionMeta[];
  /** Sessions with a stored transcript (Save needs one). */
  resultIds: ReadonlySet<string>;
  /** Committed audio bytes per session in OPFS; null when the scan failed. */
  audioOnDisk: ReadonlyMap<string, number> | null;
  /** navigator.storage.estimate() for the extension origin. */
  estimate: { usage: number; quota: number } | null;
  /** Settings that block saving to Notion. */
  missing: readonly string[];
  /** No Gemini key: meetings are still saved, with a captions-only transcript. */
  geminiKeyMissing: boolean;
  /** The auto-transcribe setting. */
  autoTranscribe: boolean;
  now: number;
}

export interface DashboardHandlers {
  stop(sessionId: string): Promise<void>;
  /** `force` skips the Notion duplicate check ("Transcribe anyway"). */
  transcribe(sessionId: string, opts: { force?: boolean }): Promise<void>;
  /** `force` saves despite an existing page ("Save anyway"). */
  save(sessionId: string, opts: { force?: boolean }): Promise<void>;
  remove(sessionId: string): Promise<void>;
  route(sessionId: string, route: Route): Promise<void>;
  setAutoTranscribe(on: boolean): Promise<void>;
  openSettings(): void;
}

export interface DashboardView {
  update(data: DashboardData): void;
}

type CellName = 'date' | 'meeting' | 'duration' | 'audio' | 'status' | 'route' | 'actions';

const COLUMNS: { cell: CellName; label: string; hidden?: boolean }[] = [
  { cell: 'date', label: 'Date' },
  { cell: 'meeting', label: 'Meeting' },
  { cell: 'duration', label: 'Duration' },
  { cell: 'audio', label: 'Audio' },
  { cell: 'status', label: 'Status' },
  { cell: 'route', label: 'Destination' },
  { cell: 'actions', label: 'Actions', hidden: true },
];

const ACTION_ORDER: SessionAction[] = ['stop', 'transcribe', 'save', 'delete'];

interface RowEntry {
  tr: HTMLTableRowElement;
  cells: Map<CellName, HTMLTableCellElement>;
  sigs: Map<CellName, string>;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

export function createDashboardView(
  root: HTMLElement,
  handlers: DashboardHandlers,
  format: FormatOptions = {},
): DashboardView {
  const pending = new Set<string>();
  const confirming = new Set<string>();
  const failures = new Map<string, string>();
  /** The destination picked while its request is in flight, so the picker does not snap back. */
  const choices = new Map<string, Route>();
  const rows = new Map<string, RowEntry>();
  let data: DashboardData | null = null;
  let focusNext: string | null = null;
  let noticeSig = '';
  /** The auto-transcribe value asked for, shown until the next update after its request. */
  let autoChoice: boolean | undefined;
  let autoPending = false;

  const autoSwitch = h('input', {
    type: 'checkbox',
    role: 'switch',
    id: 'auto-transcribe',
    'aria-describedby': 'auto-transcribe-mode',
    'data-key': 'auto-transcribe',
  });
  const autoMode = h('span', { class: 'sub', id: 'auto-transcribe-mode', 'data-role': 'auto-mode' });
  const autoError = h('p', { class: 'error', role: 'alert', hidden: true });
  const autoBar = h(
    'div',
    { class: 'dashboard-bar', 'data-role': 'auto-transcribe' },
    h('label', { class: 'switch', for: 'auto-transcribe' }, autoSwitch, 'Transcribe automatically'),
    autoMode,
    autoError,
  );
  autoSwitch.addEventListener('change', () => setAuto(autoSwitch.checked));

  const noticeSlot = h('div');
  const storage = h('p', { class: 'storage muted', 'data-role': 'storage' });
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: 'sessions' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        COLUMNS.map((c) =>
          h(
            'th',
            { scope: 'col', class: `col-${c.cell}` },
            c.hidden ? h('span', { class: 'visually-hidden' }, c.label) : c.label,
          ),
        ),
      ),
    ),
    tbody,
  );
  const empty = h(
    'p',
    { class: 'empty', 'data-role': 'empty', hidden: true },
    'No recordings yet. Join a Google Meet call and click Record in the extension popup.',
  );
  mount(root, autoBar, noticeSlot, storage, h('div', { class: 'table-wrap' }, table), empty);

  function setAuto(on: boolean): void {
    autoChoice = on;
    autoPending = true;
    autoError.hidden = true;
    let promise: Promise<void>;
    try {
      promise = handlers.setAutoTranscribe(on);
    } catch (err) {
      promise = Promise.reject(err);
    }
    renderAuto();
    promise
      .catch((err: unknown) => {
        autoChoice = undefined;
        autoError.textContent = errorText(err);
        autoError.hidden = false;
      })
      .finally(() => {
        autoPending = false;
        if (data?.autoTranscribe === autoChoice) autoChoice = undefined;
        renderAuto();
      });
  }

  function renderAuto(): void {
    const d = data;
    if (!d) return;
    const on = autoChoice ?? d.autoTranscribe;
    autoSwitch.checked = on;
    autoSwitch.disabled = autoPending;
    autoMode.textContent = on
      ? 'On: each meeting is transcribed and saved to Notion once its destination is chosen.'
      : 'Off: nothing is sent until you click Transcribe on a meeting.';
  }

  function run(id: string, request: () => Promise<void>): void {
    failures.delete(id);
    pending.add(id);
    let promise: Promise<void>;
    try {
      promise = request();
    } catch (err) {
      promise = Promise.reject(err);
    }
    render();
    promise
      .catch((err: unknown) => {
        failures.set(id, errorText(err));
      })
      .finally(() => {
        pending.delete(id);
        choices.delete(id);
        render();
      });
  }

  function startDelete(id: string): void {
    confirming.add(id);
    focusNext = `${id}:cancel`;
    render();
  }

  function cancelDelete(id: string): void {
    confirming.delete(id);
    focusNext = `${id}:delete`;
    render();
  }

  function confirmDelete(id: string): void {
    confirming.delete(id);
    run(id, () => handlers.remove(id));
  }

  function onAction(meta: SessionMeta, action: SessionAction, view: ActionView): void {
    const id = meta.id;
    const opts = view.force ? { force: true } : {};
    if (action === 'delete') startDelete(id);
    else if (action === 'stop') run(id, () => handlers.stop(id));
    else if (action === 'transcribe') run(id, () => handlers.transcribe(id, opts));
    else run(id, () => handlers.save(id, opts));
  }

  function actionButton(meta: SessionMeta, title: string, action: SessionAction, view: ActionView): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: view.primary ? 'primary' : undefined,
        disabled: !view.enabled,
        title: view.hint,
        'aria-label': `${view.label} ${title}`,
        'data-key': `${meta.id}:${action}`,
        onclick: () => onAction(meta, action, view),
      },
      view.label,
    );
  }

  function confirmBox(meta: SessionMeta): HTMLElement {
    const id = meta.id;
    let question = 'Delete this recording, its transcript and audio?';
    if (meta.status === 'recording') question = 'Stop recording and delete it?';
    else if (meta.notion) question += ' The Notion page stays.';
    return h(
      'div',
      {
        class: 'confirm',
        role: 'group',
        'aria-label': 'Confirm delete',
        onkeydown: (e: Event) => {
          if ((e as KeyboardEvent).key === 'Escape') cancelDelete(id);
        },
      },
      h('span', { class: 'confirm-question' }, question),
      h(
        'span',
        { class: 'confirm-buttons' },
        h(
          'button',
          { type: 'button', class: 'danger', 'data-key': `${id}:confirm-delete`, onclick: () => confirmDelete(id) },
          'Yes, delete',
        ),
        h('button', { type: 'button', 'data-key': `${id}:cancel`, onclick: () => cancelDelete(id) }, 'Cancel'),
      ),
    );
  }

  function routePicker(meta: SessionMeta, title: string): HTMLSelectElement {
    const id = meta.id;
    const value = choices.get(id) ?? meta.route;
    const select = h(
      'select',
      {
        'aria-label': `Destination for ${title}`,
        'data-key': `${id}:route`,
        disabled: pending.has(id),
      },
      value ? null : h('option', { value: '', disabled: true, selected: true }, 'Choose…'),
      h('option', { value: 'team', selected: value === 'team' }, 'Team'),
      h('option', { value: 'personal', selected: value === 'personal' }, 'Personal'),
    );
    select.addEventListener('change', () => {
      const route = select.value as Route;
      choices.set(id, route);
      run(id, () => handlers.route(id, route));
    });
    return select;
  }

  function statusCell(view: SessionRowView, failure: string | undefined): Child[] {
    const { status } = view;
    return [
      h(
        'div',
        { class: 'status-line' },
        h('span', { class: `badge tone-${status.tone}` }, status.label),
        status.detail ? h('span', { class: 'sub' }, status.detail) : null,
        view.recovered
          ? h('span', { class: 'badge tone-neutral', title: 'Interrupted by a restart, then recovered.' }, 'Recovered')
          : null,
      ),
      view.error ? h('p', { class: 'error' }, view.error) : null,
      view.retry ? h('p', { class: 'sub', 'data-role': 'retry' }, view.retry) : null,
      view.captionsNote
        ? h('p', { class: 'sub warn-text', 'data-role': 'captions-warning' }, view.captionsNote)
        : null,
      failure ? h('p', { class: 'error', role: 'alert' }, failure) : null,
      view.notion
        ? h('a', { href: view.notion.url, target: '_blank', rel: 'noopener noreferrer' }, view.notion.label)
        : null,
    ];
  }

  function patch(entry: RowEntry, name: CellName, sig: string, build: () => Child[]): void {
    if (entry.sigs.get(name) === sig) return;
    entry.sigs.set(name, sig);
    mount(entry.cells.get(name)!, build());
  }

  function newRow(id: string): RowEntry {
    const tr = h('tr', { 'data-id': id });
    const cells = new Map<CellName, HTMLTableCellElement>();
    for (const { cell } of COLUMNS) {
      const td = cell === 'meeting' ? h('th', { scope: 'row' }) : h('td');
      td.dataset.cell = cell;
      td.className = `col-${cell}`;
      cells.set(cell, td);
      tr.append(td);
    }
    return { tr, cells, sigs: new Map() };
  }

  function patchRow(entry: RowEntry, meta: SessionMeta, d: DashboardData): void {
    const id = meta.id;
    const onDisk = d.audioOnDisk?.get(id);
    const disk = onDisk === undefined ? {} : { audioBytes: onDisk };
    const view = sessionRow(meta, { ...format, now: d.now, ...disk });
    const isPending = pending.has(id);
    const actions = sessionActions(meta, { hasResult: d.resultIds.has(id), pending: isPending });
    const failure = failures.get(id);
    const routable = canChooseRoute(meta);
    // A job that started meanwhile cancels the question rather than leaving it for later.
    if (!actions.delete.enabled) confirming.delete(id);
    const isConfirming = confirming.has(id);
    const tabOnly = !meta.audio.micIncluded && meta.audio.deletedAt === undefined && view.audio !== 'None';

    patch(entry, 'date', view.date, () => [h('time', { datetime: new Date(meta.startedAt).toISOString() }, view.date)]);
    patch(entry, 'meeting', `${view.title}\n${view.meetCode}`, () => [
      h('span', { class: 'title' }, view.title),
      view.title !== view.meetCode ? h('span', { class: 'sub' }, view.meetCode) : null,
    ]);
    patch(entry, 'duration', view.duration, () => [view.duration]);
    patch(entry, 'audio', JSON.stringify([view.audio, view.audioNote, tabOnly]), () => [
      view.audio,
      view.audioNote ? h('span', { class: 'sub warn-text' }, view.audioNote) : null,
      tabOnly ? h('span', { class: 'sub' }, 'without your mic') : null,
    ]);
    patch(
      entry,
      'status',
      JSON.stringify([view.status, view.recovered, view.error, view.retry, view.captionsNote, view.notion, failure]),
      () => statusCell(view, failure),
    );
    patch(entry, 'route', JSON.stringify([routable, meta.route, choices.get(id), isPending, view.title]), () => [
      routable ? routePicker(meta, view.title) : view.route,
    ]);
    const anyway = !isConfirming && (actions.transcribe.force || actions.save.force) === true;
    patch(entry, 'actions', JSON.stringify([actions, isConfirming, view.title, meta.status, !!meta.notion]), () => [
      isConfirming
        ? confirmBox(meta)
        : h(
            'div',
            { class: 'actions' },
            ACTION_ORDER.filter((a) => actions[a].visible).map((a) => actionButton(meta, view.title, a, actions[a])),
          ),
      anyway ? h('p', { class: 'sub' }, ANYWAY_NOTE) : null,
    ]);
  }

  function renderNotice(d: DashboardData): void {
    const sig = JSON.stringify([d.missing, d.geminiKeyMissing]);
    if (sig === noticeSig) return;
    noticeSig = sig;
    const open = () =>
      h('button', { type: 'button', class: 'link', onclick: () => handlers.openSettings() }, 'Open settings');
    mount(
      noticeSlot,
      d.missing.length
        ? h(
            'div',
            { class: 'notice warn', 'data-role': 'missing' },
            h('span', null, `Saving to Notion needs: ${d.missing.join(', ')}.`),
            open(),
          )
        : null,
      d.geminiKeyMissing
        ? h(
            'div',
            { class: 'notice muted', 'data-role': 'no-gemini' },
            h('span', null, "No Gemini API key: transcripts come from Meet's captions only."),
            open(),
          )
        : null,
    );
  }

  function render(): void {
    const d = data;
    if (!d) return;
    renderAuto();
    keepFocus(root, () => {
      renderNotice(d);
      const summary = storageSummary(d.sessions, d.audioOnDisk, d.estimate);
      const usage = summary.usage ? ` · Browser storage: ${summary.usage}` : '';
      storage.textContent = `Audio on disk: ${summary.audio}${usage}`;

      const sessions = [...d.sessions].sort(compareSessions);
      const seen = new Set<string>();
      sessions.forEach((meta, index) => {
        seen.add(meta.id);
        let entry = rows.get(meta.id);
        if (!entry) {
          entry = newRow(meta.id);
          rows.set(meta.id, entry);
        }
        patchRow(entry, meta, d);
        const at = tbody.children[index] ?? null;
        if (at !== entry.tr) tbody.insertBefore(entry.tr, at);
      });
      for (const [id, entry] of rows) {
        if (seen.has(id)) continue;
        entry.tr.remove();
        rows.delete(id);
        confirming.delete(id);
        failures.delete(id);
      }
      table.hidden = sessions.length === 0;
      empty.hidden = sessions.length > 0;
    });
    if (focusNext) {
      root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusNext)}"]`)?.focus();
      focusNext = null;
    }
  }

  return {
    update(next) {
      data = next;
      // Settled: the stored setting is the truth again, whoever changed it last.
      if (!autoPending) autoChoice = undefined;
      render();
    },
  };
}
