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

/** Everything a full audio transcript needs, as user-facing strings. */
export function missingSettings(settings: Settings, route: Route): string[] {
  return [...(settings.geminiApiKey ? [] : ['Gemini API key']), ...missingForSave(settings, route)];
}

/**
 * What blocks filing a meeting at all. Without a Gemini key the pipeline still saves a
 * transcript built from captions.
 */
export function missingForSave(settings: Settings, route: Route): string[] {
  const missing: string[] = [];
  if (!settings.notionToken) missing.push('Notion integration token');
  if (!databaseIdFor(settings, route)) missing.push(`Notion ${route} database id`);
  if (!settings.displayName) missing.push('Your name');
  return missing;
}
