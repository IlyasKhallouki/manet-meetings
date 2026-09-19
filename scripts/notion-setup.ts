/**
 * Creates the meetings database under a Notion page.
 *
 *   NOTION_TOKEN=ntn_… node scripts/notion-setup.ts <parent page id or link> [title]
 *
 * Share the parent page with your integration first (••• → Connections). Paste the
 * printed database id into the extension options.
 */
import { NOTION_VERSION, NotionClient, NotionError } from '../src/lib/notion/client.ts';
import { compactId, parseNotionId } from '../src/lib/notion/ids.ts';
import { databaseSchemaPayload } from '../src/lib/notion/schema.ts';

const token = process.env.NOTION_TOKEN ?? '';
const parent = parseNotionId(process.argv[2] ?? '');
const title = process.argv[3] ?? 'Meetings';

if (!token || !parent) {
  console.error('Usage: NOTION_TOKEN=ntn_… node scripts/notion-setup.ts <parent page id or link> [title]');
  process.exit(1);
}

try {
  const db = await new NotionClient(token).request<{ id: string; url: string }>('POST', '/databases', {
    body: {
      parent: { type: 'page_id', page_id: parent },
      title: [{ type: 'text', text: { content: title } }],
      is_inline: false,
      initial_data_source: { properties: databaseSchemaPayload() },
    },
  });
  console.log(`Created database "${title}" (Notion API ${NOTION_VERSION}).`);
  console.log(`Database id: ${compactId(db.id)}`);
  console.log(`Link: ${db.url}`);
} catch (err) {
  console.error(err instanceof NotionError ? `Notion error ${err.status} (${err.code}): ${err.message}` : err);
  process.exit(1);
}
