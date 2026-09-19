import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Route, SessionMeta, SessionStatus, SpeakerInfo } from '@lib/types';
import { CHOSEN_MS, createRoutingView, type RoutingHandlers, type RoutingModel } from '@lib/ui/routingView';

const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const T0 = Date.UTC(2026, 8, 19, 9, 0, 0);

function speaker(name: string, firstAt: number, self = false): SpeakerInfo {
  return { name, self, firstAt, lastAt: firstAt + 1000, talkMs: 1000 };
}

function meta(status: SessionStatus, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    meetingTitle: 'Weekly sync',
    startedAt: T0 - 32 * 60_000,
    endedAt: T0,
    durationMs: 32 * 60_000,
    status,
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm', chunkCount: 5, bytes: 1000, micIncluded: true },
    captionCount: 3,
    speakers: [speaker('Marie Curie', 0), speaker('Tom Martin', 4000), speaker('Ilyas', 9000, true)],
    ...patch,
  };
}

function handlers() {
  const chosen: Route[] = [];
  const holds: boolean[] = [];
  const opened: string[] = [];
  const settle: { resolve: () => void; reject: (e: Error) => void }[] = [];
  let holdResult: Promise<void> = Promise.resolve();
  let closed = 0;
  const h: RoutingHandlers = {
    choose: (route) =>
      new Promise<void>((resolve, reject) => {
        chosen.push(route);
        settle.push({ resolve, reject });
      }),
    hold: (hold) => {
      holds.push(hold);
      return holdResult;
    },
    open: (url) => void opened.push(url),
    close: () => {
      closed++;
    },
  };
  return {
    chosen,
    holds,
    opened,
    settle,
    handlers: h,
    closed: () => closed,
    failHold: (message: string) => {
      holdResult = Promise.reject(new Error(message));
    },
  };
}

function model(patch: Partial<RoutingModel> = {}): RoutingModel {
  return { meta: meta('awaiting-route'), defaultRoute: 'team', deadline: T0 + 60_000, ...patch };
}

let root: HTMLElement;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = document.createElement('main');
  document.body.append(root);
  // Raw failure reasons go to the console, not the window.
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  root.remove();
  document.title = '';
  warn.mockRestore();
});

const PAUSED = 'Paused. Choose when you’re ready. If you close this window, it’s saved to Team 2 minutes later.';
const flush = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const segment = (route: Route) => root.querySelector<HTMLButtonElement>(`button[data-route="${route}"]`);
const button = (label: string) => [...root.querySelectorAll('button')].find((b) => text(b) === label);
const timer = () => root.querySelector('[role="timer"]');
const foot = () => text(root.querySelector('[data-role="foot"]'));
const key = (k: string, init: KeyboardEventInit = {}) =>
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

