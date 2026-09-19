import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Route, SessionMeta } from '@lib/types';
import { createDashboardView, type DashboardData, type DashboardHandlers } from '@lib/ui/dashboardView';
import { formatDateTime } from '@lib/ui/sessionView';

const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const T0 = Date.UTC(2026, 8, 19, 8, 0, 0);
const MB = 1024 * 1024;

function meta(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt: T0,
    status: 'ready',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 10, bytes: 2 * MB, micIncluded: true },
    captionCount: 12,
    ...patch,
  };
}

const SAMPLE: SessionMeta[] = [
  meta('saved', {
    startedAt: T0 - 86_400_000,
    status: 'saved',
    meetingTitle: 'Weekly sync',
    durationMs: 3_723_000,
    route: 'team',
    notion: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Ilya' },
  }),
  meta('rec', { startedAt: T0 + 3_600_000, status: 'recording', meetCode: 'xyz-abcd-efg' }),
  meta('proc', { startedAt: T0 + 60_000, status: 'processing', stage: 'summarizing', route: 'personal' }),
  meta('failed', { startedAt: T0 + 30_000, status: 'failed', error: 'Saving to Notion failed: rate limited', route: 'team' }),
  meta('route', { startedAt: T0 + 120_000, status: 'awaiting-route', durationMs: 600_000, recovered: true }),
  meta('dup', {
    startedAt: T0 - 172_800_000,
    status: 'duplicate',
    notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Marie' },
  }),
];

function data(patch: Partial<DashboardData> = {}): DashboardData {
  return {
    sessions: SAMPLE,
    resultIds: new Set(['failed', 'saved']),
    audioOnDisk: new Map([['saved', 3 * MB]]),
    estimate: { usage: 20 * MB, quota: 1024 * MB },
    missing: [],
    now: T0 + 3_600_000 + 65_000,
    ...patch,
  };
}

interface Call {
  action: string;
  id: string;
  route?: Route;
}

