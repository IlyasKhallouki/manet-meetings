import { NotionClient, NotionError } from './client';
import { explainError } from './errors';
import { parseNotionId } from './ids';
import { MEETING_DB_SCHEMA, MEETING_PROPS } from './schema';
import { resolveDatabase } from './store';

export type VerifyResult = { ok: true; title: string } | { ok: false; problems: string[] };

/**
 * Differences between a data source's properties (name → type) and the meetings
 * schema. The title property may have any name: Notion names it after the UI language.
 */
export function schemaProblems(properties: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, type] of Object.entries(MEETING_DB_SCHEMA)) {
    if (name === MEETING_PROPS.title) continue;
    const actual = properties[name];
    if (actual === undefined) problems.push(`Missing property "${name}" (type ${type}).`);
    else if (actual !== type) problems.push(`Property "${name}" is ${actual}; it must be ${type}.`);
  }
  return problems;
}

/** Checks access and schema for the options page. Never throws. */
export async function verifyDatabase(token: string, databaseId: string): Promise<VerifyResult> {
  if (!token.trim()) return { ok: false, problems: [explainError(new NotionError(401, 'missing_token', 'No token.'))] };
  if (!databaseId.trim()) return { ok: false, problems: ['Paste the link or id of the Notion database.'] };
  if (!parseNotionId(databaseId)) {
    return { ok: false, problems: [`"${databaseId.trim().slice(0, 80)}" is not a Notion database id or link.`] };
  }
  try {
    const db = await resolveDatabase(new NotionClient(token), databaseId);
    const problems = schemaProblems(db.properties);
    return problems.length ? { ok: false, problems } : { ok: true, title: db.title };
  } catch (err) {
    return { ok: false, problems: [explainError(err)] };
  }
}
