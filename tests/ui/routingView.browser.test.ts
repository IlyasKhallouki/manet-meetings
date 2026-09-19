import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Route, SessionMeta, SessionStatus } from '@lib/types';
import { createRoutingView, type RoutingHandlers, type RoutingModel } from '@lib/ui/routingView';
import { formatDateTime } from '@lib/ui/sessionView';

const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const T0 = Date.UTC(2026, 8, 19, 9, 0, 0);

function meta(status: SessionStatus, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    meetingTitle: 'Weekly sync',
    startedAt: T0 - 2_530_000,
    endedAt: T0,
    durationMs: 2_530_000,
    status,
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm', chunkCount: 5, bytes: 1000, micIncluded: true },
    captionCount: 3,
    ...patch,
  };
}

function handlers() {
  const chosen: Route[] = [];
  const settle: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let closed = 0;
  const h: RoutingHandlers = {
    choose: (route) =>
      new Promise<void>((resolve, reject) => {
        chosen.push(route);
        settle.push({ resolve, reject });
      }),
    close: () => {
      closed++;
    },
  };
  return { chosen, settle, handlers: h, closed: () => closed };
}

function model(patch: Partial<RoutingModel> = {}): RoutingModel {
  return { meta: meta('awaiting-route'), defaultRoute: 'team', deadline: T0 + 60_000, ...patch };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => root.remove());

const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const routeButton = (route: Route) => root.querySelector<HTMLButtonElement>(`button[data-route="${route}"]`);
const closeButton = () => [...root.querySelectorAll('button')].find((b) => text(b) === 'Close');

describe('routing prompt (real DOM)', () => {
  it('describes the meeting', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model(), T0);
    const info = text(root.querySelector('[data-role="meeting"]'));
    expect(info).toContain('Weekly sync');
    expect(info).toContain('abc-defg-hij');
    expect(info).toContain(formatDateTime(T0 - 2_530_000, FMT));
    expect(info).toContain('42m 10s');
  });

  it('highlights and focuses the default, and counts down to it', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model({ defaultRoute: 'personal' }), T0);
    expect(routeButton('personal')!.classList.contains('primary')).toBe(true);
    expect(routeButton('team')!.classList.contains('primary')).toBe(false);
    expect(text(routeButton('personal'))).toMatch(/default/);
    expect(document.activeElement).toBe(routeButton('personal'));
    const timer = root.querySelector('[role="timer"]')!;
    expect(text(timer)).toBe('Personal in 60 s');

    const team = routeButton('team');
    view.update(model({ defaultRoute: 'personal' }), T0 + 18_000);
    expect(text(root.querySelector('[role="timer"]'))).toBe('Personal in 42 s');
    // Ticks do not rebuild the buttons.
    expect(routeButton('team')).toBe(team);
  });

  it('sends the choice, then closes the window', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    routeButton('personal')!.click();
    expect(h.chosen).toEqual(['personal']);
    expect(routeButton('team')!.disabled).toBe(true);
    expect(routeButton('personal')!.disabled).toBe(true);
    // The countdown stops once a choice is made.
    view.update(model(), T0 + 61_000);
    expect(h.chosen).toEqual(['personal']);
    h.settle[0]!.resolve();
    await flush();
    expect(h.closed()).toBe(1);
  });

  it('applies the default exactly once when the countdown ends', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    view.update(model(), T0 + 59_999);
    expect(h.chosen).toEqual([]);
    view.update(model(), T0 + 60_000);
    view.update(model(), T0 + 61_000);
    expect(h.chosen).toEqual(['team']);
    h.settle[0]!.resolve();
    await flush();
    expect(h.closed()).toBe(1);
  });

  it('shows a failure, stops the countdown and lets the user try again', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    routeButton('team')!.click();
    h.settle[0]!.reject(new Error('Unknown session abc.'));
    await flush();
    expect(text(root.querySelector('[role="alert"]'))).toBe('Unknown session abc.');
    expect(h.closed()).toBe(0);
    expect(root.querySelector('[role="timer"]')).toBeNull();
    view.update(model(), T0 + 120_000);
    expect(h.chosen).toEqual(['team']);
    expect(routeButton('team')!.disabled).toBe(false);
    routeButton('personal')!.click();
    expect(h.chosen).toEqual(['team', 'personal']);
  });

  it('lets an already routed meeting change destination without a countdown', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: meta('ready', { route: 'team' }) }), T0);
    expect(text(root.querySelector('[data-role="message"]'))).toMatch(/Team/);
    expect(routeButton('team')!.getAttribute('aria-pressed')).toBe('true');
    expect(routeButton('personal')!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('[role="timer"]')).toBeNull();
    view.update(model({ meta: meta('ready', { route: 'team' }) }), T0 + 120_000);
    expect(h.chosen).toEqual([]);
    routeButton('personal')!.click();
    expect(h.chosen).toEqual(['personal']);
  });

  it('switches to a closing message when the background routes it meanwhile', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    view.update(model({ meta: meta('processing', { route: 'team' }) }), T0 + 5000);
    expect(routeButton('team')).toBeNull();
    expect(text(root.querySelector('[data-role="message"]'))).toMatch(/already/i);
    closeButton()!.click();
    expect(h.closed()).toBe(1);
    expect(h.chosen).toEqual([]);
  });

  it('handles a session that no longer exists', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: null }), T0);
    expect(text(root.querySelector('[data-role="message"]'))).toMatch(/no longer exists/);
    closeButton()!.click();
    expect(h.closed()).toBe(1);
  });
});
