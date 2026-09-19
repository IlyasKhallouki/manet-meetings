import { afterAll, describe, expect, it } from 'vitest';
import type { MeetingPageInput, MeetingSummary, TranscriptTurn } from '@lib/types';
import { NotionClient, type NotionBlock, type NotionPage, type NotionRichText } from '@lib/notion/client';
import { sameNotionId } from '@lib/notion/ids';
import { saveMeeting } from '@lib/notion/save';
import { createNotionMeetingStore } from '@lib/notion/store';
import { verifyDatabase } from '@lib/notion/verify';
import { formatClock } from '@lib/util/time';

const token = process.env.NOTION_TOKEN ?? '';
const databaseId = process.env.NOTION_TEST_DB_ID ?? '';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Notion's query index can lag a write by a few seconds. */
async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(1000);
  }
}

function richTextOf(block: NotionBlock): NotionRichText[] {
  return ((block[block.type] as { rich_text?: NotionRichText[] } | undefined)?.rich_text ?? []);
}

const summary: MeetingSummary = {
  title: 'Integration test meeting',
  summary: 'We checked that meetings land in Notion.\n\nLe résumé est en deux paragraphes.',
  keyPoints: ['Pages are created under the data source', 'Long text is chunked'],
  decisions: ['Keep the oldest page on a race'],
  actionItems: [{ task: 'Delete this test page', owner: 'CI', due: 'today' }],
};

function longTurns(): TranscriptTurn[] {
  const speakers = ['Ilyas', 'Camille Martin', 'Zoé', 'Jean-Baptiste'];
  const sentence = 'On avance bien sur le lancement, the deck is almost ready and the budget is validated. ';
  const turns: TranscriptTurn[] = Array.from({ length: 150 }, (_, i) => ({
    speaker: speakers[i % speakers.length]!,
    start: i * 20_000,
    end: i * 20_000 + 18_000,
    text: `${sentence.repeat(3)}(${i})`,
  }));
  // Over 2000 characters in one turn, one word longer than the limit, and non-BMP text.
  turns.splice(10, 0, { speaker: 'Zoé', start: 199_000, end: 199_500, text: 'très long discours '.repeat(300).trim() });
  turns.splice(20, 0, { speaker: 'Ilyas', start: 399_000, end: 399_500, text: `mot ${'x'.repeat(2600)} fin` });
  turns.splice(30, 0, { speaker: 'Camille Martin', start: 599_000, end: 599_500, text: 'Top 👍🏽 on garde ça 🚀 '.repeat(120).trim() });
  return turns;
}

function meeting(key: string, overrides: Partial<MeetingPageInput> = {}): MeetingPageInput {
  return {
    key,
    title: `Integration ${key}`,
    startedAt: new Date(2026, 8, 19, 10, 15, 30).getTime(),
    durationMs: 52 * 60_000 + 12_000,
    attendees: ['Ilyas', 'Camille Martin', 'Martin, Camille', 'zoé', 'Zoé'],
    meetCode: 'abc-defg-hij',
    recordedBy: 'Integration test',
    source: 'audio+captions',
    summary,
    transcript: { turns: [{ speaker: 'Ilyas', start: 0, end: 1000, text: 'Bonjour.' }], source: 'audio+captions', notes: [] },
    ...overrides,
  };
}

