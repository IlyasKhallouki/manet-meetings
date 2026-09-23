/**
 * MeetingStore backed by a Notion database.
 *
 * Settings hold the DATABASE id (or link) the user pasted. Since API 2025-09-03 a
 * database is a container of data sources and rows live in a data source, so the id
 * is resolved to its data source once (GET /databases/:id → data_sources) and cached.
 * An id copied with "Copy data source ID" is accepted too.
 */
import type { ExistingMeeting, MeetingPageInput, MeetingStore } from '../types';
import { batchBlocks, buildMeetingBody, buildTranscriptBlocks } from './blocks';
import { NotionClient, NotionError, type NotionDatabase, type NotionDataSource, type NotionPage } from './client';
import { compareByCreation, parseNotionId } from './ids';
import { buildMeetingProperties, keyProperty, profileProperty } from './properties';
import { plainText, richText } from './richText';
import { MEETING_PROPS, OPTIONAL_PROPS } from './schema';

export interface ResolvedDatabase {
  databaseId: string;
  dataSourceId: string;
  /** Database title as shown in Notion. */
  title: string;
  /** Name of the data source's title property ("Name", or "Nom" in a French workspace). */
  titleProperty: string;
  /** Property name → Notion type. */
  properties: Record<string, string>;
}

export type ListedMeeting = ExistingMeeting & { createdAt: string };

const TRANSCRIPT_TITLE = 'Transcript';

function describeSource(ds: NotionDataSource, databaseId: string, title: string): ResolvedDatabase {
  const properties = Object.fromEntries(Object.entries(ds.properties).map(([name, p]) => [name, p.type]));
  const titleProperty = Object.entries(properties).find(([, type]) => type === 'title')?.[0] ?? MEETING_PROPS.title;
  return { databaseId, dataSourceId: ds.id, title, titleProperty, properties };
}

/** Resolves a pasted database id or link to the data source that holds the meetings. */
export async function resolveDatabase(client: NotionClient, databaseIdOrUrl: string): Promise<ResolvedDatabase> {
  const shown = databaseIdOrUrl.trim().slice(0, 80);
  if (!shown) throw new NotionError(400, 'invalid_database_id', 'No Notion database is set for this route.');
  const id = parseNotionId(databaseIdOrUrl);
  if (!id) throw new NotionError(400, 'invalid_database_id', `"${shown}" is not a Notion database id or link.`);
  let database: NotionDatabase;
  try {
    database = await client.retrieveDatabase(id);
  } catch (err) {
    if (!(err instanceof NotionError) || (err.status !== 404 && err.status !== 400)) throw err;
    let ds: NotionDataSource;
    try {
      ds = await client.retrieveDataSource(id);
    } catch {
      throw err;
    }
    return describeSource(ds, ds.parent?.database_id ?? id, plainText(ds.title));
  }
  const title = plainText(database.title);
  let fallback: NotionDataSource | undefined;
  // A database can hold several data sources; prefer the one with our Key property.
  for (const { id: dataSourceId } of database.data_sources ?? []) {
    const ds = await client.retrieveDataSource(dataSourceId);
    if (ds.properties[MEETING_PROPS.key]?.type === 'rich_text') return describeSource(ds, database.id, title);
    fallback ??= ds;
  }
  if (!fallback) throw new NotionError(400, 'no_data_source', `The Notion database "${title}" has no data source.`);
  return describeSource(fallback, database.id, title);
}

function isLive(page: NotionPage): boolean {
  return !page.in_trash && !page.is_archived;
}

/** Notion answered and refused, so the write did not happen (unlike a timeout or a 5xx). */
function refused(err: unknown): boolean {
  return err instanceof NotionError && err.status >= 400 && err.status < 500;
}

/** The row's properties but the Key; the Profile select only where the database has one. */
export function pageProperties(
  input: MeetingPageInput,
  db: Pick<ResolvedDatabase, 'titleProperty' | 'properties'>,
): Record<string, unknown> {
  const hasProfile = db.properties[OPTIONAL_PROPS.profile] === 'select';
  return {
    ...buildMeetingProperties(input, db.titleProperty),
    ...(input.profileName && hasProfile ? profileProperty(input.profileName) : {}),
  };
}

const cache = new Map<string, Promise<ResolvedDatabase>>();

