/**
 * Per-person settings in chrome.storage.local. Keys never leave this browser except
 * in requests to Gemini and Notion.
 */
import { storage } from 'wxt/utils/storage';
import { DEFAULT_SETTINGS } from './settingsSchema';
import type { Settings } from './types';

export { DEFAULT_SETTINGS, databaseIdFor, missingSettings } from './settingsSchema';

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export async function getSettings(): Promise<Settings> {
  // Merge so settings saved by an older version pick up new fields.
  return { ...DEFAULT_SETTINGS, ...(await settingsItem.getValue()) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}
