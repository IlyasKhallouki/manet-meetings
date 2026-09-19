/**
 * The Meetings page: a "Needs you" group (only when something does), then one grouped
 * list per day, newest first. Each row: time · title + byline (the roll) · length ·
 * status (glyph + word, destination, detail) · one bordered next step + ⋯ menu.
 *
 * Data comes in through update(); requests go out through the handlers, so this module
 * needs no extension APIs and renders in any DOM.
 *
 * Rows are built once and patched in place: a recording row updates every second, and a
 * rebuilt button would lose a click between mousedown and mouseup, or keyboard focus.
 * The next-step button, the Team | Personal control and ⋯ are the same elements for the
 * life of a row. Pending controls are aria-disabled (never `disabled`), so focus stays on
 * them (review C4). When focus is lost anyway (a control hid, a row moved or went away),
 * it moves to the row, or after a delete to the next row's first control.
 */
import type { Route, SessionMeta } from '../types';
import { needsYou } from '../storage/sessionStore';
import { h, mount, type Child } from './dom';
import {
  button,
  callout,
  iconButton,
  note,
  segmented,
  setDisabled,
  setSegmented,
  statusLine,
  stepProgress,
  switchRow,
} from './controls';
import { svg } from './icons';
import { createMenu, menuButtonAttrs, menuButtonKeys, type MenuItem } from './menu';
import {
  compareSessions,
  dayLabel,
  dayNumber,
  defaultRouteText,
  routeChoice,
  rowActions,
  sessionRow,
  settingsList,
  shortDay,
  storageSummary,
  STEP_COUNT,
  whenText,
  type FormatOptions,
  type RowAction,
  type RowActions,
  type SessionRowView,
} from './sessionView';
import { firstMissingField, type FieldName } from './settingsForm';


export interface DashboardData {
  sessions: readonly SessionMeta[];
  /** Sessions with a stored transcript (Save needs one). */
  resultIds: ReadonlySet<string>;
  /** Committed audio bytes per session in OPFS; null when the scan failed. */
  audioOnDisk: ReadonlyMap<string, number> | null;
  /** Transcript attendees of older meetings recorded before speakers were kept (bylines). */
  attendees?: ReadonlyMap<string, readonly string[]>;
  /** Settings that block saving to Notion (missingForSave). */
  missing: readonly string[];
  /** No Gemini key: meetings are still saved, with a captions-only transcript. */
  geminiKeyMissing: boolean;
  /** Settings › Default destination: where a meeting goes if nobody chooses (when: the meta's routeDeadline). */
  defaultRoute?: Route;
  /** The auto-transcribe setting. */
  autoTranscribe: boolean;
  /** Days audio is kept after a meeting is saved (the storage footnote). */
  retentionDays: number;
  /** The toolbar button isn't pinned: the empty state says how to pin it. */
  pinHint?: boolean;
  now: number;
}

export interface DashboardHandlers {
  stop(sessionId: string): Promise<void>;
  /** `force` skips the Notion duplicate check (Save a second copy…). */
  transcribe(sessionId: string, opts: { force?: boolean }): Promise<void>;
  /** `force` saves despite an existing page (Save a second copy…). */
  save(sessionId: string, opts: { force?: boolean }): Promise<void>;
  remove(sessionId: string): Promise<void>;
  route(sessionId: string, route: Route): Promise<void>;
  setAutoTranscribe(on: boolean): Promise<void>;
  /** Opens Settings, on `field` when a specific setting needs fixing. */
  openSettings(field?: FieldName): void;
}

export interface DashboardView {
  update(data: DashboardData): void;
  /** Removes the page's menu and listeners (tests, hot reload). */
  destroy(): void;
}

const NEEDS_YOU = 'needs-you';

interface Confirmation {
  action: RowAction;
  pending: boolean;
}

interface RowEntry {
  id: string;
  li: HTMLLIElement;
  main: HTMLElement;
  confirm: HTMLElement;
  time: HTMLElement;
  name: HTMLElement;
  byline: HTMLElement;
  length: HTMLElement;
  head: HTMLElement;
  detail: HTMLElement;
  route: HTMLElement;
  segmented?: HTMLDivElement;
  routeNote: HTMLElement;
  progress: HTMLElement;
  progressBar?: HTMLProgressElement;
  progressText: HTMLElement;
  health: HTMLElement;
  extra: HTMLElement;
  open: HTMLAnchorElement;
  primary: HTMLButtonElement;
  more: HTMLButtonElement;
  sigs: Map<string, string>;
  /** Current state, read by the (long-lived) handlers. */
  meta: SessionMeta;
  view: SessionRowView;
  actions: RowActions;
}

