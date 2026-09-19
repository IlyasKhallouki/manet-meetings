/**
 * The Team | Personal prompt, opened in a small window when a meeting ends.
 *
 *   Weekly product sync                          title, 17/600, up to 2 lines
 *   Today 14:02 · 32 min · Marie Curie, Tom…     the roll as byline, 13 --label-2
 *   Save this meeting to
 *   [ Team                 | Personal     ]      segmented, 48 px; the default is navy
 *   [ Shared with the team | Only you     ]      with a 3 px bar draining to 0
 *   Saving to Team in 42 s             Pause     role=timer · plain button (Esc)
 *
 * The default is applied when the countdown runs out; the background applies it too
 * (2 min after the call) if this window is closed or ignored. Pause (or Esc) sends
 * 'session/route-hold' so the background holds its alarm as well; closing a paused window
 * re-arms it (background, windows.onRemoved). T and P choose; arrow keys only move focus.
 * A choice shows as pressed ("✓ Personal") the moment it is sent, while the other segment
 * dims; once the background accepts it, it stays for CHOSEN_MS, then the window closes.
 * Paused or failed, the foot says when the background will still apply the default.
 */
import type { JobStage, Route, SessionMeta, SpeakerInfo } from '../types';
import { segmented, setSegmented, statusLine, button, type Tone } from './controls';
import { h, keepFocus, mount, type Child } from './dom';
import { svg } from './icons';
import { formatLength, whenText, type FormatOptions } from './sessionView';

export type { FormatOptions };

export const ROUTE_COUNTDOWN_MS = 60_000;
/** How long "✓ Team" shows before the window closes. */
export const CHOSEN_MS = 400;
/**
 * The background's own default: 2 min after the call (sessionManager ROUTE_DELAY_MS), or
 * 2 min after a paused window closes. Said in words when this window stops counting.
 */
const BACKGROUND_MINUTES = 2;

/** 'choose': waiting for a route. 'change': routed, still changeable. 'done': nothing to ask. */
export type RoutingMode = 'choose' | 'change' | 'done' | 'missing';

export function secondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function routingMode(meta: SessionMeta | null): RoutingMode {
  if (!meta) return 'missing';
  if (meta.status === 'awaiting-route') return 'choose';
  if (meta.status === 'ready' || meta.status === 'failed' || meta.status === 'processed') return 'change';
  return 'done';
}

// ---------------------------------------------------------------------------------------
// Words

const NBSP = '\u00a0';
const TASK = 'Choose Team or Personal';

const ROUTES: { value: Route; label: string; sub: string; key: string }[] = [
  { value: 'team', label: 'Team', sub: 'Shared with the team', key: 'T' },
  { value: 'personal', label: 'Personal', sub: 'Only you', key: 'P' },
];

function routeName(route: Route): string {
  return route === 'team' ? 'Team' : 'Personal';
}

function titleOf(meta: SessionMeta): string {
  return meta.meetingTitle?.trim() || meta.meetCode;
}

/** The window title names the task, then the meeting (modality.md › Best practices). */
export function routingTitle(meta: SessionMeta | null): string {
  return meta ? `${TASK}: ${titleOf(meta)}` : TASK;
}

/** Up to `max` names in order of first speech, the local user as "you", then "+N more". */
export function speakerNames(speakers: readonly SpeakerInfo[] | undefined, max = 3): string | null {
  const names = (speakers ?? []).map((s) => (s.self ? 'you' : s.name.trim())).filter(Boolean);
  if (names.length === 0) return null;
  const rest = names.length - max;
  return names.slice(0, max).join(', ') + (rest > 0 ? ` +${rest}${NBSP}more` : '');
}

/** "40 s", "32 min", "1 h 12 min" as Meetings writes a length, each number kept with its unit. */
export function shortDuration(ms: number): string {
  return formatLength(ms).replace(/(\d) /g, `$1${NBSP}`);
}

function durationOf(meta: SessionMeta): number | undefined {
  if (meta.durationMs !== undefined) return meta.durationMs;
  if (meta.endedAt !== undefined) return meta.endedAt - meta.startedAt;
  return undefined;
}

