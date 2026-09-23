/**
 * Session metadata in chrome.storage.local (`session:<id>`), plus the pointer to the
 * recording in progress in chrome.storage.session, which survives service-worker
 * restarts but not browser restarts.
 *
 * Writes are serialized per session id within one context. Only the background
 * writes sessions; pages read them and send messages to change them.
 */
import { browser } from 'wxt/browser';
import type { SessionMeta, SessionStatus } from '../types';

const PREFIX = 'session:';
const ACTIVE_KEY = 'activeRecording';

export interface ActiveRecording {
  sessionId: string;
  tabId: number;
  meetCode: string;
}

export type SessionUpdate = Partial<SessionMeta> | ((meta: SessionMeta) => SessionMeta);

export function sessionKey(id: string): string {
  return `${PREFIX}${id}`;
}

const queues = new Map<string, Promise<unknown>>();

function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** A meta as any version stored it: a meeting from before profiles takes its Team | Personal destination as its profile. */
export function normalizeMeta(meta: SessionMeta): SessionMeta {
  if (meta.profileId !== undefined || meta.route === undefined) return meta;
  return { ...meta, profileId: meta.route };
}

async function read(id: string): Promise<SessionMeta | null> {
  const key = sessionKey(id);
  const got = await browser.storage.local.get(key);
  const stored = got[key] as SessionMeta | undefined;
  return stored ? normalizeMeta(stored) : null;
}

async function storedKeys(): Promise<string[]> {
  const local = browser.storage.local;
  // getKeys arrived in Chrome 130 and the manifest allows 116: fall back to reading everything.
  try {
    if (typeof local.getKeys === 'function') return await local.getKeys();
  } catch {
    // Missing or unimplemented: use the fallback below.
  }
  return Object.keys(await local.get(null));
}

export function getSession(id: string): Promise<SessionMeta | null> {
  return read(id);
}

/** Every session, newest recording first. */
export async function listSessions(): Promise<SessionMeta[]> {
  const keys = (await storedKeys()).filter((k) => k.startsWith(PREFIX));
  if (keys.length === 0) return [];
  const got = await browser.storage.local.get(keys);
  return Object.values(got as Record<string, SessionMeta>)
    .map(normalizeMeta)
    .sort(
      (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
}

export function putSession(meta: SessionMeta): Promise<void> {
  return serialized(meta.id, () => browser.storage.local.set({ [sessionKey(meta.id)]: meta }));
}

/**
 * Applies a patch (fields set to undefined are removed) or an updater function.
 * Returns the stored value, or null without writing anything if the session does not exist.
 * An updater that returns its argument unchanged writes nothing.
 */
export function updateSession(id: string, update: SessionUpdate): Promise<SessionMeta | null> {
  return serialized(id, async () => {
    const current = await read(id);
    if (!current) return null;
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    if (next === current) return current;
    // Storage drops undefined values, so return what a later read will see.
    const stored = JSON.parse(JSON.stringify(next)) as SessionMeta;
    await browser.storage.local.set({ [sessionKey(id)]: stored });
    return stored;
  });
}

export function deleteSession(id: string): Promise<void> {
  return serialized(id, () => browser.storage.local.remove(sessionKey(id)));
}

/** Statuses that wait on the person, whatever else the session says. */
const WAITING_ON_YOU = new Set<SessionStatus>(['awaiting-route', 'processed']);

/**
 * The meeting needs a decision or a fix from the person: it waits for Team or Personal,
 * it was transcribed but not saved, or it failed with no automatic retry scheduled.
 * Drives the "Needs you" group, the popup footer and the idle toolbar badge.
 */
export function needsYou(meta: Pick<SessionMeta, 'status' | 'retryAt'>): boolean {
  if (WAITING_ON_YOU.has(meta.status)) return true;
  return meta.status === 'failed' && meta.retryAt === undefined;
}

type Changes = Record<string, { newValue?: unknown; oldValue?: unknown }>;

/**
 * Calls `onChange(id, meta, previous)` for every session write, with null for deletions
 * (and for `previous` on creation).
 */
export function watchSessions(
  onChange: (id: string, meta: SessionMeta | null, previous: SessionMeta | null) => void,
): () => void {
  const listener = (changes: Changes, area: string) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(PREFIX)) continue;
      const next = change.newValue as SessionMeta | undefined;
      const previous = change.oldValue as SessionMeta | undefined;
      onChange(key.slice(PREFIX.length), next ? normalizeMeta(next) : null, previous ? normalizeMeta(previous) : null);
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

export async function getActiveRecording(): Promise<ActiveRecording | null> {
  const got = await browser.storage.session.get(ACTIVE_KEY);
  return (got[ACTIVE_KEY] as ActiveRecording | undefined) ?? null;
}

export function setActiveRecording(pointer: ActiveRecording): Promise<void> {
  return browser.storage.session.set({ [ACTIVE_KEY]: pointer });
}

export function clearActiveRecording(): Promise<void> {
  return browser.storage.session.remove(ACTIVE_KEY);
}

/** Calls `onChange(pointer)` whenever the recording pointer is set or cleared (null). */
export function watchActiveRecording(onChange: (pointer: ActiveRecording | null) => void): () => void {
  const listener = (changes: Changes, area: string) => {
    if (area !== 'session' || !(ACTIVE_KEY in changes)) return;
    onChange((changes[ACTIVE_KEY]?.newValue as ActiveRecording | undefined) ?? null);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
