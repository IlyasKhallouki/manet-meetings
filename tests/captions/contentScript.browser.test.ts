import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '@lib/messages';
import type { CaptionSegment } from '@lib/types';
import singleSpeaker from '../fixtures/captions/single-speaker.html?raw';

type Listener = (msg: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => true | undefined;

/**
 * The one stub: chrome.runtime. Everything else is the real content script: WXT's
 * ContentScriptContext, messages.ts envelopes, controller, watcher, adapter, tracker.
 */
const listeners = new Set<Listener>();
const sent: Envelope[] = [];
const fakeRuntime = {
  id: 'manet-test-extension',
  onMessage: {
    addListener: (l: Listener) => listeners.add(l),
    removeListener: (l: Listener) => listeners.delete(l),
    hasListener: (l: Listener) => listeners.has(l),
  },
  sendMessage: async (msg: Envelope) => {
    sent.push(structuredClone(msg));
    return { ok: true, value: msg.type === 'meet/joined' ? null : undefined };
  },
};

function deliver(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let answered = false;
    for (const l of listeners) {
      if (l(msg, { id: fakeRuntime.id }, resolve) === true) answered = true;
    }
    if (!answered) resolve(undefined);
  });
}

const batches = () =>
  sent
    .filter((m) => m.target === 'background' && m.type === 'captions/batch')
    .map((m) => m.payload as { sessionId: string; segments: CaptionSegment[] });

describe('content script entrypoint wiring', () => {
  const g = globalThis as unknown as { chrome?: Record<string, unknown> };
  let previousRuntime: unknown;
  let ctx: import('wxt/utils/content-script-context').ContentScriptContext;
  let panel: Element | null = null;

  beforeAll(async () => {
    g.chrome ??= {};
    previousRuntime = g.chrome.runtime;
    Object.defineProperty(g.chrome, 'runtime', { value: fakeRuntime, configurable: true, writable: true });
    const { default: contentScript } = await import('../../entrypoints/content/index');
    const { ContentScriptContext } = await import('wxt/utils/content-script-context');
    expect(contentScript.matches).toEqual(['https://meet.google.com/*']);
    ctx = new ContentScriptContext('content', contentScript);
    await contentScript.main(ctx);
  });

  afterAll(() => {
    if (!ctx.isInvalid) ctx.notifyInvalidated();
    panel?.remove();
    Object.defineProperty(g.chrome!, 'runtime', { value: previousRuntime, configurable: true, writable: true });
  });

  it('answers content/recording-state and ignores envelopes for other targets', async () => {
    expect(await deliver({ __manet: true, target: 'background', type: 'content/recording-state', payload: null })).toBeUndefined();
    const reply = await deliver({
      __manet: true,
      target: 'content',
      type: 'content/recording-state',
      payload: { sessionId: 's1', startedAt: Date.now() },
    });
    expect(reply).toEqual({ ok: true, value: undefined });
  });

  it('ships captions that appear while recording in a captions/batch envelope within about a second', async () => {
    panel = document.importNode(new DOMParser().parseFromString(singleSpeaker, 'text/html').querySelector('[jsname="dsyhDe"]')!, true);
    document.body.append(panel);
    await vi.waitFor(() => expect(batches()).toHaveLength(1), { timeout: 4000, interval: 100 });
    expect(batches()[0]).toEqual({
      sessionId: 's1',
      segments: [
        expect.objectContaining({
          speaker: 'Camille Martin',
          text: "Let's look at the onboarding numbers first, then the roadmap.",
          self: false,
          rev: 0,
        }),
      ],
    });
  });

  it('flushes immediately on pagehide', () => {
    const text = panel!.querySelector('.ygicle')!;
    (text.firstChild as Text).data = "Let's look at the onboarding numbers first, then the roadmap. Bye!";
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(batches().at(-1)!.segments).toEqual([
      expect.objectContaining({ text: "Let's look at the onboarding numbers first, then the roadmap. Bye!", rev: 1 }),
    ]);
  });

  it('removes its message listener when the context is invalidated', () => {
    expect(listeners.size).toBe(1);
    ctx.notifyInvalidated();
    expect(listeners.size).toBe(0);
  });
});
