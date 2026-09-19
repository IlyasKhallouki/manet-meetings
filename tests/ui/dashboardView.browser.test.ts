import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Route, SessionMeta } from '@lib/types';
import { createDashboardView, type DashboardData, type DashboardHandlers, type DashboardView } from '@lib/ui/dashboardView';

const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const T0 = Date.UTC(2026, 8, 19, 8, 0, 0);
const MB = 1024 * 1024;

function meta(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt: T0,
    status: 'ready',
    route: 'team',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 10, bytes: 2 * MB, micIncluded: true },
    captionCount: 12,
    ...patch,
  };
}

const speakers = (...names: string[]) =>
  names.map((name, i) => ({ name, self: name === 'Vous', firstAt: i, lastAt: i + 1, talkMs: 1 }));

const SAMPLE: SessionMeta[] = [
  meta('saved', {
    startedAt: T0 - 86_400_000,
    status: 'saved',
    meetingTitle: 'Weekly sync',
    durationMs: 3_723_000,
    notion: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Ilya' },
    speakers: speakers('Marie Curie', 'Vous', 'Tom Martin'),
  }),
  meta('rec', {
    startedAt: T0 + 3_600_000,
    status: 'recording',
    meetCode: 'xyz-abcd-efg',
    meetingTitle: 'Pricing call',
    route: undefined,
    // Healthy: the last chunk 2 s before `now`, captions coming in.
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 10, bytes: 2 * MB, micIncluded: true, lastChunkAt: T0 + 3_663_000 },
  }),
  meta('proc', {
    startedAt: T0 + 60_000,
    status: 'processing',
    stage: 'summarizing',
    route: 'personal',
    meetingTitle: 'Design review',
    job: { id: 'j', kind: 'process', startedAt: T0 + 3_600_000 },
  }),
  meta('failed', { startedAt: T0 + 30_000, status: 'failed', error: 'Saving to Notion failed: rate limited' }),
  meta('route', { startedAt: T0 + 120_000, status: 'awaiting-route', durationMs: 600_000, recovered: true, route: undefined }),
  meta('dup', {
    startedAt: T0 - 172_800_000,
    status: 'duplicate',
    meetingTitle: 'Standup',
    notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Marie' },
  }),
];

function data(patch: Partial<DashboardData> = {}): DashboardData {
  return {
    sessions: SAMPLE,
    resultIds: new Set(['failed', 'saved']),
    audioOnDisk: new Map([['saved', 3 * MB]]),
    missing: [],
    geminiKeyMissing: false,
    autoTranscribe: true,
    retentionDays: 7,
    now: T0 + 3_600_000 + 65_000,
    ...patch,
  };
}

const withSession = (id: string, patch: Partial<SessionMeta>) => SAMPLE.map((s) => (s.id === id ? { ...s, ...patch } : s));

interface Call {
  action: string;
  id: string;
  route?: Route;
  force?: boolean;
  on?: boolean;
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
    transcribe: (id, opts) => pending({ action: 'transcribe', id, ...(opts.force ? { force: true } : {}) }),
    save: (id, opts) => pending({ action: 'save', id, ...(opts.force ? { force: true } : {}) }),
    remove: (id) => pending({ action: 'remove', id }),
    route: (id, route) => pending({ action: 'route', id, route }),
    setAutoTranscribe: (on) => pending({ action: 'auto', id: '', on }),
    openSettings: () => {
      settingsOpened++;
    },
  };
  return { calls, settle, handlers, settingsOpened: () => settingsOpened };
}

let root: HTMLElement;
let view: DashboardView | undefined;

beforeEach(() => {
  root = document.createElement('main');
  document.body.append(root);
});

afterEach(() => {
  view?.destroy();
  view = undefined;
  root.remove();
});

