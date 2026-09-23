/**
 * The shareable config file: profiles plus the settings a team shares, and the API keys
 * only when the exporter asks. Never your name or your meetings. Pure, so the Settings
 * page and the tests use the same rules.
 */
import { profileProblems } from './profiles';
import { MAX_VOCABULARY } from './transcribe/requests';
import type { NoteSection, Profile, Settings } from './types';
import { MAX_RETENTION_DAYS, parseLanguageCodes } from './ui/settingsForm';

export const CONFIG_FORMAT = 'manet-config';
export const CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 1_000_000;

export const SHARED_SETTINGS = ['customVocabulary', 'languageCodes', 'autoTranscribe', 'retentionDays', 'includeMic'] as const;
export type SharedSettings = Pick<Settings, (typeof SHARED_SETTINGS)[number]>;

export interface ConfigKeys {
  geminiApiKey: string;
  notionToken: string;
}

export interface ConfigFile {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  name: string;
  exportedAt: string;
  defaultProfileId: string;
  profiles: Profile[];
  settings: SharedSettings;
  keys?: ConfigKeys;
}

const SETTING_LABELS: Record<(typeof SHARED_SETTINGS)[number], string> = {
  customVocabulary: 'Vocabulary',
  languageCodes: 'Languages',
  autoTranscribe: 'Transcribe automatically',
  retentionDays: 'Keep audio',
  includeMic: 'Include your microphone',
};

// ---------------------------------------------------------------------------------------
// Export

export function buildConfigFile(settings: Settings, opts: { name: string; includeKeys: boolean; now?: number }): ConfigFile {
  const file: ConfigFile = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    name: opts.name.trim() || 'Manet config',
    exportedAt: new Date(opts.now ?? Date.now()).toISOString(),
    defaultProfileId: settings.defaultProfileId,
    profiles: settings.profiles,
    settings: {
      customVocabulary: settings.customVocabulary,
      languageCodes: settings.languageCodes,
      autoTranscribe: settings.autoTranscribe,
      retentionDays: settings.retentionDays,
      includeMic: settings.includeMic,
    },
  };
  if (opts.includeKeys) file.keys = { geminiApiKey: settings.geminiApiKey, notionToken: settings.notionToken };
  return file;
}

/** "manet-config-acme-team.json": the name in lower case, runs of other characters as one dash. */
export function configFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug ? `manet-config-${slug}.json` : 'manet-config.json';
}

export function serializeConfig(file: ConfigFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------
// Import: parsing

export type ParseResult = { ok: true; file: ConfigFile } | { ok: false; error: string };

const NOT_CONFIG = 'This file isn’t a Manet Meetings config. Choose a file exported from Settings › Share.';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function readSection(v: unknown): NoteSection | null {
  if (!isObject(v)) return null;
  const { id, title, instruction, format } = v;
  if (!isString(id) || !id || !isString(title) || !isString(instruction)) return null;
  if (format !== 'paragraph' && format !== 'bullets') return null;
  return { id, title, instruction, format };
}

function readProfile(v: unknown): Profile | null {
  if (!isObject(v)) return null;
  const { id, name, databaseId, prompt, sections, vocabulary } = v;
  if (!isString(id) || !id || !isString(name) || !isString(databaseId) || !isString(prompt)) return null;
  if (!Array.isArray(sections) || !isStringList(vocabulary)) return null;
  const read = sections.map(readSection);
  if (read.some((s) => s === null)) return null;
  return { id, name, databaseId, prompt, sections: read as NoteSection[], vocabulary };
}

function settingsError(v: unknown): string | null {
  const bad = (label: string, why: string) => `The file’s ${label} setting ${why}.`;
  if (!isObject(v)) return 'The file has no settings.';
  if (!isStringList(v.customVocabulary) || v.customVocabulary.length > MAX_VOCABULARY) {
    return bad(SETTING_LABELS.customVocabulary, `must be a list of at most ${MAX_VOCABULARY.toLocaleString('en-US')} terms`);
  }
  if (!isStringList(v.languageCodes) || parseLanguageCodes(v.languageCodes.join(',')).invalid.length > 0) {
    return bad(SETTING_LABELS.languageCodes, 'has codes that aren’t language codes');
  }
  for (const key of ['autoTranscribe', 'includeMic'] as const) {
    if (typeof v[key] !== 'boolean') return bad(SETTING_LABELS[key], 'must be on or off');
  }
  const days = v.retentionDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    return bad(SETTING_LABELS.retentionDays, `must be a number of days from 0 to ${MAX_RETENTION_DAYS}`);
  }
  return null;
}