/** The byline's parts; `code` is the Meet code, set in mono like everywhere else. */
function bylineParts(meta: SessionMeta, now: number, opts: FormatOptions): { text: string; code?: boolean }[] {
  const duration = durationOf(meta);
  const names = speakerNames(meta.speakers);
  // The day and time exactly as Meetings and the popup write them: "Today 14:02", "Wed 16 Sep 14:02".
  const parts: { text: string; code?: boolean }[] = [{ text: whenText(meta.startedAt, now, opts) }];
  if (duration !== undefined) parts.push({ text: shortDuration(duration) });
  if (names) parts.push({ text: names });
  else if (titleOf(meta) !== meta.meetCode) parts.push({ text: meta.meetCode, code: true });
  return parts;
}

/**
 * "Today 14:02 · 32 min · Marie Curie, Tom Martin, you": the cue for a two-second choice.
 * Without speakers (captions were off), the Meet code, unless it already is the title.
 */
export function byline(meta: SessionMeta, now: number, opts: FormatOptions = {}): string {
  return bylineParts(meta, now, opts)
    .map((part) => part.text)
    .join(' · ');
}

/** Outer window height that fits `content` CSS px, given the frame Chrome draws. */
export function windowHeightFor(content: number, outerHeight: number, innerHeight: number): number {
  return Math.ceil(content) + (outerHeight - innerHeight);
}

const STAGE_WORD: Record<JobStage, string> = {
  'checking-duplicate': 'Starting',
  'loading-audio': 'Starting',
  'transcribing-timing': 'Transcribing',
  'transcribing-text': 'Transcribing',
  aligning: 'Transcribing',
  merging: 'Transcribing',
  summarizing: 'Summarizing',
  saving: 'Saving to Notion',
};

/** What is happening to a meeting that no longer needs a choice. */
function handledStatus(meta: SessionMeta): { tone: Tone; word: string; detail?: string } {
  const where = meta.route ? routeName(meta.route) : null;
  const inWhere = where ? ` in ${where}` : '';
  switch (meta.status) {
    case 'saved':
      return { tone: 'done', word: `Saved to Notion${inWhere}` };
    case 'duplicate':
      return { tone: 'done', word: `Saved by ${meta.notion?.recordedBy?.trim() || 'a teammate'}${inWhere}` };
    case 'saving':
      return { tone: 'working', word: `Saving to Notion${inWhere}` };
    case 'processing': {
      const word = meta.stage ? STAGE_WORD[meta.stage] : 'Starting';
      if (meta.stage === 'saving') return { tone: 'working', word: `${word}${inWhere}` };
      return { tone: 'working', word: where ? `${word}, then saving to ${where}` : word };
    }
    case 'empty':
      return { tone: 'none', word: 'Nothing to save', detail: 'No speech or captions were captured.' };
    case 'recording':
      return { tone: 'live', word: 'Recording' };
    default:
      return { tone: 'neutral', word: where ? `Saving to ${where}` : 'Not transcribed' };
  }
}

function changeMessage(meta: SessionMeta): string {
  const until = meta.status === 'ready' ? 'until transcribing starts' : 'until it’s saved';
  return meta.route ? `Saving to ${routeName(meta.route)}. You can change it ${until}.` : 'Choose where to save it.';
}

// ---------------------------------------------------------------------------------------
// View

export interface RoutingModel {
  /** Null when the session does not exist (deleted, or a stale window). */
  meta: SessionMeta | null;
  defaultRoute: Route;
  /** Epoch ms at which the default is applied. */
  deadline: number;
}

export interface RoutingHandlers {
  /** Sends the route to the background; rejects with a user-facing message. */
  choose(route: Route): Promise<void>;
  /** 'session/route-hold': true pauses the background's default-route alarm. */
  hold(hold: boolean): Promise<void>;
  /** Opens the meeting's Notion page. */
  open(url: string): void;
  close(): void;
}

