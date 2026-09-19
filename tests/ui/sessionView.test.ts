import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '@lib/types';
import {
  canChooseRoute,
  compareSessions,
  formatDateTime,
  sessionActions,
  sessionRow,
  stageLabel,
  statusView,
  storageSummary,
} from '@lib/ui/sessionView';

const STARTED = Date.UTC(2026, 8, 19, 8, 15, 0);
const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;

function meta(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    startedAt: STARTED,
    status: 'ready',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 12, bytes: 3 * 1024 * 1024, micIncluded: true },
    captionCount: 40,
    ...patch,
  };
}

const ALL: SessionStatus[] = [
  'recording',
  'awaiting-route',
  'ready',
  'processing',
  'processed',
  'saving',
  'saved',
  'duplicate',
  'failed',
];

function enabled(status: SessionStatus, hasResult = false) {
  const a = sessionActions(meta({ status }), { hasResult });
  return Object.entries(a)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k)
    .sort();
}

describe('sessionActions', () => {
  it('mirrors what the background accepts for each status', () => {
    expect(enabled('recording')).toEqual(['delete', 'stop']);
    expect(enabled('awaiting-route')).toEqual(['delete', 'transcribe']);
    expect(enabled('ready')).toEqual(['delete', 'transcribe']);
    expect(enabled('processing')).toEqual([]);
    expect(enabled('processed', true)).toEqual(['delete', 'save', 'transcribe']);
    expect(enabled('saving', true)).toEqual([]);
    expect(enabled('saved', true)).toEqual(['delete']);
    expect(enabled('duplicate')).toEqual(['delete']);
    expect(enabled('failed')).toEqual(['delete', 'transcribe']);
    expect(enabled('failed', true)).toEqual(['delete', 'save', 'transcribe']);
  });

  it('never offers Save without a stored result', () => {
    expect(sessionActions(meta({ status: 'processed' }), { hasResult: false }).save.enabled).toBe(false);
  });

  it('disables everything while a request for the session is pending', () => {
    for (const status of ALL) {
      const a = sessionActions(meta({ status }), { hasResult: true, pending: true });
      expect(Object.values(a).some((v) => v.enabled)).toBe(false);
    }
  });

  it('hides actions that make no sense for the status, and shows the rest', () => {
    const visible = (status: SessionStatus, hasResult = false) =>
      Object.entries(sessionActions(meta({ status }), { hasResult }))
        .filter(([, v]) => v.visible)
        .map(([k]) => k)
        .sort();
    expect(visible('recording')).toEqual(['delete', 'stop']);
    expect(visible('ready')).toEqual(['delete', 'transcribe']);
    // Shown but disabled while a job runs, so the row does not jump around.
    expect(visible('processing')).toEqual(['delete', 'transcribe']);
    expect(visible('saving')).toEqual(['delete', 'save', 'transcribe']);
    expect(visible('saved')).toEqual(['delete']);
    expect(visible('duplicate')).toEqual(['delete']);
    expect(visible('failed')).toEqual(['delete', 'transcribe']);
    expect(visible('failed', true)).toEqual(['delete', 'save', 'transcribe']);
  });

  it('every visible but disabled action explains why', () => {
    for (const status of ALL) {
      for (const hasResult of [false, true]) {
        for (const [name, a] of Object.entries(sessionActions(meta({ status }), { hasResult }))) {
          if (a.visible && !a.enabled) expect(a.hint, `${status}/${name}`).toBeTruthy();
        }
      }
    }
  });

  it('marks exactly one primary action when something can be done next', () => {
    const primary = (status: SessionStatus, hasResult = false) =>
      Object.entries(sessionActions(meta({ status }), { hasResult }))
        .filter(([, v]) => v.primary)
        .map(([k]) => k);
    expect(primary('recording')).toEqual(['stop']);
    expect(primary('ready')).toEqual(['transcribe']);
    expect(primary('awaiting-route')).toEqual(['transcribe']);
    expect(primary('failed')).toEqual(['transcribe']);
    expect(primary('failed', true)).toEqual(['save']);
    expect(primary('processed', true)).toEqual(['save']);
    expect(primary('saved', true)).toEqual([]);
  });

  it('labels retries so the user knows what will run again', () => {
    expect(sessionActions(meta({ status: 'ready' }), { hasResult: false }).transcribe.label).toBe('Transcribe');
    expect(sessionActions(meta({ status: 'failed' }), { hasResult: false }).transcribe.label).toBe('Retry');
    const failedSave = sessionActions(meta({ status: 'failed' }), { hasResult: true });
    expect(failedSave.save.label).toBe('Retry save');
    expect(failedSave.transcribe.label).toBe('Transcribe again');
    expect(sessionActions(meta({ status: 'processed' }), { hasResult: true }).save.label).toBe('Save to Notion');
  });
});