describe('routing prompt: choose', () => {
  it('names the meeting, when it was, how long, and who spoke', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model(), T0 + 1000);
    expect(text(root.querySelector('h1'))).toBe('Weekly sync');
    expect(text(root.querySelector('[data-role="meeting"]'))).toBe(
      'Today 08:28 · 32 min · Marie Curie, Tom Martin, you',
    );
    expect(document.title).toBe('Choose Team or Personal: Weekly sync');
  });

  it('asks where to save it, with the audience under each choice', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model(), T0);
    const group = root.querySelector('[role="group"]')!;
    expect(text(document.getElementById(group.getAttribute('aria-labelledby')!))).toBe('Save this meeting to');
    const parts = (route: Route) =>
      [...segment(route)!.querySelectorAll('.segment-label, .segment-sub')].map((el) => text(el));
    expect(parts('team')).toEqual(['Team', 'Shared with the team']);
    expect(parts('personal')).toEqual(['Personal', 'Only you']);
    expect(segment('team')!.getAttribute('aria-keyshortcuts')).toBe('T');
    expect(segment('personal')!.getAttribute('aria-keyshortcuts')).toBe('P');
    // Nothing is chosen yet: both unpressed; "default" is never a label.
    expect(segment('team')!.getAttribute('aria-pressed')).toBe('false');
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('false');
    expect(text(root)).not.toMatch(/default/i);
  });

  it('marks and focuses the default, and counts down to it on the default itself', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model({ defaultRoute: 'personal' }), T0);
    expect(segment('personal')!.classList.contains('is-default')).toBe(true);
    expect(segment('team')!.classList.contains('is-default')).toBe(false);
    expect(document.activeElement).toBe(segment('personal'));
    expect(text(timer())).toBe('Saving to Personal in 60 s');
    expect(timer()!.getAttribute('aria-live')).toBe('off');
    // The countdown describes the default for screen readers.
    expect(segment('personal')!.getAttribute('aria-describedby')).toBe(timer()!.id);
    // The drain bar lives in the default and is decoration only.
    const drain = segment('personal')!.querySelector('.route-drain')!;
    expect(drain.classList.contains('motion-only')).toBe(true);
    expect(drain.getAttribute('aria-hidden')).toBe('true');
    expect(segment('team')!.querySelector('.route-drain')).toBeNull();

    const team = segment('team');
    view.update(model({ defaultRoute: 'personal' }), T0 + 18_000);
    expect(text(timer())).toBe('Saving to Personal in 42 s');
    // Ticks do not rebuild the buttons.
    expect(segment('team')).toBe(team);
  });

  it('sends the choice, shows "✓ Team" for 400 ms, then closes', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    segment('personal')!.click();
    expect(h.chosen).toEqual(['personal']);
    // Sending: the picture shows the choice, not the default. Personal is pressed
    // ("✓ Personal") and nothing keeps the navy default fill.
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('true');
    expect(segment('personal')!.classList.contains('is-chosen')).toBe(true);
    expect(segment('team')!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.is-default')).toBeNull();
    expect(root.querySelector('.route-drain')).toBeNull();
    expect(foot()).toBe('Saving to Personal.');
    // Pending: both inert but still focusable, focus kept.
    segment('personal')!.focus();
    expect(segment('team')!.getAttribute('aria-disabled')).toBe('true');
    expect(segment('personal')!.getAttribute('aria-disabled')).toBe('true');
    expect(segment('personal')!.getAttribute('aria-busy')).toBe('true');
    expect(segment('personal')!.disabled).toBe(false);
    segment('team')!.click();
    expect(h.chosen).toEqual(['personal']);
    // The countdown stops once a choice is made.
    view.update(model(), T0 + 61_000);
    expect(h.chosen).toEqual(['personal']);
    expect(timer()).toBeNull();

    h.settle[0]!.resolve();
    await flush();
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('true');
    expect(segment('personal')!.classList.contains('is-default')).toBe(false);
    // Accepted: no longer busy, still inert until the window closes.
    expect(segment('personal')!.hasAttribute('aria-busy')).toBe(false);
    expect(segment('team')!.getAttribute('aria-disabled')).toBe('true');
    expect(foot()).toBe('Saving to Personal.');
    expect(root.querySelector('[data-role="foot"] [role="status"]')).not.toBeNull();
    expect(document.activeElement).toBe(segment('personal'));
    // Storage updates while the confirmation shows don't replace it.
    view.update(model({ meta: meta('processing', { route: 'personal' }) }), T0 + 62_000);
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('true');
    expect(h.closed()).toBe(0);
    await wait(CHOSEN_MS + 50);
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
    await wait(CHOSEN_MS + 50);
    expect(h.closed()).toBe(1);
  });

  it('shows a failure with ▲ under the choices, stops the countdown and lets the user try again', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    segment('team')!.click();
    h.settle[0]!.reject(new Error('Unknown session abc.'));
    await flush();
    const alert = root.querySelector('[role="alert"]')!;
    // People's words and the next step; the raw reason only in the console.
    expect(text(alert)).toBe('Couldn’t save to Team. Try again, or choose in Meetings.');
    expect(warn).toHaveBeenCalledWith(expect.any(String), 'Unknown session abc.');
    expect(alert.querySelector('.glyph-caution')).not.toBeNull();
    expect(h.closed()).toBe(0);
    expect(timer()).toBeNull();
    // Nothing is pressed any more; the default is back, without its countdown.
    expect(segment('team')!.getAttribute('aria-pressed')).toBe('false');
    expect(segment('team')!.classList.contains('is-default')).toBe(true);
    expect(root.querySelector('.route-drain')).toBeNull();
    // The window stopped counting, the background didn't: say so.
    expect(foot()).toBe('If you don’t choose, it’s saved to Team within 2 minutes.');
    view.update(model(), T0 + 120_000);
    expect(h.chosen).toEqual(['team']);
    expect(segment('team')!.hasAttribute('aria-disabled')).toBe(false);
    segment('personal')!.click();
    expect(h.chosen).toEqual(['team', 'personal']);
  });

  it('says Manet Meetings didn’t respond instead of Chrome’s connection error', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ defaultRoute: 'personal' }), T0);
    segment('team')!.click();
    h.settle[0]!.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    await flush();
    expect(text(root.querySelector('[role="alert"]'))).toBe(
      'Couldn’t save to Team. Manet Meetings didn’t respond. Try again, or choose in Meetings.',
    );
    expect(text(root)).not.toMatch(/Receiving end/);
    // The fallback names the default, not the choice that failed.
    expect(foot()).toBe('If you don’t choose, it’s saved to Personal within 2 minutes.');
  });

  it('shows the pending choice pressed even when it is the default', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    key('t');
    expect(h.chosen).toEqual(['team']);
    expect(segment('team')!.getAttribute('aria-pressed')).toBe('true');
    expect(segment('team')!.classList.contains('is-default')).toBe(false);
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.is-default')).toBeNull();
  });

  it('sets a Meet code title and byline in mono', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    view.update(model({ meta: meta('awaiting-route', { meetingTitle: undefined, speakers: undefined }) }), T0);
    const title = root.querySelector('h1')!;
    expect(text(title)).toBe('abc-defg-hij');
    expect(title.querySelector('.mono')?.textContent).toBe('abc-defg-hij');
    // The title already is the code: the byline doesn't repeat it.
    expect(root.querySelector('[data-role="meeting"] .mono')).toBeNull();

    view.update(model({ meta: meta('awaiting-route', { speakers: undefined }) }), T0);
    expect(root.querySelector('h1 .mono')).toBeNull();
    const code = root.querySelector('[data-role="meeting"] .mono');
    expect(code?.textContent).toBe('abc-defg-hij');
    expect(text(root.querySelector('[data-role="meeting"]'))).toBe('Today 08:28 · 32 min · abc-defg-hij');
  });
});