function mountView(r = recorder(), d: DashboardData = data()) {
  view = createDashboardView(root, r.handlers, FMT);
  view.update(d);
  return r;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (id: string) => root.querySelector<HTMLLIElement>(`li[data-id="${id}"]`)!;
const cell = (id: string, name: string) => row(id).querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
const keyed = (key: string) => root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
const primary = (id: string) => keyed(`${id}:primary`) as HTMLButtonElement;
const more = (id: string) => keyed(`${id}:more`) as HTMLButtonElement;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const shown = (el: Element | null | undefined) => el instanceof HTMLElement && el.getClientRects().length > 0;
const menuEl = () => root.querySelector<HTMLElement>('[role="menu"]')!;
const menuOpen = () => menuEl().matches(':popover-open');
const menuLabels = () => [...menuEl().querySelectorAll('[role="menuitem"]')].map((el) => el.firstChild?.textContent);
const menuItem = (kind: string) => menuEl().querySelector<HTMLElement>(`[data-key="menu:${kind}"]`)!;
const sectionTitles = () => [...root.querySelectorAll('section h2')].map((h) => text(h));
const sectionIds = (title: string) => {
  const section = [...root.querySelectorAll('section')].find((s) => text(s.querySelector('h2')) === title)!;
  return [...section.querySelectorAll('li[data-id]')].map((li) => (li as HTMLElement).dataset.id);
};
const key = (target: Element, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('Meetings: grouping and rows', () => {
  it('puts what needs you on top, then one group per day, newest first', () => {
    mountView();
    expect(sectionTitles()).toEqual(['Needs you', 'Today', 'Yesterday', 'Thursday 17 September']);
    // Waiting for a destination; failed with no retry scheduled.
    expect(sectionIds('Needs you')).toEqual(['route', 'failed']);
    expect(sectionIds('Today')).toEqual(['rec', 'proc']);
    expect(sectionIds('Yesterday')).toEqual(['saved']);
    expect(sectionIds('Thursday 17 September')).toEqual(['dup']);
  });

  it('hides the Needs you group when nothing needs you', () => {
    mountView(recorder(), data({ sessions: SAMPLE.filter((s) => s.id !== 'route' && s.id !== 'failed') }));
    expect(sectionTitles()).toEqual(['Today', 'Yesterday', 'Thursday 17 September']);
  });

  it('uses list and heading semantics', () => {
    mountView();
    for (const list of root.querySelectorAll('section ul')) expect(list.getAttribute('role')).toBe('list');
    const li = row('saved');
    expect(li.tabIndex).toBe(-1);
    expect(text(document.getElementById(li.getAttribute('aria-labelledby')!))).toBe('Weekly sync');
    expect(li.querySelector('h3')).not.toBeNull();
  });

  it('shows time, title, the roll as byline, and length', () => {
    mountView();
    expect(text(cell('saved', 'time'))).toBe('08:00');
    expect(text(cell('saved', 'meeting'))).toContain('Weekly sync');
    // The roll: first speech order, the local user as "you"; bytes on disk win.
    expect(text(root.querySelector('li[data-id="saved"] .meeting-byline'))).toBe(
      '08:00 · 1 h 2 min · Marie Curie, you, Tom Martin · 3.0 MB audio',
    );
    expect(text(cell('saved', 'duration'))).toBe('1 h 2 min');
    expect(text(cell('rec', 'duration'))).toBe('1:05');
    // Stacked, the clock moves beside "Recording" and the byline keeps the start time only.
    expect(text(root.querySelector('li[data-id="rec"] .meeting-clock'))).toBe('1:05');
    expect(text(root.querySelector('li[data-id="rec"] .meeting-when'))).toBe('09:00 ·');
    expect(text(cell('route', 'meeting'))).toContain('Recovered after a restart');
    // The meet code rides along while recording.
    expect(text(cell('rec', 'meeting'))).toContain('xyz-abcd-efg');
  });

  it('dates a Needs you row that is not from today', () => {
    const old = meta('old', { startedAt: T0 - 86_400_000 - 3_600_000, status: 'processed', meetingTitle: 'Old one' });
    mountView(recorder(), data({ sessions: [...SAMPLE, old], resultIds: new Set(['old']) }));
    expect(sectionIds('Needs you')).toEqual(['route', 'failed', 'old']);
    // Wide: the day under the time; stacked: before it. The same words as the popup.
    expect(text(cell('old', 'time'))).toBe('07:00 Yesterday');
    expect(text(root.querySelector('li[data-id="old"] .meeting-when'))).toMatch(/^Yesterday 07:00 ·/);
    expect(text(cell('route', 'time'))).toBe('08:02 Today');
    const older = meta('older', { startedAt: T0 - 3 * 86_400_000, status: 'processed', meetingTitle: 'Older' });
    view!.update(data({ sessions: [...SAMPLE, older], resultIds: new Set(['older']) }));
    expect(text(cell('older', 'time'))).toBe('08:00 Wed 16 Sep');
    expect(text(root.querySelector('li[data-id="older"] .meeting-when'))).toMatch(/^Wed 16 Sep 08:00 ·/);
    // Day groups keep the time alone: their header is the day.
    expect(text(cell('saved', 'time'))).toBe('08:00');
  });

  it('sets a Meet code standing in for the title in mono, as the popup does', () => {
    mountView();
    expect(row('failed').querySelector('h3')!.classList.contains('mono')).toBe(true);
    expect(text(row('failed').querySelector('h3'))).toBe('abc-defg-hij');
    expect(row('saved').querySelector('h3')!.classList.contains('mono')).toBe(false);
  });

  it('falls back to transcript attendees for older meetings', () => {
    mountView(recorder(), data({ attendees: new Map([['dup', ['Julien', 'Sofia']]]) }));
    expect(text(root.querySelector('li[data-id="dup"] .meeting-byline'))).toContain('Julien, Sofia');
    expect(text(root.querySelector('li[data-id="failed"] .meeting-byline'))).toContain('No speakers');
  });
});

describe('Meetings: status', () => {
  it('shows a glyph and a word for every status, plus destination and stage', () => {
    mountView();
    const status = (id: string) => cell(id, 'status');
    expect(status('rec').querySelector('.status-line')?.getAttribute('data-tone')).toBe('live');
    expect(text(status('rec').querySelector('.status-word'))).toBe('Recording 1:05');
    expect(text(status('proc').querySelector('.status-word'))).toBe('Summarizing');
    expect(text(status('proc').querySelector('.meeting-detail'))).toBe('Personal · writing the summary');
    expect(status('proc').querySelector('progress')?.getAttribute('aria-label')).toBe('Step 7 of 8');
    expect(text(status('proc').querySelector('.meeting-step'))).toBe('Step 7 of 8 · running for 1 min');
    expect(text(status('failed').querySelector('.status-word'))).toBe('Couldn’t save to Notion');
    expect(text(status('failed'))).toContain('Saving to Notion failed: rate limited');
    expect(text(status('dup').querySelector('.status-word'))).toBe('Saved by Marie');
    expect(text(status('dup').querySelector('.meeting-detail'))).toBe('Team · your copy wasn’t added');
    // Every status glyph is an inline SVG.
    for (const li of root.querySelectorAll('li[data-id]')) expect(li.querySelector('.status-head svg.glyph')).not.toBeNull();
  });

  it('keeps red for recording only: no filled buttons in the list', () => {
    mountView();
    expect(root.querySelectorAll('.btn.prominent, .btn.live').length).toBe(0);
    expect(root.querySelectorAll('.tone-live').length).toBe(1);
  });

  it('says when a failed transcription is tried again, and leaves it out of Needs you', () => {
    const retryAt = Date.UTC(2026, 8, 19, 9, 40, 0);
    mountView(
      recorder(),
      data({
        sessions: withSession('failed', { retryAt, error: 'Gemini unreachable: HTTP 503. Retrying automatically at 11:40.' }),
        resultIds: new Set(),
      }),
    );
    const status = text(cell('failed', 'status'));
    expect(status).toContain('Trying again at 09:40');
    expect(status).toContain('Gemini unreachable: HTTP 503.');
    expect(status).not.toContain('11:40');
    expect(text(primary('failed'))).toBe('Try now');
    expect(sectionIds('Needs you')).toEqual(['route']);
  });

  it('warns on a recording whose captions or audio are not coming through, with ▲', () => {
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    const r = mountView(recorder(), data({ sessions: withSession('rec', { captionsError: why, audio: { ...SAMPLE[1]!.audio, error: 'x' } }) }));
    const warning = cell('rec', 'status').querySelector('[data-role="captions-warning"]');
    expect(text(warning)).toBe('Captions aren’t coming through');
    expect(warning?.querySelector('svg.glyph-caution')).not.toBeNull();
    expect(text(cell('rec', 'status').querySelector('[data-role="captions-detail"]'))).toBe(why);
    expect(text(cell('rec', 'status').querySelector('[data-role="audio-warning"]'))).toBe(
      'No call audio — saving captions only',
    );
    view!.update(data());
    expect(cell('rec', 'status').querySelector('[data-role="captions-warning"]')).toBeNull();
    expect(cell('rec', 'status').querySelector('[data-role="audio-warning"]')).toBeNull();
    expect(r.calls).toEqual([]);
  });

  it('warns about what the popup and the toolbar "!" warn about: stalled audio, no captions', () => {
    const now = data().now;
    const warnings = () => [...cell('rec', 'status').querySelectorAll('.meeting-caution')].map((el) => text(el));
    // No chunk for 20 s; no caption at all 65 s in.
    mountView(
      recorder(),
      data({ sessions: withSession('rec', { audio: { ...SAMPLE[1]!.audio, lastChunkAt: now - 20_000 }, captionCount: 0 }) }),
    );
    expect(warnings()).toEqual(['No audio for 20 s', 'No captions yet — turn on captions (CC) in Meet']);
    expect(text(cell('rec', 'status').querySelector('[data-role="audio-detail"]'))).toBe(
      'Captions are still being saved. If audio doesn’t resume, the transcript will come from captions.',
    );
    // Named speakers, the last caption 6 min ago: the popup's "No captions for 6 min".
    const speakers = [{ name: 'Marie Curie', self: false, firstAt: 0, lastAt: 0, talkMs: 1000 }];
    view!.update(data({ sessions: withSession('rec', { speakers }), now: T0 + 3_600_000 + 6 * 60_000 + 5000 }));
    expect(warnings()).toContain('No captions for 6 min');
    // Healthy again: the status reads "Recording" alone.
    view!.update(data());
    expect(warnings()).toEqual([]);
    expect(text(cell('rec', 'status'))).toBe('Recording 1:05');
  });

  it('says where a meeting waiting for a destination goes if nobody chooses, and when', () => {
    // The background writes the default's time on the meeting (SessionMeta.routeDeadline).
    const waiting = (deadline?: number) =>
      SAMPLE.map((s) => (s.id === 'route' ? { ...s, routeDeadline: deadline } : s));
    mountView(recorder(), data({ defaultRoute: 'team', sessions: waiting(T0 + 3_600_000 + 100_000) }));
    const note = () => row('route').querySelector('[data-role="route-default"]');
    expect(text(note())).toBe('If you don’t choose, it goes to Team at 09:01.');
    // Paused in the routing window: no deadline, still the default.
    view!.update(data({ defaultRoute: 'personal', sessions: waiting(undefined) }));
    expect(text(note())).toBe('If you don’t choose, it goes to Personal.');
    // Resumed: a new countdown.
    view!.update(data({ defaultRoute: 'personal', sessions: waiting(T0 + 3_600_000 + 220_000) }));
    expect(text(note())).toBe('If you don’t choose, it goes to Personal at 09:03.');
    // Only while nothing is chosen.
    expect(shown(row('saved').querySelector('[data-role="route-default"]'))).toBe(false);
    view!.update(data({ sessions: withSession('route', { status: 'ready', route: 'team' }), defaultRoute: 'team' }));
    expect(shown(note())).toBe(false);
  });

  it('turns "Settings" in an error into a way there', () => {
    const r = mountView(
      recorder(),
      data({
        sessions: withSession('failed', {
          error: 'Missing settings: Notion integration token. Add them in Settings, then try again.',
        }),
      }),
    );
    expect(text(cell('failed', 'status'))).toContain('Add a Notion token in Settings, then try again.');
    keyed('failed:settings')!.click();
    expect(r.settingsOpened()).toBe(1);
  });
});

describe('Meetings: the next step', () => {
  it('offers one bordered next step per row, or a link to Notion', () => {
    mountView();
    const label = (id: string) => (shown(primary(id)) ? text(primary(id)) : null);
    expect(label('rec')).toBe('Stop recording');
    expect(label('route')).toBeNull();
    expect(label('proc')).toBeNull();
    expect(label('failed')).toBe('Try again');
    expect(label('saved')).toBeNull();
    const open = keyed('saved:open') as HTMLAnchorElement;
    expect(shown(open)).toBe(true);
    expect(open.href).toBe('https://www.notion.so/p1');
    expect(open.target).toBe('_blank');
    expect(open.rel).toContain('noopener');
    expect(text(open)).toBe('Open in Notion');
    // Each names its meeting for screen readers.
    expect(text(document.getElementById(primary('failed').getAttribute('aria-describedby')!))).toBe('abc-defg-hij');
    expect(more('saved').getAttribute('aria-label')).toBe('More actions for Weekly sync');
  });

  it('runs it; while pending the button is aria-disabled and keeps focus (C4)', async () => {
    const r = mountView();
    const button = primary('failed');
    button.focus();
    button.click();
    expect(r.calls).toEqual([{ action: 'save', id: 'failed' }]);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    // A second click while pending does nothing.
    button.click();
    expect(r.calls.length).toBe(1);
    // Other rows are unaffected.
    expect(primary('rec').getAttribute('aria-disabled')).toBeNull();
    r.settle[0]!.resolve();
    await flush();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('shows a failed request in its row, with ▲', async () => {
    const r = mountView();
    primary('failed').click();
    r.settle[0]!.reject(new Error('Cannot save a session that is saving.'));
    await flush();
    const alert = row('failed').querySelector('[role="alert"]');
    expect(text(alert)).toBe('Cannot save a session that is saving.');
    expect(alert?.querySelector('svg.glyph-caution')).not.toBeNull();
    primary('failed').click();
    expect(row('failed').querySelector('[role="alert"]')).toBeNull();
  });

  it('updates in place, so a click or focus is never lost to a clock tick', () => {
    mountView();
    const stop = primary('rec');
    const moreSaved = more('saved');
    const recRow = row('rec');
    const later = withSession('rec', { audio: { ...SAMPLE[1]!.audio, bytes: 3 * MB }, lastHeartbeat: 1 });
    view!.update(data({ sessions: later, now: T0 + 3_600_000 + 125_000 }));
    expect(row('rec')).toBe(recRow);
    expect(primary('rec')).toBe(stop);
    expect(more('saved')).toBe(moreSaved);
    expect(text(cell('rec', 'duration'))).toBe('2:05');
  });

  it('moves focus to the row when its focused control goes away', () => {
    mountView();
    primary('rec').focus();
    // Stopped elsewhere: Stop disappears and the row moves to Needs you.
    view!.update(data({ sessions: withSession('rec', { status: 'awaiting-route', durationMs: 130_000 }) }));
    expect(shown(primary('rec'))).toBe(false);
    expect(sectionIds('Needs you')).toContain('rec');
    expect(document.activeElement).toBe(row('rec'));
  });
});

describe('Meetings: Team | Personal', () => {
  it('asks for a destination with two buttons, not a select', () => {
    mountView();
    const group = cell('route', 'status').querySelector<HTMLElement>('[role="group"].segmented')!;
    expect(group.getAttribute('aria-label')).toBe('Save “abc-defg-hij” to');
    const segments = [...group.querySelectorAll<HTMLButtonElement>('button.segment')];
    expect(segments.map((s) => [text(s), s.getAttribute('aria-pressed')])).toEqual([
      ['Team', 'false'],
      ['Personal', 'false'],
    ]);
    expect(root.querySelector('select')).toBeNull();
    // Only rows waiting for a destination or not transcribed yet show it.
    expect(cell('proc', 'status').querySelector('.segmented')).toBeNull();
  });

  it('arrow keys move focus only; activation commits, and focus stays through the move', async () => {
    const r = mountView();
    const team = keyed('route:route-team')!;
    const personal = keyed('route:route-personal')!;
    team.focus();
    key(team, 'ArrowRight');
    expect(document.activeElement).toBe(personal);
    expect(r.calls).toEqual([]);

    personal.click();
    expect(r.calls).toEqual([{ action: 'route', id: 'route', route: 'personal' }]);
    expect(personal.getAttribute('aria-pressed')).toBe('true');
    expect(personal.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(personal);
    r.settle[0]!.resolve();
    await flush();

    // Routed (auto-transcribe off): the row leaves Needs you, the control stays pressed.
    view!.update(data({ sessions: withSession('route', { status: 'ready', route: 'personal' }) }));
    expect(sectionIds('Needs you')).toEqual(['failed']);
    expect(personal.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(personal);
    expect(text(primary('route'))).toBe('Transcribe');
  });

  it('does nothing when the chosen destination is pressed again', () => {
    const r = mountView(recorder(), data({ sessions: withSession('route', { status: 'ready', route: 'team' }) }));
    keyed('route:route-team')!.click();
    expect(r.calls).toEqual([]);
    keyed('route:route-personal')!.click();
    expect(r.calls).toEqual([{ action: 'route', id: 'route', route: 'personal' }]);
  });
});

describe('Meetings: ⋯ menu', () => {
  it('lists the row’s other actions; Esc returns focus to ⋯', () => {
    mountView();
    const button = more('failed');
    button.focus();
    button.click(); // keyboard activation (detail 0): focus on the first item
    expect(menuOpen()).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(menuLabels()).toEqual(['Transcribe again', 'Save to Personal instead', 'Delete…']);
    expect(document.activeElement).toBe(menuItem('transcribe'));
    key(document.activeElement!, 'Escape');
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('is one element outside the rows, and survives re-renders that change nothing', () => {
    mountView();
    more('rec').click();
    const item = menuItem('delete');
    expect(row('rec').contains(menuEl())).toBe(false);
    view!.update(data({ now: T0 + 3_600_000 + 70_000 }));
    expect(menuOpen()).toBe(true);
    expect(menuItem('delete')).toBe(item);
  });

  it('closes when that row’s actions change, returning focus to ⋯', () => {
    mountView();
    more('route').click();
    expect(document.activeElement).toBe(menuItem('delete'));
    view!.update(data({ sessions: withSession('route', { status: 'processing', route: 'team' }) }));
    expect(menuOpen()).toBe(false);
    expect(document.activeElement).toBe(more('route'));
  });

  it('says why Delete… is unavailable while a job runs', () => {
    mountView();
    more('proc').click();
    const item = menuItem('delete');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(text(item)).toBe('Delete…Wait for it to finish');
    item.click();
    expect(menuOpen()).toBe(true);
  });

  it('saves to the other destination instead: the destination, then the save', async () => {
    const r = mountView();
    more('failed').click();
    menuItem('reroute').click();
    expect(r.calls).toEqual([{ action: 'route', id: 'failed', route: 'personal' }]);
    r.settle[0]!.resolve();
    await flush();
    expect(r.calls[1]).toEqual({ action: 'save', id: 'failed' });
  });
});

describe('Meetings: inline confirms', () => {
  it('confirms Delete… in the row; Cancel and Esc back out to ⋯', () => {
    const r = mountView();
    more('saved').click();
    menuItem('delete').click();
    expect(r.calls).toEqual([]);
    expect(row('saved').classList.contains('is-confirming')).toBe(true);
    const confirm = row('saved').querySelector('.meeting-confirm')!;
    // The question names the meeting: it reads on its own and labels the group.
    expect(text(confirm.querySelector('.meeting-question'))).toBe(
      'Delete the recording, captions and transcript of “Weekly sync”? The Notion page stays.',
    );
    const group = confirm.querySelector('[role="group"]')!;
    expect(text(document.getElementById(group.getAttribute('aria-labelledby')!))).toContain('“Weekly sync”');
    // Cancel leads, the action trails; no Yes/No, nothing red.
    expect([...confirm.querySelectorAll('button')].map((b) => text(b))).toEqual(['Cancel', 'Delete']);
    expect(confirm.querySelector('.live, .prominent')).toBeNull();
    expect(document.activeElement).toBe(keyed('saved:cancel'));

    keyed('saved:cancel')!.click();
    expect(row('saved').classList.contains('is-confirming')).toBe(false);
    expect(document.activeElement).toBe(more('saved'));

    more('saved').click();
    menuItem('delete').click();
    key(keyed('saved:cancel')!, 'Escape');
    expect(keyed('saved:cancel')).toBeNull();
    expect(document.activeElement).toBe(more('saved'));
  });

  it('deletes, then focuses the next row’s first control (C4)', async () => {
    const r = mountView();
    more('saved').click();
    menuItem('delete').click();
    keyed('saved:confirm')!.focus();
    keyed('saved:confirm')!.click();
    expect(r.calls).toEqual([{ action: 'remove', id: 'saved' }]);
    expect(keyed('saved:confirm')!.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(keyed('saved:confirm'));
    r.settle[0]!.resolve();
    await flush();
    view!.update(data({ sessions: SAMPLE.filter((s) => s.id !== 'saved') }));
    expect(row('saved')).toBeNull();
    // saved was followed by dup, whose first control is its Notion link.
    expect(document.activeElement).toBe(keyed('dup:open'));
  });

  it('after deleting the last row, focuses the one before it', async () => {
    const r = mountView();
    more('dup').click();
    menuItem('delete').click();
    keyed('dup:confirm')!.click();
    r.settle[0]!.resolve();
    await flush();
    view!.update(data({ sessions: SAMPLE.filter((s) => s.id !== 'dup') }));
    expect(document.activeElement).toBe(keyed('saved:open'));
  });

  it('asks differently while recording', () => {
    mountView();
    more('rec').click();
    menuItem('delete').click();
    expect(text(row('rec').querySelector('.meeting-question'))).toBe('Stop and delete “Pricing call”?');
  });

  it('sets a Meet code in the question in mono, and leaves out a Notion page there is none of', () => {
    mountView();
    more('failed').click();
    menuItem('delete').click();
    const question = row('failed').querySelector('.meeting-question')!;
    expect(text(question)).toBe('Delete the recording, captions and transcript of “abc-defg-hij”?');
    expect(text(question.querySelector('.mono'))).toBe('abc-defg-hij');
  });

  it('replaces "anyway" with Save a second copy…, confirmed inline', async () => {
    const r = mountView();
    expect(text(root)).not.toMatch(/anyway/i);
    more('dup').click();
    expect(menuLabels()).toEqual(['Save a second copy…', 'Save to Personal instead', 'Delete…']);
    menuItem('second-copy').click();
    expect(text(row('dup').querySelector('.meeting-question'))).toBe(
      'Marie already saved “Standup”. Saving yours adds a second page in Notion.',
    );
    expect([...row('dup').querySelectorAll('.meeting-confirm button')].map((b) => text(b))).toEqual([
      'Cancel',
      'Save second copy',
    ]);
    keyed('dup:confirm')!.focus();
    keyed('dup:confirm')!.click();
    // No stored transcript yet: transcribe, skipping the Notion check.
    expect(r.calls).toEqual([{ action: 'transcribe', id: 'dup', force: true }]);
    r.settle[0]!.resolve();
    await flush();
    expect(keyed('dup:confirm')).toBeNull();
    expect(document.activeElement).toBe(more('dup'));

    view!.update(data({ resultIds: new Set(['failed', 'saved', 'dup']) }));
    more('dup').click();
    menuItem('second-copy').click();
    keyed('dup:confirm')!.click();
    expect(r.calls[1]).toEqual({ action: 'save', id: 'dup', force: true });
  });

  it('drops a confirmation when a job starts meanwhile', () => {
    mountView();
    more('route').click();
    menuItem('delete').click();
    view!.update(data({ sessions: withSession('route', { status: 'processing', route: 'team' }) }));
    expect(keyed('route:cancel')).toBeNull();
    view!.update(data({ sessions: withSession('route', { status: 'ready', route: 'team' }) }));
    expect(keyed('route:cancel')).toBeNull();
  });
});

describe('Meetings: page', () => {
  it('says when saving is blocked, in people’s words, and opens Settings', () => {
    const r = mountView(recorder(), data({ missing: ['Notion integration token', 'Your name'] }));
    const notice = root.querySelector('[data-role="missing"]')!;
    expect(text(notice)).toContain('Meetings can’t be saved to Notion yet');
    expect(text(notice)).toContain('Add your name and a Notion token.');
    expect(notice.querySelector('svg.glyph-caution')).not.toBeNull();
    notice.querySelector('button')!.click();
    expect(r.settingsOpened()).toBe(1);
    view!.update(data({ missing: [] }));
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
  });

  it('says a missing Gemini key means captions-only transcripts, as a note', () => {
    const r = mountView(recorder(), data({ geminiKeyMissing: true }));
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
    const notice = root.querySelector('[data-role="no-gemini"]')!;
    expect(text(notice)).toContain('No Gemini key: transcripts will come from Meet’s captions only.');
    notice.querySelector('button')!.click();
    expect(r.settingsOpened()).toBe(1);
  });

  it('shows one notice at a time, as the popup does: the Gemini note only once saving works', () => {
    mountView(recorder(), data({ missing: ['Your name'], geminiKeyMissing: true }));
    expect(root.querySelector('[data-role="missing"]')).not.toBeNull();
    expect(root.querySelector('[data-role="no-gemini"]')).toBeNull();
    view!.update(data({ missing: [], geminiKeyMissing: true }));
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
    expect(root.querySelector('[data-role="no-gemini"]')).not.toBeNull();
  });

  it('does not rebuild the notices on a clock tick', () => {
    mountView(recorder(), data({ missing: ['Your name'] }));
    const open = root.querySelector('[data-role="missing"] button');
    view!.update(data({ missing: ['Your name'], now: T0 + 3_600_000 + 70_000 }));
    expect(root.querySelector('[data-role="missing"] button')).toBe(open);
  });

  it('ends with where the audio is and how long it stays', () => {
    mountView();
    // saved 3 MB (disk) + rec, proc, failed, route, dup 2 MB each.
    expect(text(root.querySelector('[data-role="storage"]'))).toBe(
      'Audio on this computer: 13.0 MB for 6 meetings. It’s deleted 7 days after a meeting is saved to Notion.',
    );
  });

  it('has an auto-transcribe switch that stays focusable while its change is pending', async () => {
    const r = mountView(recorder(), data({ autoTranscribe: true }));
    const toggle = root.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(text(toggle.labels?.[0])).toBe('Transcribe automatically');
    expect(toggle.checked).toBe(true);

    toggle.focus();
    toggle.click();
    expect(r.calls).toEqual([{ action: 'auto', id: '', on: false }]);
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(toggle);
    // A pending switch can't flip back.
    toggle.click();
    expect(toggle.checked).toBe(false);
    // A re-render before the settings change lands keeps the choice.
    view!.update(data({ autoTranscribe: true }));
    expect(toggle.checked).toBe(false);
    r.settle[0]!.resolve();
    await flush();
    view!.update(data({ autoTranscribe: false }));
    expect(toggle.getAttribute('aria-disabled')).toBeNull();
    expect(toggle.checked).toBe(false);

    // Changed elsewhere (Settings page).
    view!.update(data({ autoTranscribe: true }));
    expect(toggle.checked).toBe(true);

    toggle.click();
    r.settle[1]!.reject(new Error('Storage is full.'));
    await flush();
    expect(toggle.checked).toBe(true);
    const alert = root.querySelector('[data-role="auto-transcribe"] [role="alert"]');
    expect(text(alert)).toBe('Storage is full.');
    expect(alert?.querySelector('svg.glyph-caution')).not.toBeNull();
  });

  it('shows an empty state with the next step, and the pin hint only when unpinned', () => {
    mountView(recorder(), data({ sessions: [] }));
    expect(root.querySelectorAll('li[data-id]').length).toBe(0);
    const empty = root.querySelector('[data-role="empty"]')!;
    expect(shown(empty)).toBe(true);
    expect(text(empty)).toContain('No meetings yet');
    expect(text(empty)).toContain('Join a Google Meet call, click Manet Meetings in the toolbar and choose Record this call.');
    const pin = empty.querySelector('.meetings-empty-pin');
    expect(shown(pin)).toBe(false);
    expect(shown(root.querySelector('[data-role="storage"]'))).toBe(false);
    view!.update(data({ sessions: [], pinHint: true }));
    expect(shown(pin)).toBe(true);
    expect(text(pin)).toBe('Pin it to the toolbar from Chrome’s Extensions menu so it’s one click away.');
    view!.update(data());
    expect(shown(empty)).toBe(false);
  });

  it('announces meetings that finish while the page is open, politely', async () => {
    mountView();
    const announcer = root.querySelector('[data-role="announcer"]')!;
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    await new Promise((r) => setTimeout(r, 80));
    expect(text(announcer)).toBe('');

    view!.update(
      data({
        sessions: SAMPLE.map((s) =>
          s.id === 'proc'
            ? { ...s, status: 'saved' as const, stage: undefined, notion: { pageId: 'p3', url: 'https://www.notion.so/p3' } }
            : s,
        ),
      }),
    );
    await new Promise((r) => setTimeout(r, 80));
    expect(text(announcer)).toBe('Saved to Notion: Design review.');
  });
});
