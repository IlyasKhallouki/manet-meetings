/**
 * Notion ids. People paste database ids in many shapes: bare 32-hex, dashed UUID,
 * "Title-<hex>" slugs, or full links (notion.so, app.notion.com/p/…, notion.site).
 *
 * Dependency-free so scripts/notion-setup.ts can import it under Node type stripping.
 */

const ID = /(?<![0-9a-f])([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})(?![0-9a-f])/gi;

/** Returns the id as a lowercase dashed UUID, or null when the input holds no id. */
export function parseNotionId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let haystack = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      // Only the path: `?v=` is a view id and `?p=` a peeked page, never the database.
      haystack = new URL(raw).pathname;
    } catch {
      return null;
    }
  } else if (!/^(?:[^\s/?#]*-)?[0-9a-f-]{32,36}$/i.test(raw)) {
    return null;
  }
  const matches = [...haystack.matchAll(ID)];
  const last = matches.at(-1);
  if (!last) return null;
  return last.slice(1, 6).join('-').toLowerCase();
}

/** Lowercase id without dashes, for comparing ids from different sources. */
export function compactId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export function sameNotionId(a: string, b: string): boolean {
  return compactId(a) === compactId(b);
}

/**
 * Oldest first; Notion rounds created_time to the minute, so ties fall back to the
 * smallest id. Every observer sorts the same set the same way.
 */
export function compareByCreation(
  a: { pageId: string; createdAt: string },
  b: { pageId: string; createdAt: string },
): number {
  const dt = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (dt !== 0 && Number.isFinite(dt)) return dt;
  const x = compactId(a.pageId);
  const y = compactId(b.pageId);
  return x < y ? -1 : x > y ? 1 : 0;
}