/** Records calls; each call returns a promise the test settles. */
function recorder() {
  const calls: Call[] = [];
  const settle: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const pending = (call: Call) =>
    new Promise<void>((resolve, reject) => {
      calls.push(call);
      settle.push({ resolve, reject });
    });
  let settingsOpened = 0;
  const handlers: DashboardHandlers = {
    stop: (id) => pending({ action: 'stop', id }),
    transcribe: (id) => pending({ action: 'transcribe', id }),
    save: (id) => pending({ action: 'save', id }),
    remove: (id) => pending({ action: 'remove', id }),
    route: (id, route) => pending({ action: 'route', id, route }),
    openSettings: () => {
      settingsOpened++;
    },
  };
  return { calls, settle, handlers, settingsOpened: () => settingsOpened };
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (id: string) => root.querySelector<HTMLTableRowElement>(`tr[data-id="${id}"]`)!;
const cell = (id: string, name: string) => row(id).querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
const button = (id: string, label: string) =>
  [...row(id).querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('dashboard view (real DOM)', () => {
  it('lists every session newest first with its fields', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    const ids = [...root.querySelectorAll('tbody tr')].map((tr) => (tr as HTMLElement).dataset.id);
    expect(ids).toEqual(['rec', 'route', 'proc', 'failed', 'saved', 'dup']);

    expect(text(cell('saved', 'date'))).toBe(formatDateTime(T0 - 86_400_000, FMT));
    expect(text(cell('saved', 'meeting'))).toContain('Weekly sync');
    expect(text(cell('saved', 'meeting'))).toContain('abc-defg-hij');
    expect(text(cell('saved', 'duration'))).toBe('1h 02m');
    // Bytes on disk win over the recorder's count.
    expect(text(cell('saved', 'audio'))).toBe('3.0 MB');
    expect(text(cell('failed', 'audio'))).toBe('2.0 MB');
    expect(text(cell('saved', 'route'))).toBe('Team');
  });

  it('uses real table semantics', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    const headers = [...root.querySelectorAll('thead th')].map((th) => text(th));
    expect(headers).toEqual(['Date', 'Meeting', 'Duration', 'Audio', 'Status', 'Destination', 'Actions']);
    for (const th of root.querySelectorAll('thead th')) expect(th.getAttribute('scope')).toBe('col');
  });

  it('shows status, stage, error, recovered flag and Notion links', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    expect(text(cell('proc', 'status'))).toContain('Processing');
    expect(text(cell('proc', 'status'))).toContain('Summarizing');
    expect(cell('proc', 'status').querySelector('.badge')?.classList.contains('tone-busy')).toBe(true);
    expect(text(cell('failed', 'status'))).toContain('Saving to Notion failed: rate limited');
    expect(text(cell('route', 'status'))).toContain('Recovered');

    const saved = cell('saved', 'status').querySelector('a')!;
    expect(saved.href).toBe('https://www.notion.so/p1');
    expect(saved.target).toBe('_blank');
    expect(saved.rel).toContain('noopener');
    expect(text(saved)).toBe('Open in Notion');
    expect(text(cell('dup', 'status').querySelector('a'))).toBe('Already saved by Marie');
  });

  it('enables actions from the status', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    expect(button('rec', 'Stop')?.disabled).toBe(false);
    expect(button('rec', 'Transcribe')).toBeUndefined();
    expect(button('proc', 'Transcribe')?.disabled).toBe(true);
    expect(button('proc', 'Transcribe')?.title).toMatch(/already running/);
    expect(button('proc', 'Delete')?.disabled).toBe(true);
    expect(button('failed', 'Retry save')?.disabled).toBe(false);
    expect(button('failed', 'Retry save')?.classList.contains('primary')).toBe(true);
    expect(button('failed', 'Transcribe again')?.disabled).toBe(false);
    expect(button('route', 'Transcribe')?.disabled).toBe(false);
    expect(button('saved', 'Delete')?.disabled).toBe(false);
    expect(button('saved', 'Transcribe')).toBeUndefined();
    // Every button names its meeting for screen readers.
    expect(button('saved', 'Delete')?.getAttribute('aria-label')).toBe('Delete Weekly sync');
  });

  it('runs an action, disables the row while it is pending, then re-enables it', async () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());
    button('route', 'Transcribe')!.click();
    expect(r.calls).toEqual([{ action: 'transcribe', id: 'route' }]);
    expect(button('route', 'Transcribe')?.disabled).toBe(true);
    expect(button('route', 'Delete')?.disabled).toBe(true);
    // Other rows are unaffected.
    expect(button('saved', 'Delete')?.disabled).toBe(false);
    r.settle[0]!.resolve();
    await flush();
    expect(button('route', 'Transcribe')?.disabled).toBe(false);
  });

  it('shows a failed request in its row', async () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());
    button('failed', 'Retry save')!.click();
    r.settle[0]!.reject(new Error('Cannot save a session that is saving.'));
    await flush();
    const alert = row('failed').querySelector('[role="alert"]');
    expect(text(alert)).toBe('Cannot save a session that is saving.');
    // The next attempt clears it.
    button('failed', 'Retry save')!.click();
    expect(row('failed').querySelector('[role="alert"]')).toBeNull();
  });

  it('confirms Delete inline, and Cancel or Escape backs out', async () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());

    button('saved', 'Delete')!.click();
    expect(r.calls).toEqual([]);
    expect(text(cell('saved', 'actions'))).toMatch(/Delete this recording/);
    expect(text(cell('saved', 'actions'))).toMatch(/Notion page stays/);
    expect(document.activeElement).toBe(button('saved', 'Cancel'));
    button('saved', 'Cancel')!.click();
    expect(button('saved', 'Delete')).toBeDefined();
    expect(document.activeElement).toBe(button('saved', 'Delete'));

    button('saved', 'Delete')!.click();
    button('saved', 'Cancel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(button('saved', 'Cancel')).toBeUndefined();

    button('saved', 'Delete')!.click();
    button('saved', 'Yes, delete')!.click();
    expect(r.calls).toEqual([{ action: 'remove', id: 'saved' }]);
    r.settle[0]!.resolve();
    await flush();
    // The row goes away when the background deletes the session and the page updates.
    view.update(data({ sessions: SAMPLE.filter((s) => s.id !== 'saved') }));
    expect(row('saved')).toBeNull();
  });

  it('warns before deleting a recording in progress', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    button('rec', 'Delete')!.click();
    expect(text(cell('rec', 'actions'))).toMatch(/Stop recording and delete/);
  });

  it('offers a destination picker where the route can be chosen', async () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());
    const select = cell('route', 'route').querySelector('select')!;
    expect(select.value).toBe('');
    expect(select.getAttribute('aria-label')).toBe('Destination for abc-defg-hij');
    select.value = 'personal';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(r.calls).toEqual([{ action: 'route', id: 'route', route: 'personal' }]);
    expect(cell('route', 'route').querySelector('select')!.disabled).toBe(true);
    r.settle[0]!.resolve();
    await flush();

    expect(cell('failed', 'route').querySelector('select')!.value).toBe('team');
    expect(cell('proc', 'route').querySelector('select')).toBeNull();
    expect(text(cell('proc', 'route'))).toBe('Personal');
  });

  it('summarizes storage and warns about missing settings', () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data({ missing: ['Gemini API key', 'Your name'] }));
    const storage = text(root.querySelector('[data-role="storage"]'));
    // saved 3 MB (disk) + rec, proc, failed, route, dup 2 MB each.
    expect(storage).toContain('13.0 MB in 6 recordings');
    expect(storage).toContain('20.0 MB used of 1.0 GB available');
    const notice = root.querySelector('[data-role="missing"]')!;
    expect(text(notice)).toContain('Gemini API key, Your name');
    notice.querySelector('button')!.click();
    expect(r.settingsOpened()).toBe(1);

    view.update(data({ missing: [] }));
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
  });

  it('shows an empty state', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data({ sessions: [] }));
    expect(root.querySelectorAll('tbody tr').length).toBe(0);
    expect(text(root.querySelector('[data-role="empty"]'))).toMatch(/No recordings yet/);
  });

  it('updates in place so a click is never lost to a re-render', () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());
    const stop = button('rec', 'Stop');
    const deleteSaved = button('saved', 'Delete');
    const recRow = row('rec');

    // A clock tick and a heartbeat on the recording row.
    const later = SAMPLE.map((s) => (s.id === 'rec' ? { ...s, audio: { ...s.audio, bytes: 3 * MB }, lastHeartbeat: 1 } : s));
    view.update(data({ sessions: later, now: T0 + 3_600_000 + 125_000 }));
    expect(row('rec')).toBe(recRow);
    expect(button('rec', 'Stop')).toBe(stop);
    expect(button('saved', 'Delete')).toBe(deleteSaved);
    expect(text(cell('rec', 'duration'))).toBe('2m 05s');
    expect(text(cell('rec', 'audio'))).toBe('3.0 MB');

    // A status change re-renders that row's actions only.
    const stopped = later.map((s) => (s.id === 'rec' ? { ...s, status: 'awaiting-route' as const, durationMs: 130_000 } : s));
    view.update(data({ sessions: stopped }));
    expect(button('rec', 'Stop')).toBeUndefined();
    expect(button('rec', 'Transcribe')?.disabled).toBe(false);
    expect(button('saved', 'Delete')).toBe(deleteSaved);
  });

  it('does not rebuild the settings notice on a clock tick', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data({ missing: ['Gemini API key'] }));
    const open = root.querySelector('[data-role="missing"] button');
    view.update(data({ missing: ['Gemini API key'], now: T0 + 3_600_000 + 70_000 }));
    expect(root.querySelector('[data-role="missing"] button')).toBe(open);
  });

  it('drops a pending delete confirmation when a job starts', () => {
    const view = createDashboardView(root, recorder().handlers, FMT);
    view.update(data());
    button('route', 'Delete')!.click();
    const processing = SAMPLE.map((s) => (s.id === 'route' ? { ...s, status: 'processing' as const } : s));
    view.update(data({ sessions: processing }));
    expect(button('route', 'Cancel')).toBeUndefined();
    view.update(data({ sessions: SAMPLE.map((s) => (s.id === 'route' ? { ...s, status: 'ready' as const } : s)) }));
    expect(button('route', 'Cancel')).toBeUndefined();
    expect(button('route', 'Delete')?.disabled).toBe(false);
  });

  it('keeps keyboard focus on a control that was re-rendered', () => {
    const r = recorder();
    const view = createDashboardView(root, r.handlers, FMT);
    view.update(data());
    button('route', 'Delete')!.focus();
    const before = button('route', 'Delete');
    // A status change that relabels Transcribe → Retry rebuilds that row's buttons.
    view.update(data({ sessions: SAMPLE.map((s) => (s.id === 'route' ? { ...s, status: 'failed' as const } : s)) }));
    expect(button('route', 'Retry')).toBeDefined();
    expect(button('route', 'Delete')).not.toBe(before);
    expect(document.activeElement).toBe(button('route', 'Delete'));
  });
});
