import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CaptionTracker } from '@lib/captions/tracker';
import { CaptionWatcher } from '@lib/captions/watcher';
import type { CaptionSegment } from '@lib/types';
import singleSpeaker from '../fixtures/captions/single-speaker.html?raw';

const stepFiles = import.meta.glob('../fixtures/captions/revision/*.html', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const steps = Object.keys(stepFiles)
  .sort()
  .map((path) => ({ name: path.split('/').pop()!.replace('.html', ''), html: stepFiles[path]! }));

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The caption panel of a fixture, imported into the live test document. */
function panelOf(html: string): Element {
  const panel = parse(html).querySelector('[jsname="dsyhDe"]');
  if (!panel) throw new Error('fixture has no caption panel');
  return document.importNode(panel, true);
}

/**
 * Moves the live DOM to the next snapshot the way Meet does: blocks present in both
 * keep their node and get their text edited (in place, or by swapping the text node),
 * new blocks are inserted, missing ones removed. data-fixture-block pairs them up.
 */
function applyStep(host: Element, html: string, textEdit: 'in-place' | 'replace-node'): void {
  const region = host.querySelector('[role="region"]')!;
  const want = [...parse(html).querySelectorAll('[data-fixture-block]')];
  const ids = want.map((b) => b.getAttribute('data-fixture-block'));
  for (const live of region.querySelectorAll('[data-fixture-block]')) {
    if (!ids.includes(live.getAttribute('data-fixture-block'))) live.remove();
  }
  let previous: Element | null = null;
  for (const block of want) {
    const id = block.getAttribute('data-fixture-block');
    let live = region.querySelector(`[data-fixture-block="${id}"]`);
    const text = block.querySelector('.ygicle')!.textContent!;
    if (live) {
      const textEl = live.querySelector('.ygicle')!;
      if (textEl.textContent !== text) {
        if (textEdit === 'in-place') (textEl.firstChild as Text).data = text;
        else textEl.textContent = text;
      }
    } else {
      live = document.importNode(block, true);
      if (previous) previous.after(live);
      else region.prepend(live);
    }
    previous = live;
  }
}

/** What the background keeps: the highest rev per id. */
function fold(batches: CaptionSegment[][]): CaptionSegment[] {
  const best = new Map<string, CaptionSegment>();
  for (const seg of batches.flat()) {
    const prev = best.get(seg.id);
    if (!prev || seg.rev > prev.rev) best.set(seg.id, seg);
  }
  return [...best.values()].sort((a, b) => a.tStart - b.tStart);
}

describe('caption replay through CaptionWatcher + adapter + tracker', () => {
  let host: HTMLDivElement;
  let clock: number;
  let tracker: CaptionTracker<Element>;
  let watcher: CaptionWatcher;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    clock = 0;
    tracker = new CaptionTracker<Element>({ idPrefix: 'r' });
    watcher = new CaptionWatcher({ doc: document, tracker, now: () => clock });
  });

  afterEach(() => {
    watcher.stop();
    host.remove();
  });

  async function replay(): Promise<CaptionSegment[][]> {
    const batches: CaptionSegment[][] = [];
    expect(watcher.sync()).toBe(false);
    clock = 1000;
    host.append(panelOf(steps[0]!.html));
    expect(watcher.sync()).toBe(true);
    batches.push(tracker.drainChanges());
    for (const step of steps.slice(1)) {
      clock += 700;
      applyStep(host, step.html, step.name === '03-rewritten' ? 'replace-node' : 'in-place');
      await tick();
      watcher.sync();
      batches.push(tracker.drainChanges());
    }
    return batches;
  }

  it('has the ordered revision fixture', () => {
    expect(steps.map((s) => s.name)).toEqual([
      '01-first-words',
      '02-refined',
      '03-rewritten',
      '04-sentence-appended',
      '05-new-speaker',
      '06-another-speaker',
      '07-old-block-removed',
    ]);
  });

  it('emits one segment per block, the highest rev carrying the final text, with no duplicates', async () => {
    const batches = await replay();
    const emitted = batches.flat();

    // Every emission is a new (id, rev) and revs only grow per id.
    const pairs = emitted.map((s) => `${s.id}#${s.rev}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    const lastRev = new Map<string, number>();
    for (const s of emitted) {
      expect(s.rev).toBeGreaterThan(lastRev.get(s.id) ?? -1);
      lastRev.set(s.id, s.rev);
    }

    expect(fold(batches)).toEqual([
      {
        id: 'r-1',
        speaker: 'Camille Martin',
        self: false,
        text: 'So the plan for Lumind is to ship on Monday. Then we test it with two customers.',
        tStart: 1000,
        tEnd: 3100,
        rev: 3,
      },
      { id: 'r-2', speaker: 'You', self: true, text: 'Sounds good to me.', tStart: 3800, tEnd: 4500, rev: 1 },
      { id: 'r-3', speaker: 'Hugo Bernard', self: false, text: 'Je peux faire la démo mardi.', tStart: 4500, tEnd: 5200, rev: 1 },
    ]);
    // Removed blocks are finalized; the two on screen are still tracked.
    expect(tracker.liveCount).toBe(2);
    // No text was ever emitted under two ids.
    const textsById = new Map<string, string>();
    for (const s of emitted) {
      const owner = textsById.get(s.text);
      if (owner) expect(owner).toBe(s.id);
      textsById.set(s.text, s.id);
    }
  });

  it('keeps ids when Meet replaces the whole captions region', async () => {
    await replay();
    const before = tracker.segments();
    clock += 700;
    host.replaceChildren(panelOf(steps.at(-1)!.html));
    expect(watcher.sync()).toBe(true);
    expect(tracker.drainChanges()).toEqual([]);
    expect(tracker.segments()).toEqual(before);
    expect(tracker.liveCount).toBe(2);

    clock += 700;
    const hugo = host.querySelector('[data-fixture-block="b3"] .ygicle')!;
    (hugo.firstChild as Text).data = 'Je peux faire la démo mardi matin.';
    watcher.flush();
    expect(tracker.drainChanges()).toEqual([
      expect.objectContaining({ id: 'r-3', text: 'Je peux faire la démo mardi matin.', rev: 2, tEnd: clock }),
    ]);
  });

  it('keeps the id when Meet swaps the active block for a fresh node', async () => {
    await replay();
    clock += 400;
    const old = host.querySelector('[data-fixture-block="b3"]')!;
    const fresh = old.cloneNode(true) as Element;
    fresh.querySelector('.ygicle')!.textContent = 'Je peux faire la démo mardi, ou mercredi.';
    old.replaceWith(fresh);
    watcher.flush();
    expect(tracker.drainChanges()).toEqual([
      expect.objectContaining({ id: 'r-3', text: 'Je peux faire la démo mardi, ou mercredi.', rev: 2 }),
    ]);
    expect(tracker.segments()).toHaveLength(3);
  });

  it('processes pending mutations synchronously on flush, exactly once', async () => {
    watcher.sync();
    clock = 500;
    host.append(panelOf(steps[0]!.html));
    watcher.sync();
    tracker.drainChanges();
    clock = 900;
    applyStep(host, steps[1]!.html, 'in-place');
    watcher.flush();
    expect(tracker.drainChanges()).toEqual([expect.objectContaining({ text: 'So the plan for luminous', rev: 1 })]);
    await tick();
    expect(tracker.drainChanges()).toEqual([]);
  });

  it('ignores the jump-to-bottom button and other non-caption churn', async () => {
    host.append(panelOf(steps[0]!.html));
    watcher.sync();
    tracker.drainChanges();
    const button = host.querySelector('button')!;
    button.querySelector('span')!.textContent = 'Jump to the most recent captions';
    button.parentElement!.append(document.createElement('span'));
    await tick();
    expect(tracker.drainChanges()).toEqual([]);
  });

  it('skips captions already on screen when recording starts, until they change', async () => {
    host.append(panelOf(singleSpeaker));
    const late = new CaptionWatcher({ doc: document, tracker, now: () => clock, skipExisting: true });
    try {
      clock = 200;
      expect(late.sync()).toBe(true);
      expect(tracker.drainChanges()).toEqual([]);

      clock = 900;
      const text = host.querySelector('.ygicle')!;
      (text.firstChild as Text).data = "Let's look at the onboarding numbers first, then the roadmap for Q3.";
      await tick();
      expect(tracker.drainChanges()).toEqual([
        expect.objectContaining({
          speaker: 'Camille Martin',
          text: "Let's look at the onboarding numbers first, then the roadmap for Q3.",
          tStart: 900,
          rev: 0,
        }),
      ]);
    } finally {
      late.stop();
    }
  });

  it('keeps captions that appear after recording started (region absent at the first sync)', async () => {
    const late = new CaptionWatcher({ doc: document, tracker, now: () => clock, skipExisting: true });
    try {
      clock = 100;
      expect(late.sync()).toBe(false);
      clock = 2000;
      host.append(panelOf(singleSpeaker));
      expect(late.sync()).toBe(true);
      expect(tracker.drainChanges()).toEqual([
        expect.objectContaining({ speaker: 'Camille Martin', tStart: 2000, rev: 0 }),
      ]);
    } finally {
      late.stop();
    }
  });

  it('keeps skipping pre-recording captions after Meet re-renders the region', async () => {
    host.append(panelOf(singleSpeaker));
    const late = new CaptionWatcher({ doc: document, tracker, now: () => clock, skipExisting: true });
    try {
      clock = 200;
      late.sync();
      clock = 1500;
      host.replaceChildren(panelOf(singleSpeaker));
      expect(late.sync()).toBe(true);
      await tick();
      expect(tracker.drainChanges()).toEqual([]);
      expect(tracker.segments()).toEqual([]);
    } finally {
      late.stop();
    }
  });

  it('applies an edit made just before the region is removed to the same segment', async () => {
    await replay();
    const hugo = host.querySelector('[data-fixture-block="b3"] .ygicle')!;
    (hugo.firstChild as Text).data = 'Pardon, plutôt jeudi.';
    host.replaceChildren();
    clock += 300;
    expect(watcher.sync()).toBe(false);
    expect(tracker.drainChanges()).toEqual([
      expect.objectContaining({ id: 'r-3', text: 'Pardon, plutôt jeudi.', rev: 2 }),
    ]);
    expect(tracker.segments()).toHaveLength(3);
  });

  it('finalizes everything when the captions region disappears (CC turned off)', async () => {
    await replay();
    host.replaceChildren();
    clock += 500;
    expect(watcher.sync()).toBe(false);
    expect(tracker.liveCount).toBe(0);
    expect(tracker.segments()).toHaveLength(3);
    expect(tracker.drainChanges()).toEqual([]);
  });
});