interface SectionEntry {
  key: string;
  el: HTMLElement;
  header: HTMLElement;
  list: HTMLUListElement;
}

interface FocusMark {
  el: HTMLElement;
  key?: string;
  rowId?: string;
  order: string[];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

/** Lower-cases the first letter of a detail that follows "Team · ". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function visible(el: Element | null | undefined): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
}

/** ▲ + text: every caution line carries the glyph. */
function cautionLine(text: Child | Child[], attrs: Record<string, string> = {}): HTMLElement {
  return h('p', { class: 'meeting-caution', ...attrs }, svg('caution', { class: 'tone-caution' }), h('span', null, text));
}

/** “Weekly product sync”, a Meet code in mono. */
function quoted(view: SessionRowView): Child[] {
  return ['“', view.isCode ? h('span', { class: 'mono' }, view.title) : view.title, '”'];
}

let rowCount = 0;

export function createDashboardView(
  root: HTMLElement,
  handlers: DashboardHandlers,
  format: FormatOptions = {},
): DashboardView {
  const pending = new Set<string>();
  const confirming = new Map<string, Confirmation>();
  const failures = new Map<string, string>();
  /** The destination picked while its request is in flight, so the control doesn't snap back. */
  const choices = new Map<string, Route>();
  const rows = new Map<string, RowEntry>();
  const sections = new Map<string, SectionEntry>();
  /** Last status seen per meeting, to announce what finished while the page is open. */
  const lastStatus = new Map<string, SessionMeta['status']>();
  let order: string[] = [];
  let data: DashboardData | null = null;
  let focusNext: string | null = null;
  let noticeSig = '';
  /** The auto-transcribe value asked for, shown until the next update after its request. */
  let autoChoice: boolean | undefined;
  let autoPending = false;

  root.classList.add('meetings');

  // ---- Page-level pieces ------------------------------------------------------------

  const announcer = h('p', { class: 'visually-hidden', 'aria-live': 'polite', 'data-role': 'announcer' });
  const notices = h('div', { class: 'meetings-notices', hidden: true });

  const autoRow = switchRow({
    id: 'auto-transcribe',
    label: 'Transcribe automatically',
    hint: 'Each meeting is transcribed and saved to Notion after you choose Team or Personal.',
    checked: true,
    onChange: (on) => setAuto(on),
    attrs: { 'data-key': 'auto-transcribe' },
  });
  const autoSwitch = autoRow.querySelector<HTMLInputElement>('input.switch')!;
  const autoError = h('p', { class: 'meeting-caution meetings-auto-error', role: 'alert', hidden: true });
  const autoGroup = h(
    'div',
    { class: 'group meetings-auto', 'data-role': 'auto-transcribe' },
    h('div', { class: 'group-row' }, autoRow, autoError),
  );

  const sectionsEl = h('div', { class: 'meetings-sections' });
  const pinHint = h(
    'p',
    { class: 'meetings-empty-pin', hidden: true },
    'Pin it to the toolbar from Chrome’s Extensions menu so it’s one click away.',
  );
  const empty = h(
    'div',
    { class: 'group meetings-empty', 'data-role': 'empty', tabindex: '-1', hidden: true },
    h('h2', { class: 'meetings-empty-title' }, 'No meetings yet'),
    h('p', null, 'Join a Google Meet call, click Manet Meetings in the toolbar and choose Record this call.'),
    pinHint,
  );
  const footnote = h('p', { class: 'meetings-footnote', 'data-role': 'storage', hidden: true });

  mount(root, announcer, notices, autoGroup, sectionsEl, empty, footnote);
  // The one ⋯ menu, outside every patched row.
  const menu = createMenu(root);

  // ---- Auto-transcribe --------------------------------------------------------------

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
        mount(autoError, svg('caution', { class: 'tone-caution' }), h('span', null, errorMessage(err)));
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
    autoSwitch.checked = autoChoice ?? d.autoTranscribe;
    setDisabled(autoSwitch, autoPending);
  }

  // ---- Requests ---------------------------------------------------------------------

