import { describe, expect, it } from 'vitest';
import { NotionError } from '@lib/notion/client';
import { createNotionMeetingStore, pageProperties } from '@lib/notion/store';
import { schemaProblems, verifyDatabase } from '@lib/notion/verify';

const DB = 'https://www.notion.so/lumind/Meetings-0f1e2d3c4b5a69788796a5b4c3d2e1f0?v=aaaaaaaabbbbccccddddeeeeeeeeeeee';

// Real network, no secret needed: how each entry point surfaces Notion's rejection.
describe('Notion store with an invalid token (real API)', () => {
  const store = createNotionMeetingStore('ntn_this_token_is_not_valid');

  it('rejects lookups with a NotionError', async () => {
    const error = await store.findByKey(DB, 'abc-defg-hij-2026-09-19').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).status).toBe(401);
    expect((error as NotionError).code).toBe('unauthorized');
  });

  it('rejects archiving with a NotionError', async () => {
    const error = await store.archivePage('0f1e2d3c4b5a69788796a5b4c3d2e1f0').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).status).toBe(401);
  });

  it('rejects an unparseable database id before any request', async () => {
    const error = await store.listByKey('meetings', 'k').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).code).toBe('invalid_database_id');
    const empty = await store.findByKey('  ', 'k').catch((e: unknown) => e);
    expect((empty as NotionError).message).toMatch(/no Notion database/i);
  });
});

describe('verifyDatabase without valid credentials (real API)', () => {
  it('explains an invalid token', async () => {
    const result = await verifyDatabase('ntn_this_token_is_not_valid', DB);
    expect(result.ok).toBe(false);
    expect(result).toEqual({
      ok: false,
      problems: ['Notion rejected this token. Copy it again from Notion.'],
      tokenProblem: true,
    });
  });

  it('explains a missing token or a bad database id', async () => {
    const noToken = await verifyDatabase('', DB);
    expect(noToken.ok).toBe(false);
    if (!noToken.ok) expect(noToken.problems).toEqual(['Paste a Notion token first.']);
    const badId = await verifyDatabase('ntn_x', 'Meetings');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.problems).toEqual(['“Meetings” isn’t a link or ID. Paste the database link or ID from Notion.']);
  });
});

describe('schemaProblems', () => {
  const good = {
    Nom: 'title',
    Date: 'date',
    Duration: 'number',
    Attendees: 'multi_select',
    'Meet code': 'rich_text',
    'Recorded by': 'rich_text',
    Source: 'select',
    Key: 'rich_text',
  };

  it('accepts the schema whatever the title property is called', () => {
    expect(schemaProblems(good)).toEqual([]);
    expect(schemaProblems({ ...good, Extra: 'checkbox' })).toEqual([]);
  });

  it('lists missing properties and wrong types, as Notion names them', () => {
    const { Key: _key, ...withoutKey } = good;
    expect(schemaProblems({ ...withoutKey, Duration: 'rich_text' })).toEqual([
      'Change “Duration” to a Number property. It’s Text now.',
      'Add a Text property named “Key”.',
    ]);
  });
});

describe('pageProperties', () => {
  const input = {
    key: 'abc-defg-hij-2026-09-19', title: 'Sync', startedAt: 0, durationMs: 60_000, attendees: [], meetCode: 'abc-defg-hij',
    recordedBy: 'Ilyas', source: 'audio-only' as const, summary: null, transcript: { turns: [], source: 'audio-only' as const, notes: [] },
    profileName: 'Client meeting',
  };

  it('fills Profile when the database has that select', () => {
    const props = pageProperties(input, { titleProperty: 'Name', properties: { Profile: 'select' } });
    expect(props.Profile).toEqual({ select: { name: 'Client meeting' } });
  });

  it('leaves Profile out when the database has none, or it isn’t a select', () => {
    expect(pageProperties(input, { titleProperty: 'Name', properties: {} })).not.toHaveProperty('Profile');
    expect(pageProperties(input, { titleProperty: 'Name', properties: { Profile: 'rich_text' } })).not.toHaveProperty('Profile');
  });
});
