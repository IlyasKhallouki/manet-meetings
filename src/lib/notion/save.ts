/**
 * Idempotent save: one Notion page per meeting key (`${meetCode}-${YYYY-MM-DD}`),
 * however many teammates recorded the meeting.
 *
 * The store writes the Key last, so only complete pages carry it. findByKey catches
 * the common case (someone already saved it). Two teammates who finish at the same
 * moment both miss and both create; afterwards each lists the key and keeps its page
 * only if it is the oldest (tie → smallest id). Everyone orders the same set the same
 * way, so the oldest keyed page always survives and nobody archives it: the worst
 * outcome of a slow index is a leftover duplicate, never a lost meeting.
 */
import type { ExistingMeeting, MeetingPageInput, MeetingStore, SaveOutcome } from '../types';
import { explainError } from './errors';
import { compareByCreation, sameNotionId } from './ids';

export interface SaveOptions {
  /** Create the page even if the key is taken, and keep it: the user chose "Save anyway". */
  force?: boolean;
  /** Pause between post-create listings. */
  settleDelayMs?: number;
  /** How long to wait for our own page to show up in the key's listing; Notion's query index lags writes. */
  settleTimeoutMs?: number;
}

/** Listings that must show our page as the oldest before it stands. */
const CONFIRMATIONS = 2;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Oldest page (tie → smallest id), or null. */
export function pickWinner<T extends { pageId: string; createdAt: string }>(pages: readonly T[]): T | null {
  return [...pages].sort(compareByCreation)[0] ?? null;
}

export interface SettleState {
  ourPageId: string;
  /** Epoch ms after which a listing without our page ends the wait. */
  deadline: number;
  /** Listings so far that showed our page as the oldest. */
  confirmations: number;
}

export type SettleStep<T> = { verdict: 'wait'; state: SettleState } | { verdict: 'stands' } | { verdict: 'lost'; winner: T };

/**
 * Judges one listing of the key, taken at `now`. A listing without our page is too
 * stale to judge, so confirmations only count once it is visible and a lagging index
 * cannot use them up. Past the deadline, a listing still without our page ends the
 * wait and ours stays.
 */
export function settleStep<T extends { pageId: string; createdAt: string }>(
  state: SettleState,
  pages: readonly T[],
  now: number,
): SettleStep<T> {
  if (!pages.some((p) => sameNotionId(p.pageId, state.ourPageId))) {
    return now >= state.deadline ? { verdict: 'stands' } : { verdict: 'wait', state };
  }
  const winner = pickWinner(pages)!;
  if (!sameNotionId(winner.pageId, state.ourPageId)) return { verdict: 'lost', winner };
  // A teammate's page created a moment after this listing can still be older by id
  // tie-break, so confirm once more.
  const confirmations = state.confirmations + 1;
  return confirmations >= CONFIRMATIONS ? { verdict: 'stands' } : { verdict: 'wait', state: { ...state, confirmations } };
}

/** Returns the page ours lost to (after archiving ours), or null if ours stands. */
async function settle(
  store: MeetingStore,
  databaseId: string,
  key: string,
  ourPageId: string,
  { settleDelayMs = 1500, settleTimeoutMs = 20_000 }: SaveOptions,
): Promise<ExistingMeeting | null> {
  let state: SettleState = { ourPageId, deadline: Date.now() + settleTimeoutMs, confirmations: 0 };
  for (;;) {
    const step = settleStep(state, await store.listByKey(databaseId, key), Date.now());
    if (step.verdict === 'stands') return null;
    if (step.verdict === 'lost') {
      await store.archivePage(ourPageId);
      return { pageId: step.winner.pageId, url: step.winner.url, recordedBy: step.winner.recordedBy };
    }
    state = step.state;
    await sleep(settleDelayMs);
  }
}

export async function saveMeeting(
  store: MeetingStore,
  databaseId: string,
  input: MeetingPageInput,
  options: SaveOptions = {},
): Promise<SaveOutcome> {
  let created: { pageId: string; url: string };
  try {
    if (!options.force) {
      const existing = await store.findByKey(databaseId, input.key);
      if (existing) return { status: 'duplicate', existing };
    }
    created = await store.createMeeting(databaseId, input);
  } catch (err) {
    return { status: 'error', error: explainError(err) };
  }
  if (options.force) return { status: 'created', pageId: created.pageId, url: created.url };
  try {
    const winner = await settle(store, databaseId, input.key, created.pageId, options);
    if (winner) return { status: 'duplicate', existing: winner };
  } catch {
    // Our page is saved; failing to settle can only leave a duplicate row behind.
  }
  return { status: 'created', pageId: created.pageId, url: created.url };
}
