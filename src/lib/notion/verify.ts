import { NotionClient, NotionError } from './client';
import { explainError } from './errors';
import { parseNotionId } from './ids';
import { MEETING_DB_SCHEMA, MEETING_PROPS } from './schema';
import { resolveDatabase } from './store';

/**
 * `tokenProblem`: the token, not the database, is at fault (rejected or missing), so
 * Settings says it once, under the token, rather than under each database.
 */
export type VerifyResult = { ok: true; title: string } | { ok: false; problems: string[]; tokenProblem?: true };

/** Property types as Notion's own menus name them. */
const TYPE_NAMES: Record<string, string> = {
  title: 'Title',
  rich_text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Select',
  multi_select: 'Multi-select',
  status: 'Status',
  checkbox: 'Checkbox',
  people: 'Person',
  url: 'URL',
  email: 'Email',
  phone_number: 'Phone',
  files: 'Files & media',
  formula: 'Formula',
  relation: 'Relation',
  rollup: 'Rollup',
  created_time: 'Created time',
  last_edited_time: 'Last edited time',
  unique_id: 'ID',
};

function typeName(type: string): string {
  const known = TYPE_NAMES[type];
  if (known) return known;
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "a Number property", "an Email property". */
function aProperty(type: string): string {
  const name = typeName(type);
  return `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name} property`;
}

/**
 * Differences between a data source's properties (name → type) and the meetings
 * schema, each with its fix. The title property may have any name: Notion names it
 * after the UI language.
 */
export function schemaProblems(properties: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, type] of Object.entries(MEETING_DB_SCHEMA)) {
    if (name === MEETING_PROPS.title) continue;
    const actual = properties[name];
    if (actual === undefined) problems.push(`Add ${aProperty(type)} named “${name}”.`);
    else if (actual !== type) problems.push(`Change “${name}” to ${aProperty(type)}. It’s ${typeName(actual)} now.`);
  }
  return problems;
}

const CHECK_STOPPED = 'Checking stopped before it finished. Try again.';
const PASTE_LINK = 'Paste the database link or ID from Notion.';

/**
 * A failed check in Settings' words: next to the field it is about, so "this token",
 * "this database", and no "in Settings". The rest is said as everywhere else.
 */
function settingsProblem(err: unknown): Extract<VerifyResult, { ok: false }> {
  if (err instanceof NotionError) {
    switch (err.code) {
      case 'unauthorized':
        explainError(err); // logs Notion's words
        return { ok: false, problems: ['Notion rejected this token. Copy it again from Notion.'], tokenProblem: true };
      case 'missing_token':
        return { ok: false, problems: ['Paste a Notion token first.'], tokenProblem: true };
      case 'object_not_found':
        explainError(err);
        return {
          ok: false,
          problems: ['This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.'],
        };
      case 'invalid_database_id':
        return { ok: false, problems: [PASTE_LINK] };
    }
  }
  return { ok: false, problems: [explainError(err, CHECK_STOPPED)] };
}

/** Checks access and schema for Settings. Never throws. */
export async function verifyDatabase(token: string, databaseId: string): Promise<VerifyResult> {
  if (!token.trim()) return settingsProblem(new NotionError(401, 'missing_token', 'No token.'));
  const shown = databaseId.trim();
  if (!shown) return { ok: false, problems: [PASTE_LINK] };
  if (!parseNotionId(databaseId)) {
    const quoted = shown.length > 60 ? `${shown.slice(0, 59)}…` : shown;
    return { ok: false, problems: [`“${quoted}” isn’t a link or ID. ${PASTE_LINK}`] };
  }
  try {
    const db = await resolveDatabase(new NotionClient(token), databaseId);
    const problems = schemaProblems(db.properties);
    return problems.length ? { ok: false, problems } : { ok: true, title: db.title };
  } catch (err) {
    return settingsProblem(err);
  }
}