  function run(id: string, request: () => Promise<void>, onSettled?: (ok: boolean) => void): void {
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
      .then(
        () => onSettled?.(true),
        (err: unknown) => {
          failures.set(id, errorMessage(err));
          onSettled?.(false);
        },
      )
      .finally(() => {
        pending.delete(id);
        choices.delete(id);
        render();
      });
  }

  function perform(entry: RowEntry, action: RowAction): void {
    const id = entry.id;
    switch (action.kind) {
      case 'stop':
        run(id, () => handlers.stop(id));
        return;
      case 'transcribe':
        run(id, () => handlers.transcribe(id, {}));
        return;
      case 'save':
        run(id, () => handlers.save(id, {}));
        return;
      case 'reroute':
        run(id, async () => {
          await handlers.route(id, action.route!);
          await (action.then === 'save' ? handlers.save(id, {}) : handlers.transcribe(id, {}));
        });
        return;
      case 'delete':
      case 'second-copy':
        confirming.set(id, { action, pending: false });
        focusNext = `${id}:cancel`;
        render();
        return;
      case 'open':
        return; // a link
    }
  }

  function cancelConfirm(id: string): void {
    confirming.delete(id);
    focusNext = `${id}:more`;
    render();
  }

  function acceptConfirm(id: string): void {
    const c = confirming.get(id);
    if (!c || c.pending) return;
    c.pending = true;
    const { action } = c;
    const force = { force: true };
    const request =
      action.kind === 'delete'
        ? () => handlers.remove(id)
        : action.then === 'save'
          ? () => handlers.save(id, force)
          : () => handlers.transcribe(id, force);
    run(id, request, () => {
      confirming.delete(id);
      // Back to the ⋯ that asked, if focus is still on the question (a deleted row then
      // hands focus to its neighbour).
      const entry = rows.get(id);
      const active = document.activeElement;
      if (entry && (entry.confirm.contains(active) || active === document.body)) focusNext = `${id}:more`;
    });
  }

  function chooseRoute(entry: RowEntry, route: Route): void {
    const id = entry.id;
    const current = choices.get(id) ?? (routeChoice(entry.meta) === 'optional' ? entry.meta.route : undefined);
    if (current === route) return;
    choices.set(id, route);
    run(id, () => handlers.route(id, route));
  }

  // ---- Menu -------------------------------------------------------------------------

  function menuSignature(actions: RowActions): string {
    return JSON.stringify(actions.menu.map((a) => [a.kind, a.label, a.enabled, a.note ?? '']));
  }

  function menuItems(entry: RowEntry): MenuItem[] {
    return entry.actions.menu.map((action, i) => ({
      label: action.label,
      disabled: !action.enabled,
      note: action.note,
      separatorBefore: action.kind === 'delete' && i > 0,
      attrs: { 'data-key': `menu:${action.kind}` },
      onSelect: () => perform(entry, action),
    }));
  }

  function openMenu(entry: RowEntry, focus: 'first' | 'last' | 'menu'): void {
    menu.open(entry.more, menuItems(entry), {
      focus,
      signature: menuSignature(entry.actions),
      label: `More actions for ${entry.view.title}`,
    });
  }

  // ---- Rows -------------------------------------------------------------------------

