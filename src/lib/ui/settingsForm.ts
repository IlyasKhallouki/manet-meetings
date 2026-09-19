/**
 * The options form as plain strings and booleans, and its parsing back into Settings.
 * Pure (no chrome.* and no settings.ts, which touches storage on import), so the rules
 * are testable anywhere.
 */
import { parseNotionId } from '../notion/ids';
import { missingForSave } from '../settingsSchema';
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

/** `warnings` (only when there are some) do not block saving. */
export type ParsedSettings =
  | { ok: true; settings: Settings; warnings?: SettingsErrors }
  | { ok: false; errors: SettingsErrors };

/** language[-Script][-REGION]: "fr-FR", "cmn-Hans-CN", "es-419", "ceb". */
const LANGUAGE_CODE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;

/**
 * The codes gemini-3.5-transcribe documents (ai.google.dev/gemini-api/docs/transcribe,
 * "Supported languages"). Others are saved with a warning: the list may grow before
 * this copy does.
 */
export const SUPPORTED_LANGUAGE_CODES: ReadonlySet<string> = new Set([
  'af-ZA', 'am-ET', 'ar-EG', 'hy-AM', 'as-IN', 'az-AZ', 'be-BY', 'bn-BD', 'bn-IN', 'bs-BA',
  'bg-BG', 'rup-BG', 'my-MM', 'yue-Hant-HK', 'ca-ES', 'ceb', 'km-KH', 'hr-HR', 'cs-CZ', 'da-DK',
  'nl-NL', 'en-GB', 'en-IN', 'en-US', 'et-EE', 'fa-IR', 'fil-PH', 'fi-FI', 'fr-FR', 'gl-ES',
  'ka-GE', 'de-DE', 'el-GR', 'gu-IN', 'ha-NG', 'he-IL', 'hi-IN', 'hu-HU', 'is-IS', 'id-ID',
  'it-IT', 'ja-JP', 'jv-ID', 'kea-CV', 'kn-IN', 'kk-KZ', 'ko-KR', 'ky-KG', 'lv-LV', 'ln-CD',
  'lt-LT', 'mk-MK', 'ms-MY', 'ml-IN', 'mt-MT', 'cmn-Hans-CN', 'mr-IN', 'mn-MN', 'ne-NP', 'nb-NO',
  'or-IN', 'pl-PL', 'pt-BR', 'pt-PT', 'pa-IN', 'pa-Guru-IN', 'ro-RO', 'ru-RU', 'sr-RS', 'sd-Arab-IN',
  'sk-SK', 'sl-SI', 'es-419', 'es-US', 'sw-KE', 'sv-SE', 'tg-TJ', 'te-IN', 'th-TH', 'tr-TR',
  'uk-UA', 'uz-UZ', 'vi-VN',
]);

/** Macrolanguage codes whose listed entries go by another language subtag. */
const LANGUAGE_ALIASES: Record<string, string[]> = { zh: ['cmn', 'yue'], no: ['nb'], tl: ['fil'] };

/**
 * What the pages warn about. Only `blocking` stops a save (as in the background); without
 * a Gemini key meetings are still filed, with a transcript built from captions.
 */
export function setupProblems(settings: Settings, route: Route): { blocking: string[]; geminiKeyMissing: boolean } {
  return {
    blocking: missingForSave(settings, route),
    geminiKeyMissing: !settings.geminiApiKey,
  };
}

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

/**
 * Codes are kept as written, casing aside (fr-fr → fr-FR). Intl.getCanonicalLocales is
 * not used: its CLDR aliases rewrite documented codes (cmn-Hans-CN → zh-Hans-CN).
 * `unsupported`: well-formed codes missing from SUPPORTED_LANGUAGE_CODES, kept in `codes`.
 */
export function parseLanguageCodes(text: string): { codes: string[]; invalid: string[]; unsupported: string[] } {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    if (!raw) continue;
    const m = LANGUAGE_CODE.exec(raw);
    if (!m) {
      invalid.push(raw);
      continue;
    }
    const [, language, script, region] = m;
    let code = language!.toLowerCase();
    if (script) code += `-${script[0]!.toUpperCase()}${script.slice(1).toLowerCase()}`;
    if (region) code += `-${region.toUpperCase()}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes, invalid, unsupported: codes.filter((c) => !SUPPORTED_LANGUAGE_CODES.has(c)) };
}

function listed(language: string): string[] {
  const languages = LANGUAGE_ALIASES[language] ?? [language];
  return [...SUPPORTED_LANGUAGE_CODES].filter((c) => languages.includes(c.split('-')[0]!)).sort();
}

function orList(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** Why some codes may not work, with the listed codes for the same language; undefined when all are listed. */
export function languageCodeWarning(codes: readonly string[]): string | undefined {
  const unsupported = codes.filter((c) => !SUPPORTED_LANGUAGE_CODES.has(c));
  if (!unsupported.length) return undefined;
  const named = unsupported.map((code) => {
    const alternatives = listed(code.split('-')[0]!.toLowerCase());
    return alternatives.length ? `"${code}" (try ${orList(alternatives)})` : `"${code}"`;
  });
  return `Not in Gemini's list of transcription languages: ${named.join(', ')}. Gemini may reject them.`;
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
  const warnings: SettingsErrors = {};
  const languageWarning = languageCodeWarning(languages.codes);
  if (languageWarning) warnings.languageCodes = languageWarning;

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
  if (Object.keys(errors).length) return { ok: false, errors };
  return Object.keys(warnings).length ? { ok: true, settings, warnings } : { ok: true, settings };
}
