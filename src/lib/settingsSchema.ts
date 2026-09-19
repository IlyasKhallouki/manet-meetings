/**
 * Settings defaults and pure helpers, free of chrome.storage so the offscreen document
 * (which only has chrome.runtime) can import them. settings.ts re-exports these.
 */
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
