import { afterEach, describe, expect, it } from 'vitest';
import '@lib/ui/styles.css';
import type { SessionMeta } from '@lib/types';
import { createDashboardView } from '@lib/ui/dashboardView';

const T0 = Date.UTC(2026, 8, 19, 8, 0, 0);

const session: SessionMeta = {
  id: 'a',
  meetCode: 'abc-defg-hij',
  meetingTitle: 'Weekly sync',
  startedAt: T0,
  durationMs: 1_920_000,
  status: 'processed',
  route: 'team',
  idempotencyKey: 'abc-defg-hij-2026-09-19',
  audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 10, bytes: 2_000_000, micIncluded: true },
  captionCount: 12,
};

const noop = () => Promise.resolve();
let root: HTMLElement | undefined;

afterEach(() => root?.remove());

describe('dashboard layout (real CSS)', () => {
  it('never scrolls the page sideways on a narrow window; the table scrolls inside its box', () => {
    root = document.createElement('div');
    document.body.append(root);
    const view = createDashboardView(
      root,
      { stop: noop, transcribe: noop, save: noop, remove: noop, route: noop, setAutoTranscribe: noop, openSettings: () => {} },
      { locale: 'en-GB', timeZone: 'UTC' },
    );
    view.update({
      sessions: [session],
      resultIds: new Set(['a']),
      audioOnDisk: new Map(),
      estimate: { usage: 0, quota: 1 },
      missing: [],
      geminiKeyMissing: false,
      autoTranscribe: true,
      now: T0 + 3_600_000,
    });
    expect(document.documentElement.clientWidth).toBeLessThan(700);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  });
});
