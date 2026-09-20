import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '@lib/ui/styles.css';
import { createDashboardView, type DashboardView } from '@lib/ui/dashboardView';
import { MEETINGS, MEETING_RESULTS, NOW } from './dashboardFixtures';

const noop = () => Promise.resolve();
let root: HTMLElement;
let view: DashboardView;

beforeEach(() => {
  document.body.className = 'page page-meetings';
  root = document.createElement('main');
  root.id = 'app';
  root.className = 'page-body';
  document.body.append(root);
  view = createDashboardView(
    root,
    { stop: noop, transcribe: noop, save: noop, remove: noop, route: noop, setAutoTranscribe: noop, openSettings: () => {} },
    { locale: 'en-GB', timeZone: 'UTC' },
  );
  view.update({
    sessions: MEETINGS,
    resultIds: MEETING_RESULTS,
    audioOnDisk: null,
    missing: ['Notion integration token', 'Your name'],
    geminiKeyMissing: true,
    autoTranscribe: true,
    retentionDays: 7,
    now: NOW,
  });
});

afterEach(() => {
  view.destroy();
  root.remove();
  document.body.className = '';
  document.documentElement.style.fontSize = '';
});

const rect = (el: Element) => el.getBoundingClientRect();
const shown = (el: Element) => el.getClientRects().length > 0;

/** Every visible element of every row stays inside its row. */
function expectRowsContained(): void {
  for (const li of root.querySelectorAll<HTMLElement>('li[data-id]')) {
    const box = rect(li);
    for (const el of li.querySelectorAll('*')) {
      if (!shown(el)) continue;
      const r = rect(el);
      expect(r.right, `${li.dataset.id}: ${el.className}`).toBeLessThanOrEqual(box.right + 0.5);
      expect(r.left, `${li.dataset.id}: ${el.className}`).toBeGreaterThanOrEqual(box.left - 0.5);
    }
  }
}

function expectNoSidewaysScroll(): void {
  const doc = document.documentElement;
  expect(doc.scrollWidth).toBeLessThanOrEqual(doc.clientWidth);
}