  function newRow(meta: SessionMeta, view: SessionRowView, actions: RowActions): RowEntry {
    const id = meta.id;
    const titleId = `meeting-${++rowCount}`;
    const time = h('div', { class: 'meeting-time num', 'data-cell': 'time' });
    const name = h('h3', { class: 'meeting-name', id: titleId });
    const bylineEl = h('p', { class: 'meeting-byline' });
    const length = h('div', { class: 'meeting-length num', 'data-cell': 'duration' });
    const head = h('div', { class: 'meeting-head' });
    // The lines under the status word (.meeting-line): grid items of the row.
    const detail = h('p', { class: 'meeting-line status-detail meeting-detail', hidden: true });
    const route = h('div', { class: 'meeting-line meeting-route', hidden: true });
    const routeNote = h('p', {
      class: 'meeting-line status-detail meeting-route-note',
      'data-role': 'route-default',
      hidden: true,
    });
    const progressText = h('span', { class: 'meeting-step num' });
    const progress = h('div', { class: 'meeting-line status-detail meeting-progress', hidden: true }, progressText);
    // A recording's problems, apart from `extra`: they change with the clock, and a
    // re-mount there would re-announce a request's role=alert failure.
    // Its lines are rows of their own, so a detail can run on under the action column.
    const health = h('div', { class: 'meeting-health', hidden: true });
    const extra = h('div', { class: 'meeting-line status-detail meeting-extra', hidden: true });
    const open = h(
      'a',
      {
        class: 'btn meeting-open',
        target: '_blank',
        rel: 'noopener noreferrer',
        'data-key': `${id}:open`,
        'aria-describedby': titleId,
        hidden: true,
      },
      'Open in Notion',
    );
    // Created before the entry exists; the handlers read the entry when they run.
    let entry!: RowEntry;
    const primary = button('', {
      onClick: () => {
        const action = entry.actions.primary;
        if (action && action.kind !== 'open' && action.enabled) perform(entry, action);
      },
      class: 'meeting-primary',
      attrs: { 'data-key': `${id}:primary`, 'aria-describedby': titleId, hidden: true },
    });
    const more = iconButton('more', 'More actions', {
      tooltip: 'More actions',
      class: 'meeting-more',
      onClick: (event) => {
        if (menu.anchor === more) menu.close({ restoreFocus: true });
        else openMenu(entry, event.detail === 0 ? 'first' : 'menu');
      },
      attrs: { ...menuButtonAttrs(menu), 'data-key': `${id}:more` },
    });
    more.addEventListener('keydown', menuButtonKeys((focus) => openMenu(entry, focus)));

    const main = h(
      'div',
      { class: 'meeting-main' },
      time,
      h('div', { class: 'meeting-title', 'data-cell': 'meeting' }, name, bylineEl),
      length,
      h('div', { class: 'meeting-status', 'data-cell': 'status' }, head, detail, route, routeNote, progress, health, extra),
      h('div', { class: 'meeting-actions', 'data-cell': 'actions' }, open, primary, more),
    );
    const confirm = h('div', { class: 'meeting-confirm', hidden: true });
    const li = h('li', { class: 'group-row meeting', 'data-id': id, tabindex: '-1', 'aria-labelledby': titleId }, main, confirm);
    entry = {
      id,
      li,
      main,
      confirm,
      time,
      name,
      byline: bylineEl,
      length,
      head,
      detail,
      route,
      routeNote,
      progress,
      progressText,
      health,
      extra,
      open,
      primary,
      more,
      sigs: new Map(),
      meta,
      view,
      actions,
    };
    return entry;
  }

  function patch(entry: RowEntry, part: string, sig: unknown, apply: () => void): void {
    const s = JSON.stringify(sig);
    if (entry.sigs.get(part) === s) return;
    entry.sigs.set(part, s);
    apply();
  }

  /** "Settings" in an error is a link to Settings. */
  function withSettingsLink(text: string, id: string): Child[] {
    const at = text.lastIndexOf('Settings');
    if (at < 0) return [text];
    return [
      text.slice(0, at),
      button('Settings', {
        kind: 'link',
        // A rejected token is fixed in its field; other errors name what to change.
        onClick: () => handlers.openSettings(/\btoken\b/i.test(text) ? 'notionToken' : undefined),
        attrs: { 'data-key': `${id}:settings` },
      }),
      text.slice(at + 'Settings'.length),
    ];
  }

