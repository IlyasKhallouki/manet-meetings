import { describe, expect, it } from 'vitest';
import { meetCodeFromUrl } from '@lib/meet/meetCode';
import { idempotencyKey, localDate, sessionId } from '@lib/util/ids';
import { formatBytes, formatClock, formatDuration } from '@lib/util/time';

describe('meetCodeFromUrl', () => {
  it('extracts the code from a call URL', () => {
    expect(meetCodeFromUrl('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
    expect(meetCodeFromUrl('https://meet.google.com/abc-defg-hij?authuser=1&hs=122')).toBe('abc-defg-hij');
  });

  it('rejects landing pages and other hosts', () => {
    expect(meetCodeFromUrl('https://meet.google.com/')).toBeNull();
    expect(meetCodeFromUrl('https://meet.google.com/landing')).toBeNull();
    expect(meetCodeFromUrl('https://example.com/abc-defg-hij')).toBeNull();
    expect(meetCodeFromUrl('not a url')).toBeNull();
  });
});

describe('ids', () => {
  const t = new Date(2026, 8, 19, 10, 15, 0).getTime(); // local time

  it('builds the idempotency key from the local date', () => {
    expect(localDate(t)).toBe('2026-09-19');
    expect(idempotencyKey('abc-defg-hij', t)).toBe('abc-defg-hij-2026-09-19');
  });

  it('builds a filesystem-safe session id', () => {
    expect(sessionId('abc-defg-hij', Date.UTC(2026, 8, 19, 10, 15, 0))).toBe('abc-defg-hij_20260919T101500Z');
  });
});

describe('time formatting', () => {
  it('formats clocks, durations and sizes', () => {
    expect(formatClock(3_723_000)).toBe('01:02:03');
    expect(formatDuration(3_723_000)).toBe('1h 02m');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });
});
