import { describe, expect, it } from 'vitest';
import type { MeetingPageInput } from '@lib/types';
import { pickWinner, saveMeeting, settleStep, type SettleState } from '@lib/notion/save';
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

describe('settleStep', () => {
  const t = '2026-09-19T10:05:00.000Z';
  const ours = page('bbbbbbbb-0000-0000-0000-000000000000', t);
  const olderTeammate = page('aaaaaaaa-0000-0000-0000-000000000000', t);
  const youngerTeammate = page('cccccccc-0000-0000-0000-000000000000', t);

  /** Feeds listings taken `delayMs` apart, as saveMeeting's loop does, until a verdict. */
  function settleOver(listings: (typeof ours)[][], { delayMs = 1500, timeoutMs = 20_000 } = {}) {
    let state: SettleState = { ourPageId: ours.pageId, deadline: timeoutMs, confirmations: 0 };
    for (const [i, pages] of listings.entries()) {
      const step = settleStep(state, pages, i * delayMs);
      if (step.verdict !== 'wait') return { ...step, listings: i + 1 };
      state = step.state;
    }
    return { verdict: 'wait' as const, listings: listings.length };
  }

  it('does not spend confirmations while the index has not caught up with our page', () => {
    // Our page first shows on the 5th listing (~6 s of query lag), the teammate's on the 6th.
    const outcome = settleOver([[], [], [], [], [ours], [olderTeammate, ours], [olderTeammate, ours]]);
    expect(outcome).toMatchObject({ verdict: 'lost', listings: 6, winner: { pageId: olderTeammate.pageId } });
  });

  it('keeps our page after two listings in which it is the oldest', () => {
    expect(settleOver([[], [ours], [ours, youngerTeammate], [olderTeammate, ours]])).toEqual({ verdict: 'stands', listings: 3 });
  });

  it('keeps our page when it never shows up before the deadline (at worst a leftover duplicate)', () => {
    const outcome = settleOver(Array.from({ length: 30 }, () => []), { delayMs: 1500, timeoutMs: 20_000 });
    expect(outcome).toEqual({ verdict: 'stands', listings: 15 });
  });

  it('still asks for a second confirmation when our page first shows after the deadline', () => {
    // 14 empty listings take 19.5 s; ours first shows on the listing at 21 s.
    const late = [...Array.from({ length: 14 }, () => []), [ours], [olderTeammate, ours]];
    expect(settleOver(late)).toMatchObject({ verdict: 'lost', listings: 16 });
  });

  it('does not count a listing from which our page dropped out again', () => {
    expect(settleOver([[ours], [], [olderTeammate, ours]])).toMatchObject({ verdict: 'lost', listings: 3 });
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
