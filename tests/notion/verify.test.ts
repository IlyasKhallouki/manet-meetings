/**
 * What Check both databases says in Settings: the fix under the field, in the
 * direction's words. Notion's answers are canned here; store.test.ts asks the real API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schemaProblems, verifyDatabase } from '@lib/notion/verify';

const DB = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const JARGON = /\b(integration|options|data source|rich_text|multi_select|route)\b/i;

function answer(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function notionAnswers(status: number, code: string, message: string) {
  return vi.fn(async () => answer(status, { object: 'error', status, code, message, request_id: 'req-1' }));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('verifyDatabase', () => {
  it('flags a rejected token as the token’s problem, so Settings says it once, under the token', async () => {
    vi.stubGlobal('fetch', notionAnswers(401, 'unauthorized', 'API token is invalid.'));
    expect(await verifyDatabase('ntn_wrong_1', DB)).toEqual({
      ok: false,
      problems: ['Notion rejected this token. Copy it again from Notion.'],
      tokenProblem: true,
    });
  });

  it('says how to share a database the token can’t see', async () => {
    vi.stubGlobal('fetch', notionAnswers(404, 'object_not_found', `Could not find database with ID: ${DB}.`));
    expect(await verifyDatabase('ntn_wrong_2', DB)).toEqual({
      ok: false,
      problems: ['This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.'],
    });
  });

  it('asks for the link when the field is empty or holds something else, without calling Notion', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await verifyDatabase('ntn_x', '  ')).toEqual({
      ok: false,
      problems: ['Paste the database link or ID from Notion.'],
    });
    expect(await verifyDatabase('ntn_x', 'Meetings')).toEqual({
      ok: false,
      problems: ['“Meetings” isn’t a link or ID. Paste the database link or ID from Notion.'],
    });
    expect(await verifyDatabase('', DB)).toEqual({
      ok: false,
      problems: ['Paste a Notion token first.'],
      tokenProblem: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps Notion’s words out of what it says for anything else', async () => {
    vi.stubGlobal('fetch', notionAnswers(400, 'validation_error', 'path failed validation: body.x should be defined'));
    const result = await verifyDatabase('ntn_wrong_3', DB);
    expect(result).toEqual({ ok: false, problems: ['Notion didn’t accept the page (400). Try again.'] });
  });

  it('says a check that broke off stopped, not what broke', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { object: 'database', id: DB, title: 'not a list' })));
    const result = await verifyDatabase('ntn_wrong_4', DB);
    expect(result).toEqual({ ok: false, problems: ['Checking stopped before it finished. Try again.'] });
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

  it('names property types as Notion shows them, with the fix', () => {
    const { Key: _key, ...withoutKey } = good;
    const problems = schemaProblems({ ...withoutKey, Duration: 'rich_text', Attendees: 'checkbox' });
    expect(problems).toEqual([
      'Change “Duration” to a Number property. It’s Text now.',
      'Change “Attendees” to a Multi-select property. It’s Checkbox now.',
      'Add a Text property named “Key”.',
    ]);
    for (const p of problems) expect(p).not.toMatch(JARGON);
  });
});
