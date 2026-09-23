/**
 * The Settings page's form as plain strings and booleans, and its parsing back into
 * Settings, one field at a time (instant apply) or all at once. Also the setup checklist
 * and the wording of Check results. Pure (no chrome.* and no settings.ts, which touches
 * storage on import), so the rules are testable anywhere.
 */
import type { VerifyResult } from '../notion/verify';
import { parseNotionId } from '../notion/ids';
import { missingForSave } from '../settingsSchema';
import { MAX_VOCABULARY } from '../transcribe/requests';
import type { Profile, Route, Settings } from '../types';

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

export type FieldName = keyof SettingsFormValues;

export type SettingsErrors = Partial<Record<keyof Settings, string>>;

/** `warnings` (only when there are some) do not block saving. */
export type ParsedSettings =
  | { ok: true; settings: Settings; warnings?: SettingsErrors }
  | { ok: false; errors: SettingsErrors };

/**
 * One field's value parsed for saving. An invalid value has no patch, so it can never be
 * written. `note` is advice that does not block saving (unlisted language codes).
 */
export type FieldResult = { ok: true; patch: Partial<Settings>; note?: string } | { ok: false; error: string };

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
export function setupProblems(
  settings: Settings,
  profile: Pick<Profile, 'name' | 'databaseId'>,
): { blocking: string[]; geminiKeyMissing: boolean } {
  return { blocking: missingForSave(settings, profile), geminiKeyMissing: !settings.geminiApiKey };
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

/** One stored setting as its field shows it. */
export function formValue<K extends FieldName>(s: Settings, name: K): SettingsFormValues[K] {
  return settingsToForm(s)[name];
}

// ---------------------------------------------------------------------------------------
// Parsing

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

/** "a", "a or b", "a, b or c" (conjunction: "or" / "and"). */
function series(items: string[], conjunction: 'or' | 'and'): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

const quoted = (s: string) => `“${s}”`;

/**
 * Why some codes may not work, with the listed codes for the same language; undefined
 * when all are listed. Advice only: the codes are saved.
 */
export function languageCodeWarning(codes: readonly string[]): string | undefined {
  const unsupported = codes.filter((c) => !SUPPORTED_LANGUAGE_CODES.has(c));
  if (!unsupported.length) return undefined;
  const suggestions = [...new Set(unsupported.flatMap((code) => listed(code.split('-')[0]!.toLowerCase())))];
  const named = series(unsupported.map(quoted), 'or');
  if (!suggestions.length) {
    const them = unsupported.length === 1 ? 'it' : 'them';
    return `Gemini doesn’t list ${named} for transcription and may reject ${them}. Leave this empty to detect languages automatically.`;
  }
  return `Gemini doesn’t list ${named} for transcription. Try ${series(suggestions, 'or')}, or leave this empty.`;
}

const trimmed = (v: string) => v.trim();

/** Parses one field. The rules parseSettingsForm applies to the whole form. */
export function parseField<K extends FieldName>(name: K, value: SettingsFormValues[K]): FieldResult {
  const text = typeof value === 'string' ? value : '';
  switch (name) {
    case 'displayName':
      return { ok: true, patch: { displayName: text.trim().replace(/\s+/g, ' ') } };
    case 'geminiApiKey':
    case 'notionToken': {
      const v = trimmed(text);
      if (/\s/.test(v)) {
        return { ok: false, error: `This has spaces in it. Paste the ${name === 'notionToken' ? 'token' : 'key'} again.` };
      }
      return { ok: true, patch: { [name]: v } };
    }
    case 'notionTeamDbId':
    case 'notionPersonalDbId': {
      // Kept as pasted: the Notion store resolves links, slugs and bare ids itself.
      const v = trimmed(text);
      if (v && !parseNotionId(v)) return { ok: false, error: 'Paste the database link or ID from Notion.' };
      return { ok: true, patch: { [name]: v } };
    }
    case 'defaultRoute':
      return value === 'team' || value === 'personal'
        ? { ok: true, patch: { defaultRoute: value } }
        : { ok: false, error: 'Choose Team or Personal.' };
    case 'autoTranscribe':
    case 'includeMic':
      return { ok: true, patch: { [name]: value === true } };
    case 'retentionDays': {
      const v = trimmed(text);
      const days = /^\d+$/.test(v) ? Number(v) : NaN;
      if (!(days >= 0 && days <= MAX_RETENTION_DAYS)) {
        return { ok: false, error: `Enter a number of days from 0 to ${MAX_RETENTION_DAYS}.` };
      }
      return { ok: true, patch: { retentionDays: days } };
    }
    case 'customVocabulary': {
      const terms = parseVocabulary(text);
      if (terms.length > MAX_VOCABULARY) {
        const n = (x: number) => x.toLocaleString('en-US');
        return { ok: false, error: `Use at most ${n(MAX_VOCABULARY)} terms. This list has ${n(terms.length)}.` };
      }
      return { ok: true, patch: { customVocabulary: terms } };
    }
    case 'languageCodes': {
      const { codes, invalid } = parseLanguageCodes(text);
      if (invalid.length) {
        // Names the problem only: the hint right under it gives the format and "leave empty".
        const what = invalid.length === 1 ? 'isn’t a language code' : 'aren’t language codes';
        return { ok: false, error: `${series(invalid.map(quoted), 'and')} ${what}.` };
      }
      const note = languageCodeWarning(codes);
      return note ? { ok: true, patch: { languageCodes: codes }, note } : { ok: true, patch: { languageCodes: codes } };
    }
    default:
      return { ok: false, error: `Unknown setting ${String(name)}.` };
  }
}

const FIELDS: FieldName[] = [
  'geminiApiKey',
  'notionToken',
  'notionTeamDbId',
  'notionPersonalDbId',
  'defaultRoute',
  'autoTranscribe',
  'retentionDays',
  'displayName',
  'customVocabulary',
  'languageCodes',
  'includeMic',
];

export function parseSettingsForm(v: SettingsFormValues): ParsedSettings {
  const errors: SettingsErrors = {};
  const warnings: SettingsErrors = {};
  const settings = {} as Settings;
  for (const name of FIELDS) {
    const result = parseField(name, v[name]);
    if (!result.ok) {
      errors[name] = result.error;
      continue;
    }
    Object.assign(settings, result.patch);
    if (result.note) warnings[name] = result.note;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return Object.keys(warnings).length ? { ok: true, settings, warnings } : { ok: true, settings };
}

// ---------------------------------------------------------------------------------------
// Setup checklist

export interface SetupItem {
  /** The field the item focuses. */
  key: 'displayName' | 'notionToken' | 'notionTeamDbId' | 'notionPersonalDbId' | 'geminiApiKey';
  label: string;
  done: boolean;
  /** Not needed to save meetings (the Gemini key: without it, transcripts come from captions). */
  optional: boolean;
}

/**
 * What Settings asks for while meetings can't be saved: the fields missingForSave checks
 * (the Team database always, the Personal one too when it is the default), then the
 * optional Gemini key.
 */
export function setupChecklist(s: Settings): SetupItem[] {
  const item = (key: SetupItem['key'], label: string, optional = false): SetupItem => ({
    key,
    label,
    done: s[key].trim() !== '',
    optional,
  });
  return [
    item('displayName', 'Your name'),
    item('notionToken', 'Notion token'),
    item('notionTeamDbId', 'Team database'),
    ...(s.defaultRoute === 'personal' ? [item('notionPersonalDbId', 'Personal database')] : []),
    item('geminiApiKey', 'Gemini API key', true),
  ];
}

export function setupComplete(items: SetupItem[]): boolean {
  return items.every((i) => i.done || i.optional);
}

/** missingForSave's (and missingSettings') items → the field, in the order Settings shows them. */
const MISSING_FIELDS: [RegExp, SetupItem['key']][] = [
  [/^your name$/i, 'displayName'],
  // missingForSave's phrases ('a Notion token', 'the Team profile’s database') and older records' names.
  [/notion (integration )?token/i, 'notionToken'],
  [/profile’s database/i, 'notionTeamDbId'],
  [/team database/i, 'notionTeamDbId'],
  [/personal database/i, 'notionPersonalDbId'],
  [/gemini api key/i, 'geminiApiKey'],
];

/**
 * Where "Open settings" should land: the first missing setting in page order, for
 * extension.ts openSettings(field). Undefined when nothing listed is known.
 */
export function firstMissingField(missing: readonly string[]): SetupItem['key'] | undefined {
  return MISSING_FIELDS.find(([pattern]) => missing.some((item) => pattern.test(item)))?.[1];
}

// ---------------------------------------------------------------------------------------
// Check results

export type CheckTone = 'caution' | 'done' | 'neutral';
export interface CheckMessage {
  tone: CheckTone;
  text: string;
}

function databaseMessage(result: VerifyResult | null, route: Route): CheckMessage {
  if (!result) {
    const name = route === 'team' ? 'Team' : 'Personal';
    return { tone: 'neutral', text: `Not set yet. Add it to save meetings to ${name}.` };
  }
  if (result.ok) return { tone: 'done', text: `${quoted(result.title)} is ready.` };
  // verifyDatabase already words each problem for the field it sits under.
  return { tone: 'caution', text: result.problems.join(' ') };
}

/**
 * Where each Check both databases result goes: a token problem once, under the token
 * (review M4: not twice, under each database); otherwise one line under each database.
 * `null`: the database field is empty, so it wasn't checked.
 */
export function notionCheckMessages(results: {
  team: VerifyResult | null;
  personal: VerifyResult | null;
}): { token?: CheckMessage; team?: CheckMessage; personal?: CheckMessage } {
  for (const r of [results.team, results.personal]) {
    // notion/verify.ts flags what the token, not the database, is at fault for.
    if (r && !r.ok && r.tokenProblem) return { token: { tone: 'caution', text: r.problems.join(' ') } };
  }
  return { team: databaseMessage(results.team, 'team'), personal: databaseMessage(results.personal, 'personal') };
}
