import { describe, expect, it } from 'vitest';
import { defaultProfile, starterProfiles } from '@lib/profiles';
import { DEFAULT_SETTINGS } from '@lib/settings';
import { normalizeSettings } from '@lib/settingsSchema';
import type { VerifyResult } from '@lib/notion/verify';
import type { Settings } from '@lib/types';
import {
  firstMissingField,
  formValue,
  languageCodeWarning,
  parseField,
  parseLanguageCodes,
  parseSettingsForm,
  parseVocabulary,
  profileCheckMessages,
  settingsToForm,
  setupChecklist,
  setupComplete,
  setupProblems,
  SUPPORTED_LANGUAGE_CODES,
  type SettingsFormValues,
} from '@lib/ui/settingsForm';

const FILLED: Settings = {
  geminiApiKey: 'AIzaSyExampleKey123',
  notionToken: 'ntn_exampletoken',
  autoTranscribe: false,
  retentionDays: 30,
  displayName: 'Ilya K',
  customVocabulary: ['Lumind', 'Manet', 'OPFS'],
  languageCodes: ['en-US', 'fr-FR'],
  includeMic: false,
  profiles: starterProfiles(
    'https://www.notion.so/lumind/Team-meetings-1a2b3c4d5e6f40718293a4b5c6d7e8f9?v=0123456789abcdef0123456789abcdef',
    '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  ),
  defaultProfileId: 'team',
};

function form(patch: Partial<SettingsFormValues> = {}): SettingsFormValues {
  return { ...settingsToForm(FILLED), ...patch };
}

describe('settingsToForm / parseSettingsForm', () => {
  it('round-trips every field', () => {
    // Profiles (and the legacy database fields they replaced) are edited in the profile
    // editor, not in these fields, so they don't round-trip here.
    for (const s of [DEFAULT_SETTINGS, FILLED]) {
      const { profiles: _profiles, defaultProfileId: _defaultProfileId, ...expected } = s;
      expect(parseSettingsForm(settingsToForm(s))).toEqual({ ok: true, settings: expected });
    }
  });

  it('has no database or default destination fields: profiles hold those', () => {
    const v = settingsToForm(FILLED) as unknown as Record<string, unknown>;
    for (const name of ['notionTeamDbId', 'notionPersonalDbId', 'defaultRoute']) expect(v, name).not.toHaveProperty(name);
  });

  it('writes list fields the way the user edits them', () => {
    const v = settingsToForm(FILLED);
    expect(v.customVocabulary).toBe('Lumind\nManet\nOPFS');
    expect(v.languageCodes).toBe('en-US, fr-FR');
    expect(v.retentionDays).toBe('30');
    expect(formValue(FILLED, 'languageCodes')).toBe('en-US, fr-FR');
    expect(formValue(FILLED, 'includeMic')).toBe(false);
  });

  it('trims keys and the name', () => {
    const r = parseSettingsForm(
      form({
        geminiApiKey: '  AIzaKey \n',
        notionToken: ' ntn_x ',
        displayName: '  Marie   Curie ',
      }),
    );
    expect(r.ok && r.settings).toMatchObject({
      geminiApiKey: 'AIzaKey',
      notionToken: 'ntn_x',
      displayName: 'Marie Curie',
    });
  });

  it('accepts empty keys (settings can be filled in gradually)', () => {
    const r = parseSettingsForm(form({ geminiApiKey: '', notionToken: '', displayName: '' }));
    expect(r.ok).toBe(true);
  });

  it('rejects keys with spaces inside, and says to paste them again', () => {
    const r = parseSettingsForm(form({ geminiApiKey: 'AIza abc', notionToken: 'ntn x' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['geminiApiKey', 'notionToken']);
    expect(r.errors.geminiApiKey).toBe('This has spaces in it. Paste the key again.');
    expect(r.errors.notionToken).toBe('This has spaces in it. Paste the token again.');
  });

  it('validates retention days as a whole number from 0 to 365', () => {
    for (const bad of ['', '-1', '1.5', 'seven', '366']) {
      const r = parseSettingsForm(form({ retentionDays: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.retentionDays).toBe('Enter a number of days from 0 to 365.');
    }
    for (const [good, n] of [
      ['0', 0],
      [' 14 ', 14],
      ['365', 365],
    ] as const) {
      const r = parseSettingsForm(form({ retentionDays: good }));
      expect(r.ok && r.settings.retentionDays).toBe(n);
    }
  });

  it('saves language codes Gemini does not list, with a warning', () => {
    const r = parseSettingsForm(form({ languageCodes: 'fr, cmn-hans-cn' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.languageCodes).toEqual(['fr', 'cmn-Hans-CN']);
    expect(r.warnings?.languageCodes).toBe('Gemini doesn’t list “fr” for transcription. Try fr-FR, or leave this empty.');
    expect(parseSettingsForm(form()).ok && parseSettingsForm(form())).not.toHaveProperty('warnings');
  });

  it('reports every problem at once', () => {
    const r = parseSettingsForm(form({ retentionDays: 'x', languageCodes: 'english', notionToken: 'ntn x' }));
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['languageCodes', 'notionToken', 'retentionDays']);
  });
});

describe('parseField (one field at a time, for instant apply)', () => {
  it('returns a one-field patch with the normalized value', () => {
    expect(parseField('displayName', '  Marie   Curie ')).toEqual({ ok: true, patch: { displayName: 'Marie Curie' } });
    expect(parseField('retentionDays', ' 14 ')).toEqual({ ok: true, patch: { retentionDays: 14 } });
    expect(parseField('customVocabulary', 'Lumind\n\nlumind\nOPFS')).toEqual({
      ok: true,
      patch: { customVocabulary: ['Lumind', 'OPFS'] },
    });
    expect(parseField('languageCodes', 'fr-fr, EN-us')).toEqual({ ok: true, patch: { languageCodes: ['fr-FR', 'en-US'] } });
    expect(parseField('includeMic', false)).toEqual({ ok: true, patch: { includeMic: false } });
    expect(parseField('notionToken', ' ntn_x ')).toEqual({ ok: true, patch: { notionToken: 'ntn_x' } });
  });

  it('refuses invalid values with the fix, and never returns a patch for them', () => {
    expect(parseField('retentionDays', 'a week')).toEqual({ ok: false, error: 'Enter a number of days from 0 to 365.' });
    expect(parseField('geminiApiKey', 'AIza abc')).toEqual({
      ok: false,
      error: 'This has spaces in it. Paste the key again.',
    });
    expect(parseField('languageCodes', 'english!!')).toEqual({
      ok: false,
      error: '“english!!” isn’t a language code.',
    });
    expect(parseField('languageCodes', 'english, fr-FR, x1')).toEqual({
      ok: false,
      error: '“english” and “x1” aren’t language codes.',
    });
  });

  it('counts terms with thousands separators when the vocabulary is too long', () => {
    const many = Array.from({ length: 1204 }, (_, i) => `term${i}`).join('\n');
    expect(parseField('customVocabulary', many)).toEqual({
      ok: false,
      error: 'Use at most 1,000 terms. This list has 1,204.',
    });
  });

  it('keeps advice that does not block saving next to the patch', () => {
    expect(parseField('languageCodes', 'fr-CA')).toEqual({
      ok: true,
      patch: { languageCodes: ['fr-CA'] },
      note: 'Gemini doesn’t list “fr-CA” for transcription. Try fr-FR, or leave this empty.',
    });
  });
});

describe('parseVocabulary', () => {
  it('takes one term per line, trims, drops blanks and case-insensitive repeats', () => {
    expect(parseVocabulary('Lumind\n  Manet  \n\r\n\nlumind\nGemini 3.5\r\nOPFS')).toEqual([
      'Lumind',
      'Manet',
      'Gemini 3.5',
      'OPFS',
    ]);
  });

  it('caps the list at the API limit through the form', () => {
    const many = Array.from({ length: 1001 }, (_, i) => `term${i}`).join('\n');
    const r = parseSettingsForm(form({ customVocabulary: many }));
    expect(!r.ok && r.errors.customVocabulary).toMatch(/1,000/);
    const exactly = Array.from({ length: 1000 }, (_, i) => `term${i}`).join('\n');
    expect(parseSettingsForm(form({ customVocabulary: exactly })).ok).toBe(true);
  });
});

describe('parseLanguageCodes', () => {
  it('splits on commas, semicolons and spaces and normalizes the casing of each subtag', () => {
    expect(parseLanguageCodes('fr-fr, EN-us;de-DE  pt-br,')).toMatchObject({
      codes: ['fr-FR', 'en-US', 'de-DE', 'pt-BR'],
      invalid: [],
    });
    expect(parseLanguageCodes('YUE-hant-hk, es-419, CEB').codes).toEqual(['yue-Hant-HK', 'es-419', 'ceb']);
  });

  it('keeps the documented codes as written instead of rewriting CLDR aliases', () => {
    // Intl.getCanonicalLocales rewrites cmn-Hans-CN (Gemini's Mandarin code) to zh-Hans-CN.
    const r = parseLanguageCodes('cmn-Hans-CN, fil-PH, nb-NO, kea-CV, pa-Guru-IN, sd-Arab-IN');
    expect(r.codes).toEqual(['cmn-Hans-CN', 'fil-PH', 'nb-NO', 'kea-CV', 'pa-Guru-IN', 'sd-Arab-IN']);
    expect(r.unsupported).toEqual([]);
  });

  it('dedupes after normalizing', () => {
    expect(parseLanguageCodes('fr-FR, fr-fr').codes).toEqual(['fr-FR']);
  });

  it('flags things that are not language codes', () => {
    expect(parseLanguageCodes('english, fr, x1').invalid).toEqual(['english', 'x1']);
  });

  it('keeps well-formed codes Gemini does not list, and names them', () => {
    const r = parseLanguageCodes('fr, en-US, fr-CA, zz-ZZ, zh-Hans-CN');
    expect(r.codes).toEqual(['fr', 'en-US', 'fr-CA', 'zz-ZZ', 'zh-Hans-CN']);
    expect(r.unsupported).toEqual(['fr', 'fr-CA', 'zz-ZZ', 'zh-Hans-CN']);
  });

  it('treats an empty field as automatic detection', () => {
    expect(parseLanguageCodes('  ')).toEqual({ codes: [], invalid: [], unsupported: [] });
  });
});

describe('languageCodeWarning', () => {
  it('names the unlisted code and the listed one for the same language', () => {
    expect(languageCodeWarning(['fr-CA'])).toBe(
      'Gemini doesn’t list “fr-CA” for transcription. Try fr-FR, or leave this empty.',
    );
    expect(languageCodeWarning(['en'])).toBe(
      'Gemini doesn’t list “en” for transcription. Try en-GB, en-IN or en-US, or leave this empty.',
    );
  });

  it('names several codes in one sentence and merges the suggestions', () => {
    expect(languageCodeWarning(['fr', 'en-US', 'zh-Hans-CN'])).toBe(
      'Gemini doesn’t list “fr” or “zh-Hans-CN” for transcription. Try fr-FR, cmn-Hans-CN or yue-Hant-HK, or leave this empty.',
    );
  });

  it('says the code may be rejected when nothing similar is listed', () => {
    expect(languageCodeWarning(['zz-ZZ'])).toBe(
      'Gemini doesn’t list “zz-ZZ” for transcription and may reject it. Leave this empty to detect languages automatically.',
    );
  });

  it('says nothing when every code is listed', () => {
    expect(languageCodeWarning(['en-US', 'fr-FR'])).toBeUndefined();
    expect(languageCodeWarning([])).toBeUndefined();
  });

  it('lists every documented code once', () => {
    expect(SUPPORTED_LANGUAGE_CODES.size).toBe(83);
    for (const code of ['cmn-Hans-CN', 'yue-Hant-HK', 'ceb', 'es-419', 'en-IN', 'fil-PH', 'rup-BG']) {
      expect(SUPPORTED_LANGUAGE_CODES.has(code), code).toBe(true);
    }
  });
});

describe('setupProblems', () => {
  it('blocks saving only on Notion and the name; a missing Gemini key means captions only', () => {
    expect(setupProblems(FILLED, defaultProfile(FILLED))).toEqual({ blocking: [], geminiKeyMissing: false });
    expect(setupProblems({ ...FILLED, geminiApiKey: '' }, defaultProfile(FILLED))).toEqual({
      blocking: [],
      geminiKeyMissing: true,
    });
    expect(setupProblems(DEFAULT_SETTINGS, DEFAULT_SETTINGS.profiles[1]!)).toEqual({
      blocking: ['your name', 'a Notion token', 'the Personal profile’s database'],
      geminiKeyMissing: true,
    });
  });
});

describe('setupChecklist', () => {
  const view = (s: Settings) => setupChecklist(s).map((i) => [i.key, i.label, i.done, i.optional]);

  it('lists name, token and the default profile’s database as required, and the Gemini key as optional', () => {
    expect(view(DEFAULT_SETTINGS)).toEqual([
      ['displayName', 'Your name', false, false],
      ['notionToken', 'Notion token', false, false],
      ['profiles', 'Database for Team', false, false],
      ['geminiApiKey', 'Gemini API key', false, true],
    ]);
    expect(setupComplete(setupChecklist(DEFAULT_SETTINGS))).toBe(false);
  });

  it('asks for the database of whichever profile is the default', () => {
    const s = { ...FILLED, profiles: starterProfiles('', ''), defaultProfileId: 'personal' };
    expect(view(s)).toContainEqual(['profiles', 'Database for Personal', false, false]);
    expect(setupComplete(setupChecklist(s))).toBe(false);
  });

  it('is complete once every required item is done, whatever the Gemini key', () => {
    const s = { ...FILLED, geminiApiKey: '' };
    expect(setupChecklist(s).every((i) => i.done || i.optional)).toBe(true);
    expect(setupComplete(setupChecklist(s))).toBe(true);
    expect(setupComplete(setupChecklist(FILLED))).toBe(true);
  });
});

describe('setupChecklist with profiles', () => {
  it('asks for the default profile’s database', () => {
    const s = normalizeSettings({ displayName: 'Ilyas', notionToken: 'ntn_x', profiles: starterProfiles('', 'db'), defaultProfileId: 'personal' });
    expect(setupChecklist(s)).toEqual([
      { key: 'displayName', label: 'Your name', done: true, optional: false },
      { key: 'notionToken', label: 'Notion token', done: true, optional: false },
      { key: 'profiles', label: 'Database for Personal', done: true, optional: false },
      { key: 'geminiApiKey', label: 'Gemini API key', done: false, optional: true },
    ]);
  });

  it('sends a missing profile database to the Profiles group', () => {
    expect(firstMissingField(['the Client meeting profile’s database'])).toBe('profiles');
    expect(firstMissingField(['Notion team database id'])).toBe('profiles');
  });
});

describe('profileCheckMessages', () => {
  it('reports a ready database by its Notion title, and an empty one as not set', () => {
    const r = profileCheckMessages(new Map([['team', { ok: true, title: 'Meetings' }], ['personal', null]]));
    expect(r.token).toBeUndefined();
    expect(r.profiles).toEqual(
      new Map([
        ['team', { tone: 'done', text: '“Meetings” is ready.' }],
        ['personal', { tone: 'neutral', text: 'No database yet. Add one to save meetings with this profile.' }],
      ]),
    );
  });

  it('reports a token problem once, under the token, instead of on each profile', () => {
    // verifyDatabase flags what the token is at fault for (notion/verify.ts tokenProblem).
    const rejected = {
      ok: false as const,
      problems: ['Notion rejected this token. Copy it again from Notion.'],
      tokenProblem: true as const,
    };
    expect(profileCheckMessages(new Map([['team', rejected], ['personal', rejected]]))).toEqual({
      token: { tone: 'caution', text: 'Notion rejected this token. Copy it again from Notion.' },
      profiles: new Map(),
    });
    // One database is enough to blame the token.
    expect(profileCheckMessages(new Map<string, VerifyResult | null>([['team', { ok: true, title: 'Meetings' }], ['personal', rejected]])).token).toEqual({
      tone: 'caution',
      text: 'Notion rejected this token. Copy it again from Notion.',
    });
  });

  it('puts each database problem on its own profile, as verifyDatabase words it', () => {
    const r = profileCheckMessages(
      new Map<string, VerifyResult | null>([
        ['team', { ok: false, problems: ['This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.'] }],
        ['client', { ok: false, problems: ['Add a Date property named “Date”.', 'Change “Route” to a Select property. It’s Text now.'] }],
      ]),
    );
    expect(r.token).toBeUndefined();
    expect(r.profiles.get('team')).toEqual({
      tone: 'caution',
      text: 'This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.',
    });
    expect(r.profiles.get('client')).toEqual({
      tone: 'caution',
      text: 'Add a Date property named “Date”. Change “Route” to a Select property. It’s Text now.',
    });
  });
});

describe('firstMissingField', () => {
  it('names the field "Open settings" should land on: the first missing one in page order', () => {
    // missingForSave's words, in its own order (token, database, name).
    expect(firstMissingField(['Notion integration token', 'Notion team database id', 'Your name'])).toBe('displayName');
    expect(firstMissingField(['Notion integration token', 'Notion team database id'])).toBe('notionToken');
    expect(firstMissingField(['Notion personal database id'])).toBe('profiles');
    expect(firstMissingField(['Notion team database id'])).toBe('profiles');
    expect(firstMissingField(['Gemini API key'])).toBe('geminiApiKey');
    expect(firstMissingField(['a Notion token', 'the Client profile’s database'])).toBe('notionToken');
    expect(firstMissingField(['the Client profile’s database'])).toBe('profiles');
    expect(firstMissingField([])).toBeUndefined();
    expect(firstMissingField(['Something new'])).toBeUndefined();
  });
});