/** Reads a config file's text. Every rejection is one sentence saying what is wrong. */
export function parseConfigFile(text: string): ParseResult {
  if (text.length > MAX_CONFIG_BYTES) return { ok: false, error: 'This file is too large to be a Manet Meetings config.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: NOT_CONFIG };
  }
  if (!isObject(json) || json.format !== CONFIG_FORMAT) return { ok: false, error: NOT_CONFIG };
  if (typeof json.version === 'number' && json.version > CONFIG_VERSION) {
    return { ok: false, error: 'This file needs a newer version of Manet Meetings.' };
  }
  if (json.version !== CONFIG_VERSION) return { ok: false, error: NOT_CONFIG };
  if (!Array.isArray(json.profiles) || json.profiles.length === 0) return { ok: false, error: 'The file has no profiles.' };
  const profiles: Profile[] = [];
  for (const [i, raw] of json.profiles.entries()) {
    const profile = readProfile(raw);
    if (!profile) return { ok: false, error: `Profile ${i + 1} in the file is incomplete.` };
    profiles.push(profile);
  }
  if (new Set(profiles.map((p) => p.id)).size !== profiles.length) {
    return { ok: false, error: 'Two profiles in the file share an id.' };
  }
  for (const profile of profiles) {
    const [problem] = profileProblems(profile, profiles);
    if (problem) return { ok: false, error: `“${profile.name.trim() || 'A profile'}”: ${problem}` };
  }
  if (!isString(json.defaultProfileId) || !profiles.some((p) => p.id === json.defaultProfileId)) {
    return { ok: false, error: 'The file’s default profile isn’t one of its profiles.' };
  }
  const problem = settingsError(json.settings);
  if (problem) return { ok: false, error: problem };
  const s = json.settings as unknown as SharedSettings;
  let keys: ConfigKeys | undefined;
  if (json.keys !== undefined) {
    const k = json.keys;
    const clean = (v: unknown) => isString(v) && !/\s/.test(v);
    if (!isObject(k) || !clean(k.geminiApiKey) || !clean(k.notionToken)) {
      return { ok: false, error: 'The file’s API keys are damaged.' };
    }
    keys = { geminiApiKey: k.geminiApiKey as string, notionToken: k.notionToken as string };
  }
  const file: ConfigFile = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    name: isString(json.name) && json.name.trim() ? json.name.trim() : 'Manet config',
    exportedAt: isString(json.exportedAt) ? json.exportedAt : '',
    defaultProfileId: json.defaultProfileId,
    profiles,
    settings: {
      customVocabulary: s.customVocabulary,
      languageCodes: s.languageCodes,
      autoTranscribe: s.autoTranscribe,
      retentionDays: s.retentionDays,
      includeMic: s.includeMic,
    },
    ...(keys ? { keys } : {}),
  };
  return { ok: true, file };
}

// ---------------------------------------------------------------------------------------
// Import: preview and merge

const fold = (s: string) => s.trim().toLocaleLowerCase();

/** The fields of a profile an import would change, in the editor's words. */
function changedFields(from: Profile, to: Profile): string[] {
  const fields: string[] = [];
  if (from.name !== to.name) fields.push('name');
  if (from.databaseId.trim() !== to.databaseId.trim()) fields.push('database');
  if (from.prompt !== to.prompt) fields.push('prompt');
  if (JSON.stringify(from.sections) !== JSON.stringify(to.sections)) fields.push('sections');
  if (JSON.stringify(from.vocabulary) !== JSON.stringify(to.vocabulary)) fields.push('vocabulary');
  return fields;
}

