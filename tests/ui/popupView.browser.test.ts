import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPopupView, micView, type PopupHandlers, type PopupModel } from '@lib/ui/popupView';

const T0 = Date.UTC(2026, 8, 19, 8, 0, 0);

function handlers() {
  const calls: string[] = [];
  const settle: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const deferred = (name: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push(name);
      settle.push({ resolve, reject });
    });
  const h: PopupHandlers = {
    record: (tabId) => deferred(`record:${tabId}`),
    stop: (id) => deferred(`stop:${id}`),
    grantMic: () => void calls.push('grantMic'),
    openSettings: () => void calls.push('openSettings'),
    openDashboard: () => void calls.push('openDashboard'),
  };
  return { calls, settle, handlers: h };
}

function model(patch: Partial<PopupModel> = {}): PopupModel {
  return {
    state: { kind: 'idle', tabId: 7, meetCode: 'abc-defg-hij' },
    mic: micView('granted', true),
    missing: [],
    geminiKeyMissing: false,
    ...patch,
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});
afterEach(() => root.remove());

const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (label: string | RegExp) =>
  [...root.querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? text(b) === label : label.test(text(b)),
  );

describe('popup view (real DOM)', () => {
  it('shows a loading state before the first model', () => {
    createPopupView(root, handlers().handlers);
    expect(text(root.querySelector('[data-role="state"]'))).toMatch(/Loading/);
  });

  it('explains what to do away from a call', () => {
    const view = createPopupView(root, handlers().handlers);
    view.update(model({ state: { kind: 'not-meet', onMeet: false } }), T0);
    expect(text(root.querySelector('[data-role="state"]'))).toMatch(/Open a Google Meet call/);
    expect(button('Record')).toBeUndefined();
    view.update(model({ state: { kind: 'not-meet', onMeet: true } }), T0);
    expect(text(root.querySelector('[data-role="state"]'))).toMatch(/Join the call/);
  });

  it('records the call tab and shows progress and errors', async () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    view.update(model(), T0);
    expect(text(root.querySelector('[data-role="state"]'))).toContain('abc-defg-hij');
    button('Record')!.click();
    expect(h.calls).toEqual(['record:7']);
    expect(button('Starting…')?.disabled).toBe(true);
    h.settle[0]!.reject(new Error('Another tab is already recording.'));
    await flush();
    expect(text(root.querySelector('[role="alert"]'))).toBe('Another tab is already recording.');
    expect(button('Record')?.disabled).toBe(false);
  });

  it('shows the running recording with a live clock and a Stop button', async () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    const recording = model({
      state: {
        kind: 'recording',
        sessionId: 's1',
        startedAt: T0,
        meetCode: 'abc-defg-hij',
        title: 'Weekly sync',
        thisTab: true,
        captionCount: 4,
      },
    });
    view.update(recording, T0 + 65_000);
    expect(text(root.querySelector('[role="timer"]'))).toBe('00:01:05');
    expect(text(root.querySelector('[data-role="state"]'))).toContain('Weekly sync');
    const stop = button('Stop recording')!;

    // A clock tick touches only the clock, so a click in progress is not lost.
    view.update(recording, T0 + 3_725_000);
    expect(text(root.querySelector('[role="timer"]'))).toBe('01:02:05');
    expect(button('Stop recording')).toBe(stop);

    stop.click();
    expect(h.calls).toEqual(['stop:s1']);
    expect(button('Stopping…')?.disabled).toBe(true);
    h.settle[0]!.resolve();
    await flush();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('says when the recording is in another tab or has no audio', () => {
    const view = createPopupView(root, handlers().handlers);
    view.update(
      model({
        state: {
          kind: 'recording',
          sessionId: 's1',
          startedAt: T0,
          meetCode: 'abc-defg-hij',
          thisTab: false,
          audioError: 'Tab capture failed',
          captionCount: 2,
        },
      }),
      T0,
    );
    const state = text(root.querySelector('[data-role="state"]'));
    expect(state).toMatch(/another tab/);
    expect(state).toMatch(/No audio: Tab capture failed/);
    expect(state).toMatch(/captions are still recorded/i);
  });

  it('offers the mic permission page when the mic is not allowed', () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    view.update(model({ mic: micView('prompt', true) }), T0);
    const mic = root.querySelector('[data-role="mic"]')!;
    expect(mic.classList.contains('warn')).toBe(true);
    button('Allow microphone')!.click();
    expect(h.calls).toEqual(['grantMic']);

    view.update(model({ mic: micView('granted', true) }), T0);
    expect(button('Allow microphone')).toBeUndefined();
  });

  it('asks to turn captions on when none arrived 20 s into the recording', () => {
    const view = createPopupView(root, handlers().handlers);
    const state = {
      kind: 'recording',
      sessionId: 's1',
      startedAt: T0,
      meetCode: 'abc-defg-hij',
      thisTab: true,
      captionCount: 0,
    } as const;
    const recording = model({ state });
    const notice = () => root.querySelector('[data-role="captions"]');
    view.update(recording, T0 + 10_000);
    expect(notice()).toBeNull();
    const stop = button('Stop recording');
    // Only the clock moves in between: the notice still has to appear.
    view.update(recording, T0 + 21_000);
    expect(text(notice())).toBe('No captions yet — make sure captions are on (CC) so speakers are identified.');
    expect(notice()!.classList.contains('warn')).toBe(true);
    expect(button('Stop recording')).toBe(stop);

    const captioned = model({ state: { ...state, captionCount: 1 } });
    view.update(captioned, T0 + 22_000);
    expect(notice()).toBeNull();
  });

  it('says why captions are not coming through', () => {
    const view = createPopupView(root, handlers().handlers);
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    view.update(
      model({
        state: {
          kind: 'recording',
          sessionId: 's1',
          startedAt: T0,
          meetCode: 'abc-defg-hij',
          thisTab: true,
          captionCount: 0,
          captionsError: why,
        },
      }),
      T0 + 3000,
    );
    expect(text(root.querySelector('[data-role="captions"]'))).toBe(why);
  });

  it('says a missing Gemini key means captions-only transcripts, without calling it a blocker', () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    view.update(model({ geminiKeyMissing: true }), T0);
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
    const notice = root.querySelector('[data-role="no-gemini"]')!;
    expect(text(notice)).toMatch(/No Gemini API key: transcripts come from Meet's captions only/);
    notice.querySelector('button')!.click();
    expect(h.calls).toEqual(['openSettings']);
  });

  it('warns about missing settings with a way to fix them', () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    view.update(model({ missing: ['Notion integration token', 'Your name'] }), T0);
    expect(text(root.querySelector('[data-role="missing"]'))).toContain(
      'Saving to Notion needs: Notion integration token, Your name.',
    );
    root.querySelector<HTMLButtonElement>('[data-role="missing"] button')!.click();
    expect(h.calls).toEqual(['openSettings']);
    view.update(model(), T0);
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
  });

  it('links to the dashboard and settings', () => {
    const h = handlers();
    const view = createPopupView(root, h.handlers);
    view.update(model(), T0);
    button('Dashboard')!.click();
    button('Settings')!.click();
    expect(h.calls).toEqual(['openDashboard', 'openSettings']);
  });
});