describe('routing prompt: pause', () => {
  it('Pause holds the default in the background and stops the countdown', async () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    const pause = button('Pause')!;
    expect(pause.getAttribute('aria-keyshortcuts')).toBe('Escape');
    pause.focus();
    pause.click();
    expect(h.holds).toEqual([true]);
    expect(timer()).toBeNull();
    expect(button('Pause')).toBeUndefined();
    // Closing a paused window re-arms the background's default: the window says so.
    expect(foot()).toBe(PAUSED);
    expect(root.querySelector('.route-drain')).toBeNull();
    // Same buttons: the default keeps its fill, and focus moves to it (Pause is gone).
    expect(segment('team')!.classList.contains('is-default')).toBe(true);
    expect(document.activeElement).toBe(segment('team'));
    // The deadline no longer applies.
    view.update(model(), T0 + 120_000);
    await flush();
    expect(h.chosen).toEqual([]);
    segment('personal')!.click();
    expect(h.chosen).toEqual(['personal']);
  });

  it('Esc pauses too, once', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    key('Escape');
    expect(h.holds).toEqual([true]);
    expect(foot()).toBe(PAUSED);
    key('Escape');
    expect(h.holds).toEqual([true]);
  });

  it('says so when the pause could not be sent, and that the default still applies', async () => {
    const h = handlers();
    h.failHold('Extension context invalidated.');
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    button('Pause')!.click();
    await flush();
    await flush();
    expect(text(root.querySelector('[role="alert"]'))).toBe('Couldn’t pause. Manet Meetings didn’t respond.');
    // Not held in the background, so not "Paused": the background's default is still due.
    expect(foot()).toBe('If you don’t choose, it’s saved to Team within 2 minutes.');
    expect(timer()).toBeNull();
  });
});