describe('canChooseRoute', () => {
  it('allows choosing or changing the destination only where the background accepts it', () => {
    const allowed = ALL.filter((status) => canChooseRoute(meta({ status })));
    expect(allowed).toEqual(['awaiting-route', 'ready', 'processed', 'failed']);
  });
});

describe('statusView', () => {
  it('gives each status a label and a tone', () => {
    const tones = Object.fromEntries(ALL.map((s) => [s, statusView(meta({ status: s })).tone]));
    expect(tones).toEqual({
      recording: 'recording',
      'awaiting-route': 'waiting',
      ready: 'waiting',
      processing: 'busy',
      processed: 'waiting',
      saving: 'busy',
      saved: 'done',
      duplicate: 'done',
      failed: 'error',
    });
    for (const s of ALL) expect(statusView(meta({ status: s })).label.length).toBeGreaterThan(0);
  });

  it('shows the stage while processing', () => {
    const v = statusView(meta({ status: 'processing', stage: 'transcribing-timing' }));
    expect(v.label).toBe('Processing');
    expect(v.detail).toBe('Transcribing (timing pass)');
    expect(statusView(meta({ status: 'processing' })).detail).toBe('Starting');
  });

  it('flags a captions-only recording', () => {
    const v = statusView(meta({ status: 'recording', audio: { ...meta().audio, error: 'Tab capture failed' } }));
    expect(v.label).toBe('Recording');
    expect(v.detail).toBe('captions only');
  });

  it('names every job stage', () => {
    const stages = [
      'checking-duplicate',
      'loading-audio',
      'transcribing-timing',
      'transcribing-text',
      'aligning',
      'merging',
      'summarizing',
      'saving',
    ] as const;
    const labels = stages.map(stageLabel);
    expect(new Set(labels).size).toBe(stages.length);
  });
});

describe('formatDateTime', () => {
  it('formats in the given locale and zone', () => {
    expect(formatDateTime(STARTED, FMT)).toBe('Sat, 19 Sept 2026, 08:15');
  });
});