export interface RoutingView {
  update(model: RoutingModel, now: number): void;
}

const TIMER_ID = 'route-countdown';
const QUESTION_ID = 'route-question';

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What Chrome says when the background can't take a message (asleep, reloaded, gone). */
const NO_ANSWER = /establish connection|receiving end|message port closed|context invalidated|no response|timed? ?out/i;

/**
 * People's words for a message the background didn't take; the raw text goes to the
 * console (writing.md › Getting started: plain language, no jargon).
 */
function failure(what: string, err: unknown): string {
  const raw = messageOf(err);
  console.warn(`[manet] Couldn’t ${what}:`, raw);
  return NO_ANSWER.test(raw) ? `Couldn’t ${what}. Manet Meetings didn’t respond.` : `Couldn’t ${what}.`;
}

export function createRoutingView(
  root: HTMLElement,
  handlers: RoutingHandlers,
  format: FormatOptions = {},
): RoutingView {
  const doc = root.ownerDocument;
  let model: RoutingModel | null = null;
  let now = 0;
  /** The route being sent. */
  let pending: Route | null = null;
  /** The route the background accepted: "✓ Team" until the window closes. */
  let chosen: Route | null = null;
  /** Set by the first choice (made or automatic) or a pause: the countdown never restarts. */
  let stopped = false;
  let paused = false;
  let focusedOnce = false;
  let error: string | undefined;
  let signature = '';

  function choose(route: Route): void {
    if (pending || chosen) return;
    stopped = true;
    pending = route;
    error = undefined;
    let promise: Promise<void>;
    try {
      promise = handlers.choose(route);
    } catch (err) {
      promise = Promise.reject(err);
    }
    render();
    // T or P chose the segment that isn't focused: focus follows, so ring and ✓ agree.
    const active = doc.activeElement;
    if (active instanceof HTMLElement && root.contains(active) && active.matches('.segment')) {
      root.querySelector<HTMLElement>(`.segment[data-value="${route}"]`)?.focus();
    }
    promise.then(
      () => {
        pending = null;
        chosen = route;
        render();
        setTimeout(() => handlers.close(), CHOSEN_MS);
      },
      (err: unknown) => {
        pending = null;
        // The next step is in the alert; the foot says what happens if there is none.
        error = `${failure(`save to ${routeName(route)}`, err)} Try again, or choose in Meetings.`;
        render();
      },
    );
  }

  function pause(): void {
    if (stopped || pending || chosen) return;
    stopped = true;
    paused = true;
    error = undefined;
    let promise: Promise<void>;
    try {
      promise = handlers.hold(true);
    } catch (err) {
      promise = Promise.reject(err);
    }
    render();
    promise.catch((err: unknown) => {
      // Not held: the background's default still applies, and the foot says when.
      paused = false;
      // A choice made meanwhile supersedes the pause; its own outcome is what to show.
      if (pending || chosen) return;
      error = failure('pause', err);
      render();
    });
  }

  function counting(m: RoutingModel): boolean {
    return routingMode(m.meta) === 'choose' && !stopped;
  }

  function countdownText(m: RoutingModel): string {
    return `Saving to ${routeName(m.defaultRoute)} in ${secondsLeft(m.deadline, now)}${NBSP}s`;
  }

  function header(meta: SessionMeta): HTMLElement {
    const title = titleOf(meta);
    const byParts: Child[] = [];
    for (const part of bylineParts(meta, now, format)) {
      if (byParts.length) byParts.push(' · ');
      byParts.push(part.code ? h('span', { class: 'mono' }, part.text) : part.text);
    }
    return h(
      'header',
      { class: 'route-head' },
      // Meet codes are set in the system mono, as in the popup and on Meetings (SPEC §2).
      h(
        'h1',
        { class: 'route-title t-title3', 'data-role': 'title' },
        title === meta.meetCode ? h('span', { class: 'mono' }, title) : title,
      ),
      // Not .num: Inter's tabular figures also widen hyphens ("Jean-Baptiste"), and nothing here ticks.
      h('p', { class: 'route-byline t-callout', 'data-role': 'meeting' }, byParts),
    );
  }

  /** The 3 px bar on the default: drains to 0 over what is left of the countdown. */
  function drain(m: RoutingModel): HTMLElement {
    const bar = h('span', { class: 'route-drain motion-only', 'aria-hidden': 'true' });
    const left = Math.max(0, m.deadline - now);
    bar.style.transform = `scaleX(${Math.min(1, left / ROUTE_COUNTDOWN_MS)})`;
    requestAnimationFrame(() => {
      if (!bar.isConnected) return;
      void bar.getBoundingClientRect(); // commit the start before transitioning from it
      bar.style.transition = `transform ${left}ms linear`;
      bar.style.transform = 'scaleX(0)';
    });
    return bar;
  }

  function choices(m: RoutingModel, meta: SessionMeta, mode: RoutingMode): HTMLElement {
    const inChoose = mode === 'choose';
    const group = segmented<Route>({
      labelledBy: QUESTION_ID,
      large: true,
      value: inChoose ? null : (meta.route ?? null),
      // Sending: busy (aria-busy + aria-disabled). Accepted: inert until the window closes.
      busy: pending !== null,
      disabled: chosen !== null,
      onSelect: (route) => choose(route),
      options: ROUTES.map((r) => ({
        value: r.value,
        label: r.label,
        sub: r.sub,
        shortcut: r.key,
        // segmented-controls.md › Desktop: a tooltip for each segment.
        attrs: { 'data-route': r.value, 'data-key': `route:${r.value}`, title: `Save to ${r.label} (${r.key})` },
      })),
      attrs: { class: 'route-choice' },
    });
    const shown = chosen ?? pending;
    for (const el of group.querySelectorAll<HTMLElement>('.segment')) {
      const route = el.dataset.value as Route;
      // The navy default only while nothing is chosen: once a choice is sent, the picture
      // shows that choice, not the default (segmented-controls.md › Best practices).
      if (inChoose && !shown && route === m.defaultRoute) {
        el.classList.add('is-default');
        if (counting(m)) {
          el.setAttribute('aria-describedby', TIMER_ID);
          el.append(drain(m));
        }
      }
      if (route === shown) el.classList.add('is-chosen');
    }
    // Pressed ("✓ Personal") from the moment it is sent, at full strength while the other
    // segment dims; the same look once accepted, so nothing changes before the window closes.
    if (shown) setSegmented(group, shown);
    return group;
  }

  function foot(m: RoutingModel, meta: SessionMeta, mode: RoutingMode): HTMLElement | null {
    const shown = chosen ?? pending;
    let content: Child[];
    if (shown) {
      // The same words while sending and once accepted: no reflow, no window resize.
      content = [h('p', { role: 'status' }, `Saving to ${routeName(shown)}.`)];
    } else if (mode === 'change') {
      content = [
        h('p', { 'data-role': 'message' }, changeMessage(meta)),
        button('Done', { kind: 'plain', onClick: () => handlers.close(), attrs: { 'data-key': 'done' } }),
      ];
    } else if (counting(m)) {
      content = [
        h('p', { id: TIMER_ID, class: 'num', role: 'timer', 'aria-live': 'off' }, countdownText(m)),
        button('Pause', {
          kind: 'plain',
          onClick: () => pause(),
          attrs: { 'data-key': 'pause', 'aria-keyshortcuts': 'Escape' },
        }),
      ];
    } else if (paused) {
      // Closing a paused window re-arms the background's default (windows.onRemoved).
      content = [
        h(
          'p',
          { 'data-role': 'message' },
          `Paused. Choose when you’re ready. If you close this window, it’s saved to ${routeName(m.defaultRoute)} ` +
            `${BACKGROUND_MINUTES}${NBSP}minutes later.`,
        ),
      ];
    } else if (mode === 'choose' && stopped) {
      // A choice or a pause that failed: this countdown stopped, the background's didn't
      // (feedback.md: say what happens when a command can't be carried out).
      content = [
        h(
          'p',
          { 'data-role': 'message' },
          `If you don’t choose, it’s saved to ${routeName(m.defaultRoute)} within ${BACKGROUND_MINUTES}${NBSP}minutes.`,
        ),
      ];
    } else {
      return null;
    }
    return h('footer', { class: 'route-foot', 'data-role': 'foot' }, content);
  }

  function alert(): HTMLElement | null {
    return error ? h('p', { class: 'route-error', role: 'alert' }, svg('caution'), h('span', null, error)) : null;
  }

  function content(m: RoutingModel, mode: RoutingMode): Child[] {
    const meta = m.meta;
    const close = () => button('Close', { onClick: () => handlers.close(), attrs: { 'data-key': 'close' } });
    if (!meta || mode === 'missing') {
      return [
        h('h1', { class: 'route-title t-title3', 'data-role': 'title' }, 'This meeting was deleted.'),
        h('div', { class: 'route-actions' }, close()),
      ];
    }
    if (mode === 'done') {
      const status = handledStatus(meta);
      const url = meta.notion && (meta.status === 'saved' || meta.status === 'duplicate') ? meta.notion.url : null;
      return [
        header(meta),
        statusLine({ ...status, attrs: { class: 'route-status', 'data-role': 'message' } }),
        h(
          'div',
          { class: 'route-actions' },
          url
            ? button('Open in Notion', {
                kind: 'prominent',
                onClick: () => handlers.open(url),
                attrs: { 'data-key': 'open' },
              })
            : null,
          close(),
        ),
      ];
    }
    return [
      header(meta),
      h(
        'section',
        { class: 'route-body' },
        h('p', { class: 'route-question t-callout', id: QUESTION_ID }, 'Save this meeting to'),
        choices(m, meta, mode),
        alert(),
      ),
      foot(m, meta, mode),
    ];
  }

  /** Where focus goes when the window opens, or when the focused control went away. */
  function focusTarget(m: RoutingModel, mode: RoutingMode): HTMLElement | null {
    const q = (sel: string) => root.querySelector<HTMLElement>(sel);
    if (mode === 'choose') return q('.segment.is-default') ?? q('.segment.is-chosen') ?? q('.segment');
    if (mode === 'change') return q('.segment[aria-pressed="true"]') ?? q(`[data-route="${m.defaultRoute}"]`);
    return q('.route-actions .btn');
  }

  function render(): void {
    const m = model;
    if (!m) return;
    const mode = routingMode(m.meta);
    const sig = JSON.stringify([m.meta, m.defaultRoute, mode, pending, chosen, stopped, paused, error]);
    doc.title = routingTitle(m.meta);
    if (sig === signature) {
      const timer = root.querySelector('[role="timer"]');
      if (timer) timer.textContent = countdownText(m);
      return;
    }
    signature = sig;
    const active = doc.activeElement;
    const hadFocus = active === doc.body || root.contains(active);
    keepFocus(root, () => mount(root, content(m, mode)));
    root.dataset.mode = mode;
    if (!focusedOnce || (hadFocus && !root.contains(doc.activeElement))) {
      focusedOnce = true;
      focusTarget(m, mode)?.focus();
    }
  }

  doc.addEventListener('keydown', (event) => {
    const m = model;
    if (!m || !root.isConnected || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const mode = routingMode(m.meta);
    if (mode !== 'choose' && mode !== 'change') return;
    if (event.key === 'Escape') {
      if (!counting(m)) return;
      event.preventDefault();
      pause();
      return;
    }
    const route = ROUTES.find((r) => r.key === event.key.toUpperCase())?.value;
    if (!route || event.repeat) return;
    event.preventDefault();
    choose(route);
  });

  return {
    update(next, at) {
      model = next;
      now = at;
      // Once "✓ Team" shows, storage updates (the meeting starts processing) wait for the close.
      if (chosen) return;
      if (counting(next) && !pending && at >= next.deadline) {
        choose(next.defaultRoute);
        return;
      }
      render();
    },
  };
}
