/**
 * The options form as plain strings and booleans, and its parsing back into Settings.
 * Pure (no chrome.* and no settings.ts, which touches storage on import), so the rules
 * are testable anywhere.
 */
import { parseNotionId } from '../notion/ids';
import { MAX_VOCABULARY } from '../transcribe/requests';
import type { Route, Settings } from '../types';

export const MAX_RETENTION_DAYS = 365;

export interface SettingsFormValues {
  displayName: string;
  geminiApiKey: string;
  notionToken: string;
  notionTeamDbId: string;
  notionPersonalDbId: string;
  defaultRoute: string;
  autoTranscribe: boolean;
  retentionDays: string;
  /** One term per line. */
  customVocabulary: string;
  /** Comma-separated BCP-47 codes. */
  languageCodes: string;
  includeMic: boolean;
}

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

export type ParsedSettings = { ok: true; settings: Settings } | { ok: false; errors: SettingsErrors };

/** language[-Script][-REGION]: "fr", "en-US", "zh-Hant-TW", "es-419". */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?$/i;

export function settingsToForm(s: Settings): SettingsFormValues {
  return {
    displayName: s.displayName,
    geminiApiKey: s.geminiApiKey,
    notionToken: s.notionToken,
    notionTeamDbId: s.notionTeamDbId,
    notionPersonalDbId: s.notionPersonalDbId,
    defaultRoute: s.defaultRoute,
    autoTranscribe: s.autoTranscribe,
    retentionDays: String(s.retentionDays),
    customVocabulary: s.customVocabulary.join('\n'),
    languageCodes: s.languageCodes.join(', '),
    includeMic: s.includeMic,
  };
}

/** One term per line; blanks and case-insensitive repeats dropped (first spelling wins). */
export function parseVocabulary(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const term = line.trim();
    const key = term.toLocaleLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

export function parseLanguageCodes(text: string): { codes: string[]; invalid: string[] } {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (!raw) continue;
    let code: string | undefined;
    if (LANGUAGE_CODE.test(raw)) {
      try {
        code = Intl.getCanonicalLocales(raw)[0];
      } catch {
        code = undefined;
      }
    }
    if (!code) invalid.push(raw);
    else if (!codes.includes(code)) codes.push(code);
  }
  return { codes, invalid };
}

function parseSecret(value: string, errors: SettingsErrors, field: 'geminiApiKey' | 'notionToken'): string {
  const v = value.trim();
  if (/\s/.test(v)) errors[field] = 'This contains spaces; paste the key again.';
  return v;
}

function parseDatabase(value: string, errors: SettingsErrors, field: 'notionTeamDbId' | 'notionPersonalDbId'): string {
  // Kept as pasted: the Notion store resolves links, slugs and bare ids itself.
  const v = value.trim();
  if (v && !parseNotionId(v)) errors[field] = 'Paste the database link or id from Notion.';
  return v;
}

export function parseSettingsForm(v: SettingsFormValues): ParsedSettings {
  const errors: SettingsErrors = {};

  const retention = v.retentionDays.trim();
  const retentionDays = /^\d+$/.test(retention) ? Number(retention) : NaN;
  if (!(retentionDays >= 0 && retentionDays <= MAX_RETENTION_DAYS)) {
    errors.retentionDays = `Enter a whole number of days from 0 to ${MAX_RETENTION_DAYS}.`;
  }

  if (v.defaultRoute !== 'team' && v.defaultRoute !== 'personal') errors.defaultRoute = 'Choose Team or Personal.';

  const customVocabulary = parseVocabulary(v.customVocabulary);
  if (customVocabulary.length > MAX_VOCABULARY) {
    errors.customVocabulary = `At most ${MAX_VOCABULARY} terms (this list has ${customVocabulary.length}).`;
  }

  const languages = parseLanguageCodes(v.languageCodes);
  if (languages.invalid.length) {
    const list = languages.invalid.map((c) => `"${c}"`).join(', ');
    errors.languageCodes = `Not a language code: ${list}. Use codes like en-US, fr-FR, or leave empty.`;
  }

  const settings: Settings = {
    geminiApiKey: parseSecret(v.geminiApiKey, errors, 'geminiApiKey'),
    notionToken: parseSecret(v.notionToken, errors, 'notionToken'),
    notionTeamDbId: parseDatabase(v.notionTeamDbId, errors, 'notionTeamDbId'),
    notionPersonalDbId: parseDatabase(v.notionPersonalDbId, errors, 'notionPersonalDbId'),
    defaultRoute: v.defaultRoute as Route,
    autoTranscribe: v.autoTranscribe,
    retentionDays,
    displayName: v.displayName.trim().replace(/\s+/g, ' '),
    customVocabulary,
    languageCodes: languages.codes,
    includeMic: v.includeMic,
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, settings };
}