describe.skipIf(!token || !databaseId)('notion integration (needs NOTION_TOKEN + NOTION_TEST_DB_ID)', () => {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const keys: string[] = [];
  const created = new Set<string>();
  const newKey = (label: string) => {
    const key = `itest-${run}-${label}-2026-09-19`;
    keys.push(key);
    return key;
  };
  const store = createNotionMeetingStore(token);
  const client = new NotionClient(token);

  afterAll(async () => {
    for (const key of keys) {
      for (const page of await store.listByKey(databaseId, key).catch(() => [])) created.add(page.pageId);
    }
    for (const pageId of created) await store.archivePage(pageId).catch(() => undefined);
  }, 180_000);

  it('verifies access and schema', async () => {
    const result = await verifyDatabase(token, databaseId);
    expect(result).toEqual({ ok: true, title: expect.any(String) });
  });

  it('creates a meeting page whose long transcript round-trips through the child page', async () => {
    const key = newKey('long');
    const turns = longTurns();
    const expected = turns.map((t) => `[${formatClock(t.start)}] ${t.speaker}: ${t.text.trim()}`);
    expect(expected.join('').length).toBeGreaterThan(30_000);
    expect(expected.length).toBeGreaterThan(100);
    const input = meeting(key, {
      source: 'captions-only',
      transcript: { turns, source: 'captions-only', notes: ['Timing pass failed: test', 'Text pass failed: test'] },
    });

    const { pageId, url } = await store.createMeeting(databaseId, input);
    created.add(pageId);
    expect(url).toMatch(/^https:\/\//);

    const page = await client.request<NotionPage>('GET', `/pages/${pageId}`);
    const props = page.properties;
    expect(props.Key?.rich_text?.map((r) => r.plain_text).join('')).toBe(key);
    expect(props['Recorded by']?.rich_text?.map((r) => r.plain_text).join('')).toBe('Integration test');
    expect(props['Meet code']?.rich_text?.map((r) => r.plain_text).join('')).toBe('abc-defg-hij');
    expect(props.Source?.select?.name).toBe('captions-only');
    expect(props.Duration?.number).toBe(52.2);
    expect(Date.parse(props.Date?.date?.start ?? '')).toBe(input.startedAt);
    // Notion reuses an existing option that differs only in case, so compare folded.
    expect(props.Attendees?.multi_select?.map((o) => o.name.toLowerCase())).toEqual([
      'ilyas',
      'camille martin',
      'martin camille',
      'zoé',
    ]);

    const top = await client.listBlockChildren(pageId);
    expect(top[0]?.type).toBe('callout');
    const headings = top.filter((b) => b.type === 'heading_2').map((b) => richTextOf(b).map((r) => r.plain_text).join(''));
    expect(headings).toEqual(['Summary', 'Key points', 'Decisions', 'Action items']);
    expect(top.filter((b) => b.type === 'to_do').map((b) => richTextOf(b).map((r) => r.plain_text).join(''))).toEqual([
      'CI — Delete this test page (today)',
    ]);
    const child = top.at(-1);
    expect(child?.type).toBe('child_page');
    expect((child?.child_page as { title: string } | undefined)?.title).toBe('Transcript');

    const blocks = await client.listBlockChildren(child!.id);
    expect(blocks.length).toBe(expected.length);
    const got: string[] = [];
    for (const block of blocks) {
      expect(block.type).toBe('paragraph');
      const items = richTextOf(block);
      expect(items[0]?.annotations?.bold).toBe(true);
      for (const item of items) {
        expect(item.plain_text.length).toBeLessThanOrEqual(2000);
        expect((item.text?.content ?? '').length).toBeLessThanOrEqual(2000);
      }
      got.push(items.map((r) => r.plain_text).join(''));
    }
    expect(got).toEqual(expected);
  }, 180_000);

  it('finds a saved meeting by key with who recorded it', async () => {
    const key = newKey('find');
    const { pageId } = await store.createMeeting(databaseId, meeting(key, { recordedBy: 'Camille' }));
    created.add(pageId);
    const found = await eventually(() => store.findByKey(databaseId, key), (v) => v !== null);
    expect(found).not.toBeNull();
    expect(sameNotionId(found!.pageId, pageId)).toBe(true);
    expect(found!.recordedBy).toBe('Camille');
    expect(found!.url).toMatch(/^https:\/\//);

    const listed = await store.listByKey(databaseId, key);
    expect(listed).toHaveLength(1);
    expect(Number.isNaN(Date.parse(listed[0]!.createdAt))).toBe(false);

    expect(await store.findByKey(databaseId, newKey('absent'))).toBeNull();
  }, 120_000);

  it('saves once and reports the second save as a duplicate with the first recorder', async () => {
    const key = newKey('twice');
    const first = await saveMeeting(store, databaseId, meeting(key, { recordedBy: 'Alice' }));
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;
    created.add(first.pageId);
    await eventually(() => store.findByKey(databaseId, key), (v) => v !== null);

    const second = await saveMeeting(store, databaseId, meeting(key, { recordedBy: 'Bob' }));
    expect(second.status).toBe('duplicate');
    if (second.status !== 'duplicate') return;
    expect(sameNotionId(second.existing.pageId, first.pageId)).toBe(true);
    expect(second.existing.recordedBy).toBe('Alice');
  }, 120_000);

  it('leaves exactly one live page when two teammates save the same meeting at once', async () => {
    const key = newKey('race');
    const [a, b] = await Promise.all([
      saveMeeting(createNotionMeetingStore(token), databaseId, meeting(key, { recordedBy: 'Alice' })),
      saveMeeting(createNotionMeetingStore(token), databaseId, meeting(key, { recordedBy: 'Bob' })),
    ]);
    for (const o of [a, b]) if (o.status === 'created') created.add(o.pageId);
    expect([a.status, b.status].sort()).toEqual(['created', 'duplicate']);

    const winner = a.status === 'created' ? a : b.status === 'created' ? b : null;
    const loser = a.status === 'duplicate' ? a : b.status === 'duplicate' ? b : null;
    expect(loser?.status === 'duplicate' && winner?.status === 'created' && sameNotionId(loser.existing.pageId, winner.pageId)).toBe(true);

    const live = await eventually(() => store.listByKey(databaseId, key), (v) => v.length === 1);
    expect(live).toHaveLength(1);
    expect(winner?.status === 'created' && sameNotionId(live[0]!.pageId, winner.pageId)).toBe(true);
  }, 180_000);
});
