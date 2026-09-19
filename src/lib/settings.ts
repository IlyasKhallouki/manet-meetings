/**
 * Per-person settings in chrome.storage.local. Keys never leave this browser except
 * in requests to Gemini and Notion.
 */
import { storage } from 'wxt/utils/storage';
import type { Route, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  geminiApiKey: '',
  notionToken: '',
  notionTeamDbId: '',
  notionPersonalDbId: '',
  defaultRoute: 'team',
  autoTranscribe: true,
  retentionDays: 7,
  displayName: '',
  customVocabulary: ['Lumind', 'Manet'],
  languageCodes: [],
  includeMic: true,
};

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

export function databaseIdFor(settings: Settings, route: Route): string {
  return route === 'team' ? settings.notionTeamDbId : settings.notionPersonalDbId;
}

/** Problems that block transcription or saving, as user-facing strings. */
export function missingSettings(settings: Settings, route: Route): string[] {
  const missing: string[] = [];
  if (!settings.geminiApiKey) missing.push('Gemini API key');
  if (!settings.notionToken) missing.push('Notion integration token');
  if (!databaseIdFor(settings, route)) missing.push(`Notion ${route} database id`);
  if (!settings.displayName) missing.push('Your name');
  return missing;
}