function settingText(key: (typeof SHARED_SETTINGS)[number], value: SharedSettings[typeof key]): string {
  switch (key) {
    case 'customVocabulary': {
      const n = (value as string[]).length;
      return `${n} term${n === 1 ? '' : 's'}`;
    }
    case 'languageCodes': {
      const codes = value as string[];
      return codes.length ? codes.join(', ') : 'Automatic';
    }
    case 'autoTranscribe':
    case 'includeMic':
      return value ? 'On' : 'Off';
    case 'retentionDays': {
      const days = value as number;
      return `${days} day${days === 1 ? '' : 's'}`;
    }
  }
}

export type ProfileChange = 'added' | 'changed' | 'unchanged' | 'kept';

export interface ConfigPreview {
  name: string;
  exportedAt: string;
  /** File profiles in file order, then local profiles the file doesn't have ('kept'). */
  profiles: { id: string; name: string; change: ProfileChange; fields: string[] }[];
  /** Shared settings the import changes. */
  settings: { label: string; from: string; to: string }[];
  /** Set when the default profile changes. */
  defaultProfile: { from: string; to: string } | null;
  keys: 'replaced' | 'kept';
}

export function previewConfig(current: Settings, file: ConfigFile): ConfigPreview {
  const local = new Map(current.profiles.map((p) => [p.id, p]));
  const inFile = new Set(file.profiles.map((p) => p.id));
  const profiles: ConfigPreview['profiles'] = file.profiles.map((p) => {
    const mine = local.get(p.id);
    if (!mine) return { id: p.id, name: p.name, change: 'added', fields: [] };
    const fields = changedFields(mine, p);
    return { id: p.id, name: p.name, change: fields.length ? 'changed' : 'unchanged', fields };
  });
  for (const p of current.profiles) if (!inFile.has(p.id)) profiles.push({ id: p.id, name: p.name, change: 'kept', fields: [] });

  const settings: ConfigPreview['settings'] = [];
  for (const key of SHARED_SETTINGS) {
    const from = settingText(key, current[key]);
    const to = settingText(key, file.settings[key]);
    if (JSON.stringify(current[key]) !== JSON.stringify(file.settings[key])) settings.push({ label: SETTING_LABELS[key], from, to });
  }
  const merged = mergeConfig(current, file);
  const nameOf = (s: Settings) => s.profiles.find((p) => p.id === s.defaultProfileId)?.name ?? '';
  const defaultProfile =
    current.defaultProfileId === merged.defaultProfileId ? null : { from: nameOf(current), to: nameOf(merged) };
  return { name: file.name, exportedAt: file.exportedAt, profiles, settings, defaultProfile, keys: file.keys ? 'replaced' : 'kept' };
}

/**
 * Settings after importing `file`: file profiles replace local ones with the same id or
 * are appended; local-only profiles stay (renamed "Name (local)" when a file profile
 * takes their name); shared settings and the default profile come from the file; keys
 * change only when the file has them. Your name never changes.
 */
export function mergeConfig(current: Settings, file: ConfigFile): Settings {
  const inFile = new Map(file.profiles.map((p) => [p.id, p]));
  const fileNames = new Set(file.profiles.map((p) => fold(p.name)));
  const taken = new Set([...fileNames]);
  const profiles: Profile[] = [];
  for (const p of current.profiles) {
    const replacement = inFile.get(p.id);
    if (replacement) {
      profiles.push(replacement);
      inFile.delete(p.id);
      continue;
    }
    let name = p.name;
    if (fileNames.has(fold(name))) {
      name = `${p.name} (local)`;
      for (let n = 2; taken.has(fold(name)); n++) name = `${p.name} (local ${n})`;
    }
    taken.add(fold(name));
    profiles.push(name === p.name ? p : { ...p, name });
  }
  profiles.push(...inFile.values());
  return {
    ...current,
    ...file.settings,
    profiles,
    defaultProfileId: file.defaultProfileId,
    ...(file.keys ? { geminiApiKey: file.keys.geminiApiKey, notionToken: file.keys.notionToken } : {}),
  };
}
