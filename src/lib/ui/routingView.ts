/**
 * The Team | Personal prompt, opened in a small window when a meeting ends. The
 * settings default is applied when the countdown runs out; the background applies it
 * too (after 2 min) if this window is closed or ignored.
 */
import type { Route, SessionMeta } from '../types';
import { formatDuration } from '../util/time';
import { h, keepFocus, mount, type Child } from './dom';
import { formatDateTime, routeLabel, statusView, type FormatOptions } from './sessionView';

export const ROUTE_COUNTDOWN_MS = 60_000;

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
  close(): void;
}

export interface RoutingView {
  update(model: RoutingModel, now: number): void;
}

const ROUTES: Route[] = ['team', 'personal'];

export function createRoutingView(
  root: HTMLElement,
  handlers: RoutingHandlers,
  format: FormatOptions = {},
): RoutingView {
  let model: RoutingModel | null = null;
  let now = 0;
  let pending = false;
  /** Set by the first choice (made or automatic): the countdown never restarts. */
  let stopped = false;
  let focused = false;
  let error: string | undefined;
  let signature = '';

  function choose(route: Route): void {
    stopped = true;
    pending = true;
    error = undefined;
    let promise: Promise<void>;
    try {
      promise = handlers.choose(route);
    } catch (err) {
      promise = Promise.reject(err);
    }
    render();
    promise
      .then(() => handlers.close())
      .catch((err: unknown) => {
        error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        pending = false;
        render();
      });
  }

  function countdownText(m: RoutingModel): string {
    return `${routeLabel(m.defaultRoute)} in ${secondsLeft(m.deadline, now)} s`;
  }

  function meetingInfo(meta: SessionMeta): HTMLElement {
    const title = meta.meetingTitle?.trim() || meta.meetCode;
    const duration = meta.durationMs ?? (meta.endedAt === undefined ? undefined : meta.endedAt - meta.startedAt);
    return h(
      'div',
      { class: 'meeting-info', 'data-role': 'meeting' },
      h('p', { class: 'title' }, title),
      h(
        'p',
        { class: 'muted' },
        title === meta.meetCode ? null : [h('code', null, meta.meetCode), ' · '],
        formatDateTime(meta.startedAt, format),
        // Non-breaking space so the narrow prompt window never splits "32m 00s".
        duration === undefined ? null : ` · ${formatDuration(duration).replace(' ', '\u00a0')}`,
      ),
    );
  }

  function routeButtons(m: RoutingModel, meta: SessionMeta, mode: RoutingMode): HTMLElement {
    return h(
      'div',
      { class: 'route-buttons', role: 'group', 'aria-label': 'Destination' },
      ROUTES.map((route) =>
        h(
          'button',
          {
            type: 'button',
            class: mode === 'choose' && route === m.defaultRoute ? 'primary big' : 'big',
            'data-route': route,
            'data-key': `route:${route}`,
            'aria-pressed': mode === 'change' ? String(meta.route === route) : undefined,
            disabled: pending,
            onclick: () => choose(route),
          },
          routeLabel(route),
          route === m.defaultRoute ? h('span', { class: 'sub' }, 'default') : null,
        ),
      ),
    );
  }

  function content(m: RoutingModel, mode: RoutingMode): Child[] {
    const meta = m.meta;
    const close = h('button', { type: 'button', class: 'link', onclick: () => handlers.close() }, 'Close');
    if (!meta) return [h('p', { 'data-role': 'message' }, 'This recording no longer exists.'), close];
    const alert = error ? h('p', { class: 'error', role: 'alert' }, error) : null;
    switch (mode) {
      case 'choose':
        return [
          h('h1', null, 'Where should this meeting go?'),
          meetingInfo(meta),
          routeButtons(m, meta, mode),
          stopped
            ? null
            : h('p', { class: 'countdown muted', role: 'timer', 'aria-live': 'off' }, countdownText(m)),
          alert,
        ];
      case 'change':
        return [
          h('h1', null, 'Destination'),
          meetingInfo(meta),
          h(
            'p',
            { 'data-role': 'message' },
            meta.route ? `Going to ${routeLabel(meta.route)}. You can still change it.` : 'Choose a destination.',
          ),
          routeButtons(m, meta, mode),
          alert,
          close,
        ];
      default: {
        const where = meta.route ? ` (${routeLabel(meta.route)})` : '';
        return [
          h('h1', null, 'Destination'),
          meetingInfo(meta),
          h('p', { 'data-role': 'message' }, `Already handled: ${statusView(meta).label}${where}.`),
          close,
        ];
      }
    }
  }

  function render(): void {
    const m = model;
    if (!m) return;
    const mode = routingMode(m.meta);
    const sig = JSON.stringify([m.meta, m.defaultRoute, mode, pending, stopped, error]);
    if (sig === signature) {
      const timer = root.querySelector('[role="timer"]');
      if (timer) timer.textContent = countdownText(m);
      return;
    }
    signature = sig;
    keepFocus(root, () => mount(root, content(m, mode)));
    if (mode === 'choose' && !focused) {
      focused = true;
      root.querySelector<HTMLElement>(`[data-route="${m.defaultRoute}"]`)?.focus();
    }
  }

  return {
    update(next, at) {
      model = next;
      now = at;
      if (routingMode(next.meta) === 'choose' && !stopped && !pending && at >= next.deadline) {
        choose(next.defaultRoute);
        return;
      }
      render();
    },
  };
}
