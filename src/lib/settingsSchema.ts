/**
 * Settings defaults and pure helpers, free of chrome.storage so the offscreen document
 * (which only has chrome.runtime) can import them. settings.ts re-exports these.
 */
import { starterProfiles } from './profiles';
import type { Profile, Route, Settings } from './types';

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
  profiles: starterProfiles(),
  defaultProfileId: 'team',
};

/** Fields settings stored before profiles may carry. */
interface LegacySettings {
  notionTeamDbId?: string;
  notionPersonalDbId?: string;
  defaultRoute?: string;
}

/**
 * Stored settings made current. Missing fields take their defaults. Settings from before
 * profiles get Team and Personal built from their two databases, with the ids 'team' and
 * 'personal', so a meeting's old destination names its profile; the old default route
 * becomes the default profile. A default id that names no profile falls back to the first.
 */
export function normalizeSettings(stored: (Partial<Settings> & LegacySettings) | null | undefined): Settings {
  const s = stored ?? {};
  const merged: Settings = { ...DEFAULT_SETTINGS, ...s };
  // @wxt-dev/storage returns its fallback (DEFAULT_SETTINGS) by reference, so a fresh
  // install's stored profiles can literally be DEFAULT_SETTINGS.profiles; hand out a
  // fresh copy instead, or an in-place edit later would corrupt the shared defaults.
  const profiles =
    Array.isArray(s.profiles) && s.profiles.length > 0 && s.profiles !== DEFAULT_SETTINGS.profiles
      ? s.profiles
      : starterProfiles(s.notionTeamDbId ?? '', s.notionPersonalDbId ?? '');
  const ids = new Set(profiles.map((p) => p.id));
  const defaultProfileId =
    [s.defaultProfileId, s.defaultRoute].find((id): id is string => id !== undefined && ids.has(id)) ?? profiles[0]!.id;
  return { ...merged, profiles, defaultProfileId };
}

export function databaseIdFor(settings: Settings, route: Route): string {
  return route === 'team' ? settings.notionTeamDbId : settings.notionPersonalDbId;
}

/**
 * Everything a full audio transcript needs, in the words of missingForSave, then
 * "a Gemini key" (Settings asks for it last).
 */
export function missingSettings(settings: Settings, profile: Pick<Profile, 'name' | 'databaseId'>): string[] {
  return [...missingForSave(settings, profile), ...(settings.geminiApiKey.trim() ? [] : ['a Gemini key'])];
}

/**
 * What blocks filing a meeting at all, as words that fit "Add … in Settings": "your
 * name", "a Notion token", "the Client meeting profile’s database", in the order Settings
 * asks for them. A blank value counts as missing, as in the popup and Settings. Without a
 * Gemini key the pipeline still saves a transcript built from captions.
 */
export function missingForSave(settings: Settings, profile: Pick<Profile, 'name' | 'databaseId'>): string[] {
  const missing: string[] = [];
  if (!settings.displayName.trim()) missing.push('your name');
  if (!settings.notionToken.trim()) missing.push('a Notion token');
  if (!profile.databaseId.trim()) missing.push(`the ${profile.name.trim()} profile’s database`);
  return missing;
}
