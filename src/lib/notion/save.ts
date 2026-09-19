/**
 * Idempotent save: one Notion page per meeting key (`${meetCode}-${YYYY-MM-DD}`),
 * however many teammates recorded the meeting.
 *
 * findByKey catches the common case (someone already saved it). Two teammates who
 * finish at the same moment both miss and both create; afterwards each lists the key
 * and keeps its page only if it is the oldest (tie → smallest id). Everyone orders the
 * same set the same way, so the oldest page always survives and nobody archives it:
 * the worst outcome of a slow index is a leftover duplicate, never a lost meeting.
 */
import type { ExistingMeeting, MeetingPageInput, MeetingStore, SaveOutcome } from '../types';
import { explainError } from './errors';
import { compareByCreation, sameNotionId } from './ids';

export interface SaveOptions {
  /** Pause between post-create listings. Notion's query index can lag a new page. */
  settleDelayMs?: number;
  /** Listings before giving up on seeing our own page. */
  maxChecks?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Oldest page (tie → smallest id), or null. */
export function pickWinner<T extends { pageId: string; createdAt: string }>(pages: readonly T[]): T | null {
  return [...pages].sort(compareByCreation)[0] ?? null;
}

/** Returns the page ours lost to (after archiving ours), or null if ours stands. */
async function settle(
  store: MeetingStore,
  databaseId: string,
  key: string,
  ourPageId: string,
  { settleDelayMs = 1500, maxChecks = 5 }: SaveOptions,
): Promise<ExistingMeeting | null> {
  let confirmations = 0;
  for (let check = 0; check < maxChecks && confirmations < 2; check++) {
    if (check > 0) await sleep(settleDelayMs);
    const pages = await store.listByKey(databaseId, key);
    // Until our own page is visible the listing is too stale to judge.
    if (!pages.some((p) => sameNotionId(p.pageId, ourPageId))) continue;
    const winner = pickWinner(pages);
    if (winner && !sameNotionId(winner.pageId, ourPageId)) {
      await store.archivePage(ourPageId);
      return { pageId: winner.pageId, url: winner.url, recordedBy: winner.recordedBy };
    }
    // A teammate's page created a moment after this listing can still be older by
    // id tie-break, so confirm once more.
    confirmations++;
  }
  return null;
}

export async function saveMeeting(
  store: MeetingStore,
  databaseId: string,
  input: MeetingPageInput,
  options: SaveOptions = {},
): Promise<SaveOutcome> {
  let created: { pageId: string; url: string };
  try {
    const existing = await store.findByKey(databaseId, input.key);
    if (existing) return { status: 'duplicate', existing };
    created = await store.createMeeting(databaseId, input);
  } catch (err) {
    return { status: 'error', error: explainError(err) };
  }
  try {
    const winner = await settle(store, databaseId, input.key, created.pageId, options);
    if (winner) return { status: 'duplicate', existing: winner };
  } catch {
    // Our page is saved; failing to settle can only leave a duplicate row behind.
  }
  return { status: 'created', pageId: created.pageId, url: created.url };
}