  function patchRow(entry: RowEntry, meta: SessionMeta, view: SessionRowView, actions: RowActions, d: DashboardData, inNeedsYou: boolean): void {
    const id = meta.id;
    entry.meta = meta;
    entry.view = view;
    entry.actions = actions;
    const isPending = pending.has(id);
    // The Needs you group isn't a day: its rows say which day ("Yesterday", "Wed 16 Sep").
    const dated = inNeedsYou;

    // Time (wide), with the day under it in the Needs you group.
    const date = dated ? shortDay(meta.startedAt, d.now, format) : '';
    patch(entry, 'time', [view.time, date], () =>
      mount(
        entry.time,
        h(
          'time',
          { datetime: new Date(meta.startedAt).toISOString() },
          view.time,
          date ? [' ', h('span', { class: 'meeting-date' }, date)] : null,
        ),
      ),
    );

    // Title + byline. Narrow layouts lead the byline with time and length.
    patch(entry, 'title', [view.title, view.isCode], () => {
      entry.name.textContent = view.title;
      entry.name.title = view.title;
      // A Meet code standing in for the title is set in mono, as everywhere else.
      entry.name.classList.toggle('mono', view.isCode);
      entry.more.setAttribute('aria-label', `More actions for ${view.title}`);
      entry.segmented?.setAttribute('aria-label', `Save “${view.title}” to`);
    });
    const when = [dated ? whenText(meta.startedAt, d.now, format) : view.time];
    // A recording's clock sits by its status word instead ("● Recording 23:12"): two
    // clock-like numbers in a row ("16:18 · 23:12") would read as a time range.
    const recording = meta.status === 'recording';
    if (view.length !== '—' && !recording) when.push(view.length);
    const b = view.byline;
    patch(entry, 'byline', [when, b], () => {
      const parts: Child[] = [b.names];
      if (b.code) parts.push(' · ', h('span', { class: 'mono meeting-code' }, b.code));
      if (b.audio) parts.push(` · ${b.audio}`);
      if (b.recovered) parts.push(' · Recovered after a restart');
      mount(entry.byline, h('span', { class: 'meeting-when num' }, `${when.join(' · ')} · `), parts);
      // The wide layout truncates the byline to one line; the tooltip has all of it.
      entry.byline.title = [b.names, b.code, b.audio, b.recovered ? 'Recovered after a restart' : null]
        .filter(Boolean)
        .join(' · ');
    });
    patch(entry, 'length', view.length, () => {
      entry.length.textContent = view.length;
    });

    // Status: glyph + word (+ the live clock where the length column is hidden).
    const clock = recording ? view.length : '';
    patch(entry, 'head', [view.status.tone, view.status.label, clock], () =>
      mount(
        entry.head,
        statusLine({
          tone: view.status.tone,
          word: clock ? [view.status.label, ' ', h('span', { class: 'meeting-clock num' }, clock)] : view.status.label,
        }),
      ),
    );

    // Destination (as text once it is on its way) + what is happening.
    const choice = routeChoice(meta);
    const showsRoute = !choice && meta.status !== 'recording' && meta.status !== 'empty';
    const detailParts = [showsRoute ? view.routeName : undefined, view.status.detail].filter(
      (x): x is string => Boolean(x),
    );
    const detailText = detailParts.map((p, i) => (i > 0 ? lowerFirst(p) : p)).join(' · ');
    patch(entry, 'detail', detailText, () => {
      entry.detail.textContent = detailText;
      entry.detail.hidden = detailText === '';
    });

    // Team | Personal: built once, patched in place so focus stays on the segment.
    if (choice && !entry.segmented) {
      entry.segmented = segmented<Route>({
        label: `Save “${view.title}” to`,
        options: [
          { value: 'team', label: 'Team', attrs: { 'data-key': `${id}:route-team`, title: 'Shared with the team' } },
          { value: 'personal', label: 'Personal', attrs: { 'data-key': `${id}:route-personal`, title: 'Only you' } },
        ],
        value: null,
        onSelect: (route) => chooseRoute(entry, route),
      });
      entry.route.append(entry.segmented);
    }
    if (entry.segmented) {
      const pressed = choices.get(id) ?? (choice === 'optional' ? (meta.route ?? null) : null);
      setSegmented(entry.segmented, choice ? pressed : null);
      for (const segment of entry.segmented.querySelectorAll('.segment')) setDisabled(segment, isPending);
    }
    entry.route.hidden = !choice;

    // Waiting for a destination: what happens if nobody chooses, and when (no time while paused).
    const routeNote =
      choice === 'required' && d.defaultRoute
        ? defaultRouteText(d.defaultRoute, meta.routeDeadline, format)
        : '';
    patch(entry, 'route-note', routeNote, () => {
      entry.routeNote.textContent = routeNote;
      entry.routeNote.hidden = routeNote === '';
    });

    // Step n of 8 · running for 3 min, over a determinate bar.
    const prog = view.progress;
    if (prog) {
      if (!entry.progressBar) {
        entry.progressBar = stepProgress(prog.step, STEP_COUNT);
        entry.progress.prepend(entry.progressBar);
      }
      entry.progressBar.value = Math.max(0, prog.step - 0.5);
      entry.progressBar.setAttribute('aria-label', `Step ${prog.step} of ${STEP_COUNT}`);
      const text = [`Step ${prog.step} of ${STEP_COUNT}`, prog.running].filter(Boolean).join(' · ');
      if (entry.progressText.textContent !== text) entry.progressText.textContent = text;
    }
    entry.progress.hidden = !prog;

    // A recording's problems: the popup's ▲ lines, with what they mean.
    patch(entry, 'health', view.cautions, () => {
      mount(
        entry.health,
        view.cautions.flatMap((c) => [
          cautionLine(c.text, { class: 'meeting-line meeting-caution', 'data-role': `${c.key}-warning` }),
          c.detail
            ? h('p', { class: 'meeting-line status-detail meeting-health-detail', 'data-role': `${c.key}-detail` }, c.detail)
            : null,
        ]),
      );
      entry.health.hidden = view.cautions.length === 0;
    });

    // Errors, retries, a failed request.
    const failure = failures.get(id);
    patch(entry, 'extra', [view.error, view.retry, failure], () => {
      const lines: Child[] = [
        view.error ? h('p', { class: 'meeting-error', 'data-role': 'error' }, withSettingsLink(view.error, id)) : null,
        view.retry ? h('p', { 'data-role': 'retry' }, view.retry) : null,
        failure ? cautionLine(failure, { role: 'alert' }) : null,
      ];
      mount(entry.extra, lines);
      entry.extra.hidden = !lines.some(Boolean);
    });

    // The one next step: a link to Notion, or a bordered button.
    const primary = actions.primary;
    const link = primary?.kind === 'open' ? primary.url : undefined;
    if (link) entry.open.href = link;
    entry.open.hidden = !link;
    const hasButton = primary !== null && primary.kind !== 'open';
    entry.primary.hidden = !hasButton;
    // Wide layout: the status lines may run on under the action column, which is empty
    // below its first line. Not the first line under a button: it would touch it.
    const health = entry.health.hidden ? [] : [...entry.health.children];
    const lines = [entry.detail, entry.route, entry.routeNote, entry.progress, ...health, entry.extra];
    const firstLine = lines.find((el) => !(el as HTMLElement).hidden);
    for (const el of lines) el.classList.toggle('is-under-button', primary !== null && el === firstLine);
    if (hasButton && entry.primary.textContent !== primary.label) entry.primary.textContent = primary.label;
    setDisabled(entry.primary, hasButton && !primary.enabled);

    // An open menu whose items went stale closes (focus goes back to ⋯).
    if (menu.anchor === entry.more && menu.signature !== menuSignature(actions)) menu.close();

    // Inline confirm: replaces the row's content.
    const c = confirming.get(id);
    patch(entry, 'confirm', c ? [c.action.kind, c.pending, meta.status, !!meta.notion, view.time, view.title] : null, () => {
      entry.li.classList.toggle('is-confirming', !!c);
      entry.main.hidden = !!c;
      entry.confirm.hidden = !c;
      if (!c) {
        entry.confirm.replaceChildren();
        return;
      }
      mount(entry.confirm, confirmContent(entry, c));
    });
  }

