import { describe, expect, it } from 'vitest';
import type { MeetingPageInput } from '@lib/types';
import { pickWinner, saveMeeting } from '@lib/notion/save';
import { createNotionMeetingStore } from '@lib/notion/store';

const page = (pageId: string, createdAt: string) => ({ pageId, createdAt, url: `https://app.notion.com/p/${pageId}`, recordedBy: 'x' });

describe('pickWinner', () => {
  it('returns null for no pages', () => {
    expect(pickWinner([])).toBeNull();
  });

  it('picks the oldest page', () => {
    const pages = [
      page('bbbbbbbb-0000-0000-0000-000000000000', '2026-09-19T10:05:00.000Z'),
      page('cccccccc-0000-0000-0000-000000000000', '2026-09-19T10:04:00.000Z'),
    ];
    expect(pickWinner(pages)?.pageId).toBe('cccccccc-0000-0000-0000-000000000000');
  });

  it('breaks ties (Notion rounds created_time to the minute) on the smallest id, dashes ignored', () => {
    const t = '2026-09-19T10:05:00.000Z';
    const pages = [page('b0000000-0000-0000-0000-000000000000', t), page('a000000000000000000000000000000f', t)];
    expect(pickWinner(pages)?.pageId).toBe('a000000000000000000000000000000f');
    expect(pickWinner([...pages].reverse())?.pageId).toBe('a000000000000000000000000000000f');
  });

  it('agrees for every observer regardless of list order', () => {
    const t = '2026-09-19T10:05:00.000Z';
    const pages = [
      page('0d000000-0000-0000-0000-000000000000', t),
      page('0a000000-0000-0000-0000-000000000000', '2026-09-19T10:06:00.000Z'),
      page('0c000000-0000-0000-0000-000000000000', t),
    ];
    const winners = new Set([pages, [...pages].reverse(), [pages[1]!, pages[2]!, pages[0]!]].map((p) => pickWinner(p)?.pageId));
    expect([...winners]).toEqual(['0c000000-0000-0000-0000-000000000000']);
  });
});

function input(): MeetingPageInput {
  return {
    key: 'abc-defg-hij-2026-09-19',
    title: 'Point hebdo',
    startedAt: Date.UTC(2026, 8, 19, 8, 0),
    durationMs: 60_000,
    attendees: [],
    meetCode: 'abc-defg-hij',
    recordedBy: 'Ilyas',
    source: 'captions-only',
    summary: null,
    transcript: { turns: [], source: 'captions-only', notes: [] },
  };
}

// Real network, no secret needed.
describe('saveMeeting with an invalid token (real API)', () => {
  it('returns an error outcome instead of throwing', async () => {
    const store = createNotionMeetingStore('ntn_this_token_is_not_valid');
    const outcome = await saveMeeting(store, '0f1e2d3c4b5a69788796a5b4c3d2e1f0', input());
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.error).toMatch(/token is invalid/i);
  });

  it('reports an unusable database id without calling Notion', async () => {
    const store = createNotionMeetingStore('ntn_this_token_is_not_valid');
    const outcome = await saveMeeting(store, 'not a database', input());
    expect(outcome).toEqual({ status: 'error', error: expect.stringMatching(/not a Notion database/i) });
  });
});
