/**
 * Per-person settings in chrome.storage.local. Keys never leave this browser except
 * in requests to Gemini and Notion.
 */
import { storage } from 'wxt/utils/storage';
import { DEFAULT_SETTINGS, normalizeSettings } from './settingsSchema';
import type { Settings } from './types';

export { DEFAULT_SETTINGS, missingForSave, missingSettings, normalizeSettings } from './settingsSchema';

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export async function getSettings(): Promise<Settings> {
  // Settings saved by an older version pick up new fields, and profiles.
  return normalizeSettings(await settingsItem.getValue());
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await settingsItem.setValue(next);
  return next;
}