  /** The question names the meeting, so it reads on its own (and as the group's label). */
  function confirmContent(entry: RowEntry, c: Confirmation): Child[] {
    const { meta, id, view } = entry;
    const title = quoted(view);
    let question: Child[];
    let accept: string;
    if (c.action.kind === 'second-copy') {
      const who = meta.notion?.recordedBy?.trim() || 'A teammate';
      question = [`${who} already saved `, ...title, '. Saving yours adds a second page in Notion.'];
      accept = 'Save second copy';
    } else {
      question =
        meta.status === 'recording'
          ? ['Stop and delete ', ...title, '?']
          : ['Delete the recording, captions and transcript of ', ...title, '?', meta.notion ? ' The Notion page stays.' : ''];
      accept = 'Delete';
    }
    const questionId = `${entry.name.id}-confirm`;
    const cancel = button('Cancel', {
      disabled: c.pending,
      onClick: () => cancelConfirm(id),
      attrs: { 'data-key': `${id}:cancel` },
    });
    const ok = button(accept, {
      disabled: c.pending,
      onClick: () => acceptConfirm(id),
      attrs: { 'data-key': `${id}:confirm` },
    });
    const box = h(
      'div',
      {
        class: 'meeting-confirm-box',
        role: 'group',
        'aria-labelledby': questionId,
        onkeydown: (e: Event) => {
          if ((e as KeyboardEvent).key === 'Escape' && !c.pending) {
            e.preventDefault();
            cancelConfirm(id);
          }
        },
      },
      h('p', { class: 'meeting-question', id: questionId }, question),
      h('div', { class: 'meeting-confirm-buttons' }, cancel, ok),
    );
    return [h('div', { class: 'meeting-confirm-time num', 'aria-hidden': 'true' }, entry.view.time), box];
  }

