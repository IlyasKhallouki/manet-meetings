import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '@lib/ui/styles.css';
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import { createRoutingView } from '@lib/ui/routingView';
import routingHtml from '../../entrypoints/routing/index.html?raw';

// The real CSS in a window as narrow as the prompt's (380 CSS px). The window is fitted
// to the content's height (entrypoints/routing/main.ts), so what matters is the content:
// no sideways scroll, nothing overflowing its control, and a height near the 220 px a
// 380×280 popup window leaves on Linux and Windows.

const T0 = Date.UTC(2026, 8, 19, 9, 0, 0);

function speakers(...names: string[]): SpeakerInfo[] {
  return names.map((name, i) => ({ name, self: name === 'Ilyas', firstAt: i, lastAt: i + 1, talkMs: 1 }));
}

const meta: SessionMeta = {
  id: 's',
  meetCode: 'abc-defg-hij',
  meetingTitle: 'Weekly product sync',
  startedAt: T0 - 32 * 60_000,
  durationMs: 32 * 60_000,
  status: 'awaiting-route',
  idempotencyKey: 'k',
  audio: { mimeType: 'audio/webm', chunkCount: 1, bytes: 1, micIncluded: true },
  captionCount: 3,
  speakers: speakers('Marie Curie', 'Tom Martin', 'Ilyas'),
};

function mountShell(): HTMLElement {
  const doc = new DOMParser().parseFromString(routingHtml, 'text/html');
  document.body.className = doc.body.className;
  const root = document.importNode(doc.getElementById('app')!, true);
  document.body.replaceChildren(root);
  return root;
}

function render(m: SessionMeta, fontSize = 16): HTMLElement {
  document.documentElement.style.fontSize = `${fontSize}px`;
  const root = mountShell();
  createRoutingView(
    root,
    { choose: () => Promise.resolve(), hold: () => Promise.resolve(), open: () => {}, close: () => {} },
    { locale: 'en-GB', timeZone: 'UTC' },
  ).update({ meta: m, defaultRoute: 'team', deadline: T0 + 60_000 }, T0);
  return root;
}

function overflowing(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('.segment, .segment-label, .segment-sub, .btn, p, h1')]
    .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'hidden')
    .map((el) => `${el.className || el.tagName}: ${el.textContent}`);
}

beforeEach(async () => {
  await page.viewport(380, 220);
});
afterEach(() => {
  document.documentElement.style.fontSize = '';
  document.body.replaceChildren();
  document.body.className = '';
});

describe('routing window layout (real CSS, 380 px)', () => {
  it('fits the choose state in about 208 px, with Pause inside the content', () => {
    const root = render(meta);
    const height = root.getBoundingClientRect().height;
    expect(height).toBeGreaterThan(190);
    expect(height).toBeLessThanOrEqual(220);
    const pause = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pause')!;
    expect(pause.getBoundingClientRect().bottom).toBeLessThanOrEqual(root.getBoundingClientRect().bottom);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(380);
    expect(overflowing(root)).toEqual([]);
  });

  it('gives Team and Personal equal halves, 56 px tall, subtitles on one line', () => {
    const root = render(meta);
    const [team, personal] = [...root.querySelectorAll<HTMLElement>('.segment')].map((s) => s.getBoundingClientRect());
    expect(Math.abs(team!.width - personal!.width)).toBeLessThanOrEqual(1);
    expect(team!.height).toBeGreaterThanOrEqual(54);
    const sub = root.querySelector<HTMLElement>('.is-default .segment-sub')!;
    expect(sub.getBoundingClientRect().height).toBeLessThanOrEqual(17);
  });

  it('wraps long titles to two lines and long names without sideways scroll', () => {
    const root = render({
      ...meta,
      meetingTitle: 'Point hebdo produit — revue des priorités Q4 avec l’équipe design et les partenaires de Nova',
      speakers: speakers('Jean-Baptiste de La Fontaine', 'Marie-Hélène Dubois-Laurent', 'Ilyas', 'Sofia', 'Tom'),
    });
    const title = root.querySelector<HTMLElement>('h1')!;
    expect(title.getBoundingClientRect().height).toBeLessThanOrEqual(2 * 22 + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(380);
    expect(overflowing(root)).toEqual([]);
  });

  it('keeps 56 px at 100% and room around the text at 150%, clear of the drain bar', () => {
    const at100 = render(meta);
    expect(at100.querySelector('.route-choice')!.getBoundingClientRect().height).toBeCloseTo(56, 0);

    const root = render(meta, 24);
    const segment = root.querySelector<HTMLElement>('.segment.is-default')!.getBoundingClientRect();
    const label = root.querySelector<HTMLElement>('.is-default .segment-label')!.getBoundingClientRect();
    const sub = root.querySelector<HTMLElement>('.is-default .segment-sub')!.getBoundingClientRect();
    const drain = root.querySelector<HTMLElement>('.is-default .route-drain')!.getBoundingClientRect();
    // Beyond the focus ring's 2 px surface gap, with room to spare.
    expect(label.top - segment.top).toBeGreaterThanOrEqual(7);
    // The wrapped subtitle ends well above the 4 px drain bar (inset 2 px while focused).
    expect(drain.top - sub.bottom).toBeGreaterThanOrEqual(5);
  });

  it('survives 200% text without sideways scroll', () => {
    const root = render(meta, 32);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(380);
    expect(overflowing(root)).toEqual([]);
  });
});
