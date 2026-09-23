/** Pipeline output per session in chrome.storage.local (`result:<id>`), kept until saved and after. */
import { browser } from 'wxt/browser';
import { STARTER_SECTIONS } from '../profiles';
import type { ActionItem, MeetingSummary, SessionResult } from '../types';

/** A summary stored before profiles: a fixed summary, key points and decisions. */
interface LegacySummary {
  title: string;
  summary?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: ActionItem[];
  language?: string;
}

/** A stored summary in the current shape; one from before profiles gets the starter sections. */
export function normalizeSummary(value: MeetingSummary | LegacySummary | null | undefined): MeetingSummary | null {
  if (!value) return null;
  if (Array.isArray((value as MeetingSummary).sections)) return value as MeetingSummary;
  const old = value as LegacySummary;
  const [summary, keyPoints, decisions] = STARTER_SECTIONS;
  return {
    title: old.title,
    sections: [
      { title: summary!.title, format: 'paragraph', text: old.summary ?? '', items: [] },
      { title: keyPoints!.title, format: 'bullets', text: '', items: old.keyPoints ?? [] },
      { title: decisions!.title, format: 'bullets', text: '', items: old.decisions ?? [] },
    ],
    actionItems: old.actionItems ?? [],
    ...(old.language ? { language: old.language } : {}),
  };
}

function resultKey(sessionId: string): string {
  return `result:${sessionId}`;
}

export async function getResult(sessionId: string): Promise<SessionResult | null> {
  const key = resultKey(sessionId);
  const got = await browser.storage.local.get(key);
  const stored = got[key] as SessionResult | undefined;
  return stored ? { ...stored, summary: normalizeSummary(stored.summary) } : null;
}

export function putResult(sessionId: string, result: SessionResult): Promise<void> {
  return browser.storage.local.set({ [resultKey(sessionId)]: result });
}

export function deleteResult(sessionId: string): Promise<void> {
  return browser.storage.local.remove(resultKey(sessionId));
}
