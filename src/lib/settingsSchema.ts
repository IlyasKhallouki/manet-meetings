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
  customVocabulary: [],
  languageCodes: [],
  includeMic: true,
};

export function databaseIdFor(settings: Settings, route: Route): string {
  return route === 'team' ? settings.notionTeamDbId : settings.notionPersonalDbId;
}

/**
 * Everything a full audio transcript needs, in the words of missingForSave, then
 * "a Gemini key" (Settings asks for it last).
 */
export function missingSettings(settings: Settings, route: Route): string[] {
  return [...missingForSave(settings, route), ...(settings.geminiApiKey.trim() ? [] : ['a Gemini key'])];
}

/**
 * What blocks filing a meeting at all, as words that fit "Add … in Settings": "your
 * name", "a Notion token", "the Team database" (or "the Personal database"), in the
 * order Settings asks for them. A blank value counts as missing, as in the popup and
 * Settings. Without a Gemini key the pipeline still saves a transcript built from captions.
 */
export function missingForSave(settings: Settings, route: Route): string[] {
  const missing: string[] = [];
  if (!settings.displayName.trim()) missing.push('your name');
  if (!settings.notionToken.trim()) missing.push('a Notion token');
  if (!databaseIdFor(settings, route).trim()) missing.push(route === 'team' ? 'the Team database' : 'the Personal database');
  return missing;
}