describe('sessionRow', () => {
  it('formats a saved session', () => {
    const row = sessionRow(
      meta({
        status: 'saved',
        meetingTitle: 'Weekly sync',
        durationMs: 3_723_000,
        route: 'team',
        notion: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Ilya' },
      }),
      { now: STARTED + 4_000_000, ...FMT },
    );
    expect(row).toMatchObject({
      id: 'abc-defg-hij_20260919T081500Z',
      title: 'Weekly sync',
      meetCode: 'abc-defg-hij',
      date: 'Sat, 19 Sept 2026, 08:15',
      duration: '1h 02m',
      audio: '3.0 MB',
      route: 'Team',
      recovered: false,
      notion: { url: 'https://www.notion.so/p1', label: 'Open in Notion' },
    });
    expect(row.error).toBeUndefined();
  });

  it('uses the meet code as the title when Meet gave none', () => {
    expect(sessionRow(meta(), { now: STARTED, ...FMT }).title).toBe('abc-defg-hij');
  });

  it('shows elapsed time while recording', () => {
    const row = sessionRow(meta({ status: 'recording' }), { now: STARTED + 125_000, ...FMT });
    expect(row.duration).toBe('2m 05s');
  });

  it('falls back to endedAt − startedAt, then to a dash', () => {
    expect(sessionRow(meta({ endedAt: STARTED + 60_000 }), { now: STARTED, ...FMT }).duration).toBe('1m 00s');
    expect(sessionRow(meta(), { now: STARTED, ...FMT }).duration).toBe('—');
  });

  it('prefers the bytes actually on disk over the recorder count', () => {
    expect(sessionRow(meta(), { now: STARTED, audioBytes: 1536, ...FMT }).audio).toBe('1.5 KB');
  });

  it('says when audio is gone or never existed', () => {
    const deleted = meta({ status: 'saved', audio: { ...meta().audio, deletedAt: STARTED + 1 } });
    expect(sessionRow(deleted, { now: STARTED, ...FMT }).audio).toBe('Deleted');
    const none = meta({ audio: { ...meta().audio, bytes: 0, chunkCount: 0, error: 'Tab capture failed' } });
    const row = sessionRow(none, { now: STARTED, ...FMT });
    expect(row.audio).toBe('None');
    expect(row.audioNote).toBe('Tab capture failed');
  });

  it('shows who saved a duplicate', () => {
    const row = sessionRow(
      meta({ status: 'duplicate', notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Marie' } }),
      { now: STARTED, ...FMT },
    );
    expect(row.notion).toEqual({ url: 'https://www.notion.so/p2', label: 'Already saved by Marie' });
    const anon = sessionRow(meta({ status: 'duplicate', notion: { pageId: 'p2', url: 'https://x' } }), {
      now: STARTED,
      ...FMT,
    });
    expect(anon.notion?.label).toBe('Already saved by a teammate');
  });

  it('carries the error, route and recovered flag', () => {
    const row = sessionRow(meta({ status: 'failed', error: 'Gemini said no', recovered: true }), {
      now: STARTED,
      ...FMT,
    });
    expect(row.error).toBe('Gemini said no');
    expect(row.recovered).toBe(true);
    expect(row.route).toBe('Not chosen');
    expect(sessionRow(meta({ route: 'personal' }), { now: STARTED, ...FMT }).route).toBe('Personal');
  });

  it('does not show a stale error once the session is saved', () => {
    const row = sessionRow(meta({ status: 'saved', error: 'old' }), { now: STARTED, ...FMT });
    expect(row.error).toBeUndefined();
  });
});

describe('storageSummary', () => {
  it('sums audio per session and reports origin usage', () => {
    const sessions = [meta({ id: 'a' }), meta({ id: 'b', audio: { ...meta().audio, bytes: 1024 } })];
    const s = storageSummary(sessions, new Map([['a', 2048]]), { usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 });
    expect(s.audioBytes).toBe(2048 + 1024);
    expect(s.audio).toBe('3.0 KB in 2 recordings');
    expect(s.usage).toBe('5.0 MB used of 100.0 MB available');
  });

  it('counts only sessions that still have audio and copes with a missing estimate', () => {
    const gone = meta({ id: 'c', audio: { ...meta().audio, deletedAt: 1 } });
    const s = storageSummary([gone, meta({ id: 'd' })], new Map([['d', 1024]]), null);
    expect(s.audio).toBe('1.0 KB in 1 recording');
    expect(s.usage).toBeUndefined();
  });
});

describe('compareSessions', () => {
  it('orders newest recording first, then by id descending, like listSessions', () => {
    const a = meta({ id: 'a', startedAt: 1 });
    const b = meta({ id: 'b', startedAt: 2 });
    const c = meta({ id: 'c', startedAt: 2 });
    expect([a, b, c].sort(compareSessions).map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });
});