export function createNotionMeetingStore(token: string): MeetingStore {
  const client = new NotionClient(token);

  const resolve = (databaseId: string): Promise<ResolvedDatabase> => {
    const key = `${token}\n${databaseId.trim()}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = resolveDatabase(client, databaseId);
      cache.set(key, entry);
      entry.catch(() => cache.delete(key));
    }
    return entry;
  };
  const forget = (databaseId: string) => cache.delete(`${token}\n${databaseId.trim()}`);

  async function query(databaseId: string, key: string): Promise<NotionPage[]> {
    const run = async () =>
      client.queryDataSource((await resolve(databaseId)).dataSourceId, {
        filter: { property: MEETING_PROPS.key, rich_text: { equals: key } },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      });
    try {
      return await run();
    } catch (err) {
      // The cached data source may be gone (database replaced or re-shared): re-resolve once.
      if (!(err instanceof NotionError) || err.status !== 404 || !cache.has(`${token}\n${databaseId.trim()}`)) throw err;
      forget(databaseId);
      return run();
    }
  }

  async function listByKey(databaseId: string, key: string): Promise<ListedMeeting[]> {
    const pages = await query(databaseId, key);
    return pages
      .filter((p) => isLive(p) && plainText(p.properties[MEETING_PROPS.key]?.rich_text) === key)
      .map((p) => ({
        pageId: p.id,
        url: p.url,
        recordedBy: plainText(p.properties[MEETING_PROPS.recordedBy]?.rich_text),
        createdAt: p.created_time,
      }))
      .sort(compareByCreation);
  }

  return {
    async findByKey(databaseId, key) {
      const first = (await listByKey(databaseId, key))[0];
      return first ? { pageId: first.pageId, url: first.url, recordedBy: first.recordedBy } : null;
    },

    listByKey,

    /**
     * Creates the row without its Key, writes the rest of the body and the Transcript
     * child page, then PATCHes the Key on. The Key marks the page complete: findByKey
     * and listByKey never see a half-written page.
     */
    async createMeeting(databaseId: string, input: MeetingPageInput) {
      let db = await resolve(databaseId);
      // Checked up front: without it every block below would be written for nothing.
      // The cached schema may predate a fix, so look again before refusing.
      if (db.properties[MEETING_PROPS.key] !== 'rich_text') {
        forget(databaseId);
        db = await resolve(databaseId);
      }
      if (db.properties[MEETING_PROPS.key] !== 'rich_text') {
        throw new NotionError(
          400,
          'schema_mismatch',
          `The Notion database "${db.title}" needs a text property named "${MEETING_PROPS.key}". Check the database in the options.`,
        );
      }
      const [body = [], ...moreBody] = batchBlocks(buildMeetingBody(input));
      let page: NotionPage;
      try {
        page = await client.createPage({
          parent: { type: 'data_source_id', data_source_id: db.dataSourceId },
          icon: { type: 'emoji', emoji: '🎧' },
          properties: pageProperties(input, db),
          children: body,
        });
      } catch (err) {
        if (err instanceof NotionError && err.status === 404) forget(databaseId);
        throw err;
      }
      let committing = false;
      try {
        for (const batch of moreBody) await client.appendBlockChildren(page.id, batch);
        const [transcript = [], ...moreTranscript] = batchBlocks(buildTranscriptBlocks(input.transcript.turns));
        const child = await client.createPage({
          parent: { type: 'page_id', page_id: page.id },
          icon: { type: 'emoji', emoji: '📝' },
          properties: { title: { title: richText(TRANSCRIPT_TITLE) } },
          children: transcript,
        });
        for (const batch of moreTranscript) await client.appendBlockChildren(child.id, batch);
        committing = true;
        // Idempotent, so the client retries it through server and network errors.
        await client.updatePage(page.id, { properties: keyProperty(input.key) });
      } catch (err) {
        // An unkeyed page can't block a retry, but would linger as a stray row: trash it
        // (best effort). A Key write that may have landed is left alone: that page is
        // complete, and a teammate's settle may already have deferred to it.
        if (!committing || refused(err)) await client.updatePage(page.id, { in_trash: true }).catch(() => undefined);
        throw err;
      }
      return { pageId: page.id, url: page.url };
    },

    /** Moves the page to Notion's trash (restorable for 30 days). */
    async archivePage(pageId) {
      await client.updatePage(pageId, { in_trash: true });
    },
  };
}