  // ---- Sections ---------------------------------------------------------------------

  function section(key: string): SectionEntry {
    let s = sections.get(key);
    if (s) return s;
    const headerId = `meetings-${key}`;
    const header = h('h2', { class: 'section-header', id: headerId });
    const list = h('ul', { class: 'group meetings-list', role: 'list' });
    const el = h('section', { class: 'section', 'aria-labelledby': headerId, 'data-section': key }, header, list);
    s = { key, el, header, list };
    sections.set(key, s);
    return s;
  }

  // ---- Notices ------------------------------------------------------------------------

  function renderNotices(d: DashboardData): void {
    const sig = JSON.stringify([d.missing, d.geminiKeyMissing]);
    if (sig === noticeSig) return;
    noticeSig = sig;
    const openSettings = (label: string, key: string, field?: FieldName) =>
      button(label, { onClick: () => handlers.openSettings(field), attrs: { 'data-key': key } });
    mount(
      notices,
      d.missing.length
        ? callout({
            title: 'Meetings can’t be saved to Notion yet',
            body: `Add ${settingsList(d.missing)}.`,
            actions: openSettings('Open settings', 'notice:missing', firstMissingField(d.missing)),
            attrs: { 'data-role': 'missing' },
          })
        : null,
      // One notice at a time, as in the popup: the Gemini note only when saving works.
      d.geminiKeyMissing && d.missing.length === 0
        ? note({
            body: 'No Gemini key: transcripts will come from Meet’s captions only.',
            actions: openSettings('Add key', 'notice:gemini', 'geminiApiKey'),
            attrs: { 'data-role': 'no-gemini' },
          })
        : null,
    );
    notices.hidden = notices.childElementCount === 0;
  }

  // ---- Focus --------------------------------------------------------------------------

  function captureFocus(): FocusMark | null {
    let el = document.activeElement;
    // Focus in the menu belongs to its ⋯: if the menu closes and the row moves, go back there.
    if (menu.anchor && menu.element.contains(el)) el = menu.anchor;
    if (!(el instanceof HTMLElement) || !root.contains(el)) return null;
    const li = el.closest<HTMLElement>('li.meeting');
    const mark: FocusMark = { el, order };
    if (el.dataset.key) mark.key = el.dataset.key;
    if (li?.dataset.id) mark.rowId = li.dataset.id;
    return mark;
  }

  function firstControl(entry: RowEntry): HTMLElement | null {
    for (const el of entry.li.querySelectorAll<HTMLElement>('button, a[href], input')) if (visible(el)) return el;
    return null;
  }

  /**
   * Focus fell to <body> during render, or sits on a control that just hid (Chrome only
   * blurs it at the next frame): put it back where people can find it.
   */
  function restoreFocus(mark: FocusMark | null): void {
    if (!mark) return;
    const active = document.activeElement;
    if (active && active !== document.body && visible(active)) return;
    const focus = (el: HTMLElement) => el.focus({ preventScroll: true });
    if (visible(mark.el)) return focus(mark.el);
    if (mark.key) {
      const keyed = root.querySelector(`[data-key="${CSS.escape(mark.key)}"]`);
      if (visible(keyed)) return focus(keyed);
    }
    if (!mark.rowId) return;
    const entry = rows.get(mark.rowId);
    if (entry) return focus(entry.li);
    // The row went away (deleted): the next row's first control, else the previous row's.
    const at = mark.order.indexOf(mark.rowId);
    const candidates = [...mark.order.slice(at + 1), ...mark.order.slice(0, Math.max(0, at)).reverse()];
    for (const id of candidates) {
      const next = rows.get(id);
      if (next) return focus(firstControl(next) ?? next.li);
    }
    if (visible(empty)) focus(empty);
  }

  // ---- Announcements ------------------------------------------------------------------

  const FINISHED = new Set<SessionMeta['status']>(['processed', 'saved', 'duplicate', 'empty', 'failed']);

