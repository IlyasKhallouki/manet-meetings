import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus } from '@lib/types';
import { ROUTE_COUNTDOWN_MS, routingMode, secondsLeft } from '@lib/ui/routingView';

function meta(status: SessionStatus): SessionMeta {
  return {
    id: 's1',
    meetCode: 'abc-defg-hij',
    startedAt: 0,
    status,
    idempotencyKey: 'abc-defg-hij-1970-01-01',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
  };
}

describe('secondsLeft', () => {
  it('rounds up and never goes negative', () => {
    expect(ROUTE_COUNTDOWN_MS).toBe(60_000);
    expect(secondsLeft(60_000, 0)).toBe(60);
    expect(secondsLeft(60_000, 1)).toBe(60);
    expect(secondsLeft(60_000, 59_001)).toBe(1);
    expect(secondsLeft(60_000, 60_000)).toBe(0);
    expect(secondsLeft(60_000, 90_000)).toBe(0);
  });
});

describe('routingMode', () => {
  it('asks while the session waits for a route', () => {
    expect(routingMode(meta('awaiting-route'))).toBe('choose');
  });

  it('lets the destination change where the background still accepts it', () => {
    for (const s of ['ready', 'failed', 'processed'] as const) expect(routingMode(meta(s)), s).toBe('change');
  });

  it('has nothing to ask once the meeting is being handled or gone', () => {
    for (const s of ['recording', 'processing', 'saving', 'saved', 'duplicate'] as const) {
      expect(routingMode(meta(s)), s).toBe('done');
    }
    expect(routingMode(null)).toBe('missing');
  });
});