describe('Meetings layout (real CSS)', () => {
  it('never scrolls sideways at 390 px, and nothing spills out of a row', async () => {
    await page.viewport(390, 800);
    expect(document.documentElement.clientWidth).toBe(390);
    expectNoSidewaysScroll();
    expectRowsContained();
    // Stacked: time and length move into the byline.
    const row = root.querySelector('li[data-id="saved"]')!;
    expect(shown(row.querySelector('[data-cell="time"]')!)).toBe(false);
    expect(shown(row.querySelector('.meeting-when')!)).toBe(true);
  });

  it('keeps every status word and its clock on one line at 390 px', async () => {
    await page.viewport(390, 800);
    // The status word (and the live clock beside it) is the row's primary reading: it
    // shares the stacked row's line with the next-step capsule, and the capsule's metrics
    // must never take so much of the width that "Recording 23:12" or "Saved to Notion"
    // breaks in two. Only the longest word in the glossary, "Transcribed, not saved yet",
    // takes two lines at 390 px — it always has, and its glyph stays on the first.
    for (const li of root.querySelectorAll<HTMLElement>('li[data-id]')) {
      const word = li.querySelector<HTMLElement>('.meeting-head .status-word');
      if (!word || !shown(word) || li.dataset.id === 'processed') continue;
      expect(rect(word).height, `${li.dataset.id}: “${word.textContent}” wrapped`).toBeLessThanOrEqual(21);
    }
    // And the one that broke: the clock stays beside the word it belongs to.
    const rec = root.querySelector('li[data-id="rec"]')!;
    const clock = rect(rec.querySelector('.meeting-clock')!);
    const head = rect(rec.querySelector('.meeting-head')!);
    expect(Math.abs(clock.top - head.top)).toBeLessThan(1);
    expect(rect(rec.querySelector('.meeting-primary')!).left).toBeGreaterThanOrEqual(clock.right);
  });

  it('keeps the inline confirms and the menu on screen at 390 px', async () => {
    await page.viewport(390, 800);
    root.querySelector<HTMLElement>('[data-key="dup:more"]')!.click();
    root.querySelector<HTMLElement>('[data-key="menu:second-copy"]')!.click();
    root.querySelector<HTMLElement>('[data-key="rec:more"]')!.click();
    const menu = rect(root.querySelector('[role="menu"]')!);
    expect(menu.left).toBeGreaterThanOrEqual(8);
    expect(menu.right).toBeLessThanOrEqual(390 - 8);
    expectNoSidewaysScroll();
    expectRowsContained();
  });

  it('reflows at 150 % text instead of clipping', async () => {
    document.documentElement.style.fontSize = '24px';
    await page.viewport(390, 800);
    expectNoSidewaysScroll();
    expectRowsContained();
    // One column: ⋯ stays on the status line (never alone on a line), the next step goes last.
    for (const id of ['proc', 'failed']) {
      const head = rect(root.querySelector(`li[data-id="${id}"] .meeting-head`)!);
      const more = rect(root.querySelector(`li[data-id="${id}"] .meeting-more`)!);
      expect(more.top).toBeLessThan(head.bottom);
      expect(more.bottom).toBeGreaterThan(head.top);
      expect(more.left).toBeGreaterThan(head.left);
    }
    const next = rect(root.querySelector('li[data-id="failed"] .meeting-primary')!);
    expect(next.top).toBeGreaterThan(rect(root.querySelector('li[data-id="failed"] .meeting-extra')!).bottom);
    await page.viewport(1280, 800);
    // 55rem is wider than the page at 24 px: the rows stay stacked.
    expect(shown(root.querySelector('li[data-id="saved"] [data-cell="time"]')!)).toBe(false);
  });

  it('uses the five-column row on a wide window', async () => {
    await page.viewport(1280, 800);
    expectNoSidewaysScroll();
    expectRowsContained();
    const row = root.querySelector('li[data-id="saved"]')!;
    const time = rect(row.querySelector('[data-cell="time"]')!);
    const title = rect(row.querySelector('[data-cell="meeting"]')!);
    // The status cell is display: contents; its head line is the column.
    const status = rect(row.querySelector('[data-cell="status"] .meeting-head')!);
    const actions = rect(row.querySelector('[data-cell="actions"]')!);
    // One line of cells, left to right.
    expect(time.right).toBeLessThan(title.left);
    expect(title.right).toBeLessThan(status.left);
    expect(status.right).toBeLessThanOrEqual(actions.left);
    expect(Math.abs(time.top - status.top)).toBeLessThan(1);
    expect(shown(row.querySelector('.meeting-when')!)).toBe(false);
    // Lines under the status run on under the empty action column (no one-word-per-line
    // details), except the first line under a button, which would touch it.
    const lineRight = (id: string, selector: string) =>
      rect(root.querySelector(`li[data-id="${id}"] ${selector}`)!).right;
    expect(lineRight('empty', '.meeting-detail')).toBeCloseTo(actions.right, 0);
    expect(lineRight('failed', '.meeting-detail')).toBeCloseTo(status.right, 0);
    expect(lineRight('failed', '.meeting-extra')).toBeCloseTo(actions.right, 0);
    // The Needs you group dates its rows under the time: "Thu 17 Sep" fits its column.
    const date = root.querySelector<HTMLElement>('li[data-id="processed"] .meeting-date')!;
    expect(date.textContent).toBe('Thu 17 Sep');
    expect(rect(date).height).toBeLessThanOrEqual(19);
    expect(rect(date).right).toBeLessThanOrEqual(rect(root.querySelector('li[data-id="processed"] [data-cell="time"]')!).right);
    // Long titles end in an ellipsis on one line.
    const name = root.querySelector<HTMLElement>('li[data-id="failed-save"] .meeting-name')!;
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(rect(name).height).toBeLessThanOrEqual(21);
  });
});