  function announce(messages: string[]): void {
    if (messages.length === 0) return;
    const text = messages.join(' ');
    // Clear first, so the same words twice are announced twice.
    announcer.textContent = '';
    setTimeout(() => {
      announcer.textContent = text;
    }, 50);
  }

  // ---- Render -------------------------------------------------------------------------

  function render(): void {
    const d = data;
    if (!d) return;
    const mark = captureFocus();
    renderAuto();
    renderNotices(d);

    const sorted = [...d.sessions].sort(compareSessions);
    const grouped = new Map<string, SessionMeta[]>();
    const add = (key: string, meta: SessionMeta) => {
      const list = grouped.get(key) ?? [];
      list.push(meta);
      grouped.set(key, list);
    };
    for (const meta of sorted) add(needsYou(meta) ? NEEDS_YOU : `day-${dayNumber(meta.startedAt, format)}`, meta);
    const keys = [...grouped.keys()].sort((a, b) => {
      if (a === NEEDS_YOU) return -1;
      if (b === NEEDS_YOU) return 1;
      return Number(b.slice(4)) - Number(a.slice(4));
    });

    const seen = new Set<string>();
    const messages: string[] = [];
    const nextOrder: string[] = [];
    keys.forEach((key, sectionIndex) => {
      const s = section(key);
      const metas = grouped.get(key)!;
      const header = key === NEEDS_YOU ? 'Needs you' : dayLabel(metas[0]!.startedAt, d.now, format);
      if (s.header.textContent !== header) s.header.textContent = header;
      if (sectionsEl.children[sectionIndex] !== s.el) sectionsEl.insertBefore(s.el, sectionsEl.children[sectionIndex] ?? null);
      metas.forEach((meta, index) => {
        const id = meta.id;
        seen.add(id);
        nextOrder.push(id);
        const hasResult = d.resultIds.has(id);
        const view = sessionRow(meta, {
          ...format,
          now: d.now,
          hasResult,
          audioBytes: d.audioOnDisk?.get(id),
          attendees: d.attendees?.get(id),
        });
        const actions = rowActions(meta, { hasResult, pending: pending.has(id) });
        // A job that started meanwhile cancels the question rather than leaving it for later.
        const c = confirming.get(id);
        if (c && !c.pending && !actions.menu.some((a) => a.kind === c.action.kind && a.enabled)) confirming.delete(id);
        let entry = rows.get(id);
        if (!entry) {
          entry = newRow(meta, view, actions);
          rows.set(id, entry);
        }
        patchRow(entry, meta, view, actions, d, key === NEEDS_YOU);
        if (s.list.children[index] !== entry.li) s.list.insertBefore(entry.li, s.list.children[index] ?? null);

        const before = lastStatus.get(id);
        if (before !== undefined && before !== meta.status && FINISHED.has(meta.status) && !FINISHED.has(before)) {
          messages.push(`${view.status.label}: ${view.title}.`);
        }
        lastStatus.set(id, meta.status);
      });
    });

    for (const [id, entry] of rows) {
      if (seen.has(id)) continue;
      if (menu.anchor === entry.more) menu.close();
      entry.li.remove();
      rows.delete(id);
      confirming.delete(id);
      failures.delete(id);
      lastStatus.delete(id);
    }
    for (const [key, s] of sections) {
      if (grouped.has(key)) continue;
      s.el.remove();
      sections.delete(key);
    }
    order = nextOrder;

    const hasMeetings = sorted.length > 0;
    sectionsEl.hidden = !hasMeetings;
    empty.hidden = hasMeetings;
    pinHint.hidden = d.pinHint !== true;
    footnote.hidden = !hasMeetings;
    if (hasMeetings) {
      const text = storageSummary(d.sessions, d.audioOnDisk, d.retentionDays).text;
      if (footnote.textContent !== text) footnote.textContent = text;
    }

    if (menu.anchor) menu.position();
    restoreFocus(mark);
    if (focusNext) {
      const target = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusNext)}"]`);
      focusNext = null;
      if (visible(target)) target.focus();
    }
    announce(messages);
  }

  return {
    update(next) {
      data = next;
      // Settled: the stored setting is the truth again, whoever changed it last.
      if (!autoPending) autoChoice = undefined;
      render();
    },
    destroy() {
      menu.destroy();
    },
  };
}
