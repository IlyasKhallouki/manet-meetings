/**
 * Session metadata in chrome.storage.local (`session:<id>`), plus the pointer to the
 * recording in progress in chrome.storage.session, which survives service-worker
 * restarts but not browser restarts.
 *
 * Writes are serialized per session id within one context. Only the background
 * writes sessions; pages read them and send messages to change them.
 */
import { browser } from 'wxt/browser';
import type { SessionMeta } from '../types';

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

async function read(id: string): Promise<SessionMeta | null> {
  const key = sessionKey(id);
  const got = await browser.storage.local.get(key);
  return (got[key] as SessionMeta | undefined) ?? null;
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
  return Object.values(got as Record<string, SessionMeta>).sort(
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

/** Calls `onChange(id, meta)` for every session write, with null for deletions. */
export function watchSessions(onChange: (id: string, meta: SessionMeta | null) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(PREFIX)) continue;
      onChange(key.slice(PREFIX.length), (change.newValue as SessionMeta | undefined) ?? null);
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
