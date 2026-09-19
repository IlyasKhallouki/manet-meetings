import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NotionError } from '@lib/notion/client';
import { explainError, SAVE_STOPPED } from '@lib/notion/errors';

/** Words the direction keeps out of the UI (copyVoice › Glossary), and Chrome's "options". */
const JARGON = /\b(session|route|job|stage|pipeline|duplicate|force|options|integration|data source|rich_text)\b/i;

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const notion = (status: number, code: string, message = `raw ${code} message`) =>
  new NotionError(status, code, message, 'req-123');

describe('explainError', () => {
  it("uses the direction's sentences for a rejected token and an unshared database", () => {
    expect(explainError(notion(401, 'unauthorized', 'API token is invalid.'))).toBe(
      'Notion rejected the token. Copy it again in Settings.',
    );
    expect(explainError(notion(404, 'object_not_found', 'Could not find database with ID: x.'))).toBe(
      'The Notion database isn’t shared with your token. In Notion, open it and choose ••• › Connections.',
    );
  });

  it('names the fix for every failure Notion or the network can cause', () => {
    expect(explainError(notion(401, 'missing_token'))).toBe('Add a Notion token in Settings, then try again.');
    expect(explainError(notion(429, 'rate_limited'))).toBe('Notion is busy right now. Try again in a minute.');
    expect(explainError(notion(529, 'service_overload'))).toBe('Notion is busy right now. Try again in a minute.');
    expect(explainError(notion(0, 'network_error', 'Could not reach Notion: Failed to fetch'))).toBe(
      'Notion can’t be reached. Check your internet connection, then try again.',
    );
    expect(explainError(notion(0, 'timeout', 'Notion did not answer within 100 s.'))).toBe(
      'Notion didn’t answer in time. Try again in a few minutes.',
    );
    expect(explainError(notion(403, 'restricted_resource'))).toBe(
      'Notion didn’t let your token edit the database. In Notion, give it edit access, then try again.',
    );
    expect(explainError(notion(400, 'invalid_database_id', 'No Notion database is set for this route.'))).toBe(
      'Paste the Notion database link or ID in Settings, then try again.',
    );
    expect(explainError(notion(400, 'invalid_database_id', '"Meetings" is not a Notion database id or link.'))).toBe(
      'Paste the Notion database link or ID in Settings, then try again.',
    );
    expect(explainError(notion(400, 'no_data_source', 'The Notion database "Meetings" has no data source.'))).toBe(
      'The Notion database has no table for meetings. Paste the link of the meetings database in Settings.',
    );
    expect(explainError(notion(400, 'schema_mismatch', 'needs a text property named "Key". Check the database in the options.'))).toBe(
      'The Notion database needs a Text property named “Key”. Add it in Notion, then try again.',
    );
  });

  it('keeps only the status of an error it has no words for', () => {
    expect(explainError(notion(502, 'http_502', 'Notion request failed (502 Bad Gateway).'))).toBe(
      'Notion is having trouble right now (502). Try again in a few minutes.',
    );
    expect(explainError(notion(503, 'service_unavailable'))).toBe(
      'Notion is having trouble right now (503). Try again in a few minutes.',
    );
    expect(explainError(notion(409, 'conflict_error'))).toBe('Notion was busy with another change. Try again.');
    expect(explainError(notion(400, 'validation_error', 'body.children[3].paragraph should be defined'))).toBe(
      'Notion didn’t accept the page (400). Try again.',
    );
  });

  it('says a bug stopped the save, and never shows its words', () => {
    expect(explainError(new TypeError("Cannot read properties of undefined (reading 'type')"))).toBe(SAVE_STOPPED);
    expect(SAVE_STOPPED).toBe('Saving to Notion stopped before it finished. Try again.');
    expect(explainError('boom', 'Checking stopped before it finished. Try again.')).toBe(
      'Checking stopped before it finished. Try again.',
    );
  });

  it('keeps Notion’s own words in the console only', () => {
    const shown = explainError(notion(404, 'object_not_found', 'Could not find database with ID: 0f1e.'));
    expect(shown).not.toMatch(/0f1e|Could not find/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toMatch(/404.*object_not_found.*Could not find database with ID: 0f1e\..*req-123/);
    warn.mockClear();
    const bug = new TypeError('turns is undefined');
    explainError(bug);
    expect(warn.mock.calls[0]).toContain(bug);
  });

  it('logs nothing for a setting that is simply empty', () => {
    explainError(notion(401, 'missing_token', 'No Notion integration token is set.'));
    explainError(notion(400, 'invalid_database_id', 'No Notion database is set for this route.'));
    expect(warn).not.toHaveBeenCalled();
  });

  it('names Notion in every sentence (how Meetings and the popup tell a failed save from a failed transcription), in the glossary’s words', () => {
    const codes: [number, string][] = [
      [401, 'missing_token'],
      [401, 'unauthorized'],
      [403, 'restricted_resource'],
      [404, 'object_not_found'],
      [409, 'conflict_error'],
      [429, 'rate_limited'],
      [529, 'service_overload'],
      [0, 'network_error'],
      [0, 'timeout'],
      [400, 'invalid_database_id'],
      [400, 'no_data_source'],
      [400, 'schema_mismatch'],
      [400, 'validation_error'],
      [500, 'internal_server_error'],
    ];
    const all = [...codes.map(([status, code]) => explainError(notion(status, code))), explainError(new Error('x'))];
    for (const text of all) {
      expect(text, text).toMatch(/Notion/);
      expect(text, text).not.toMatch(JARGON);
      expect(text, text).not.toMatch(/'/);
      expect(text, text).toMatch(/^[A-Z].*\.$/);
      expect(text, text).not.toMatch(/raw .* message/);
    }
  });
});