describe('routing prompt: keyboard', () => {
  it('T and P choose; arrow keys only move focus', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    expect(document.activeElement).toBe(segment('team'));
    key('ArrowRight');
    expect(document.activeElement).toBe(segment('personal'));
    key('ArrowLeft');
    expect(document.activeElement).toBe(segment('team'));
    expect(h.chosen).toEqual([]);
    // Shortcuts with a modifier belong to the browser.
    key('p', { ctrlKey: true });
    key('t', { metaKey: true });
    expect(h.chosen).toEqual([]);
    key('p');
    expect(h.chosen).toEqual(['personal']);
    // Focus follows the shortcut, so the ring sits on "✓ Personal", not on Team.
    expect(document.activeElement).toBe(segment('personal'));
    // Pending: further shortcuts do nothing.
    key('t');
    expect(h.chosen).toEqual(['personal']);
  });

  it('T works while paused', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    key('Escape');
    key('T');
    expect(h.chosen).toEqual(['team']);
  });
});

describe('routing prompt: other states', () => {
  it('lets an already routed meeting change destination, without a countdown', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: meta('ready', { route: 'team' }) }), T0);
    expect(foot()).toMatch(/^Saving to Team\. You can change it until transcribing starts\./);
    expect(segment('team')!.getAttribute('aria-pressed')).toBe('true');
    expect(segment('personal')!.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('.is-default')).toBeNull();
    expect(timer()).toBeNull();
    expect(document.activeElement).toBe(segment('team'));
    view.update(model({ meta: meta('ready', { route: 'team' }) }), T0 + 120_000);
    expect(h.chosen).toEqual([]);
    segment('personal')!.click();
    expect(h.chosen).toEqual(['personal']);
  });

  it('Done closes the change prompt without sending anything', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: meta('processed', { route: 'personal' }) }), T0);
    expect(foot()).toMatch(/^Saving to Personal\. You can change it until it’s saved\./);
    button('Done')!.click();
    expect(h.closed()).toBe(1);
    expect(h.chosen).toEqual([]);
  });

  it('switches to what is happening when the background routes it meanwhile', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model(), T0);
    expect(document.activeElement).toBe(segment('team'));
    view.update(model({ meta: meta('processing', { route: 'team', stage: 'transcribing-text' }) }), T0 + 5000);
    expect(segment('team')).toBeNull();
    const status = root.querySelector('.status-line')!;
    expect(status.getAttribute('data-tone')).toBe('working');
    expect(text(status)).toBe('Transcribing, then saving to Team');
    // Focus lost with the buttons lands on the one action left.
    expect(document.activeElement).toBe(button('Close'));
    button('Close')!.click();
    expect(h.closed()).toBe(1);
    expect(h.chosen).toEqual([]);
  });

  it('offers the Notion page once saved', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    const url = 'https://www.notion.so/p1';
    view.update(model({ meta: meta('saved', { route: 'team', notion: { pageId: 'p1', url } }) }), T0);
    expect(text(root.querySelector('.status-line'))).toBe('Saved to Notion in Team');
    expect(root.querySelector('.status-line')!.getAttribute('data-tone')).toBe('done');
    const open = button('Open in Notion')!;
    expect(open.classList.contains('prominent')).toBe(true);
    open.click();
    expect(h.opened).toEqual([url]);
    expect(button('Close')).toBeDefined();
  });

  it('names the teammate who already saved it', () => {
    const view = createRoutingView(root, handlers().handlers, FMT);
    const notion = { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Marie' };
    view.update(model({ meta: meta('duplicate', { route: 'team', notion }) }), T0);
    expect(text(root.querySelector('.status-line'))).toBe('Saved by Marie in Team');
  });

  it('handles a meeting that no longer exists', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: null }), T0);
    expect(text(root.querySelector('h1'))).toBe('This meeting was deleted.');
    expect(document.title).toBe('Choose Team or Personal');
    button('Close')!.click();
    expect(h.closed()).toBe(1);
  });

  it('ignores T, P and Esc when there is nothing to choose', () => {
    const h = handlers();
    const view = createRoutingView(root, h.handlers, FMT);
    view.update(model({ meta: meta('saving', { route: 'team' }) }), T0);
    key('t');
    key('Escape');
    expect(h.chosen).toEqual([]);
    expect(h.holds).toEqual([]);
  });
});
