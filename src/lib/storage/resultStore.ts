/** Pipeline output per session in chrome.storage.local (`result:<id>`), kept until saved and after. */
import { browser } from 'wxt/browser';
import type { SessionResult } from '../types';

function resultKey(sessionId: string): string {
  return `result:${sessionId}`;
}

export async function getResult(sessionId: string): Promise<SessionResult | null> {
  const key = resultKey(sessionId);
  const got = await browser.storage.local.get(key);
  return (got[key] as SessionResult | undefined) ?? null;
}

export function putResult(sessionId: string, result: SessionResult): Promise<void> {
  return browser.storage.local.set({ [resultKey(sessionId)]: result });
}

export function deleteResult(sessionId: string): Promise<void> {
  return browser.storage.local.remove(resultKey(sessionId));
}
