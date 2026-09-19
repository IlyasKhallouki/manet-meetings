import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@lib/settings';
import type { Settings } from '@lib/types';
import {
  languageCodeWarning,
  parseLanguageCodes,
  parseSettingsForm,
  parseVocabulary,
  settingsToForm,
  setupProblems,
  SUPPORTED_LANGUAGE_CODES,
  type SettingsFormValues,
} from '@lib/ui/settingsForm';

const FILLED: Settings = {
  geminiApiKey: 'AIzaSyExampleKey123',
  notionToken: 'ntn_exampletoken',
  notionTeamDbId: 'https://www.notion.so/lumind/Team-meetings-1a2b3c4d5e6f40718293a4b5c6d7e8f9?v=0123456789abcdef0123456789abcdef',
  notionPersonalDbId: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  defaultRoute: 'personal',
  autoTranscribe: false,
  retentionDays: 30,
  displayName: 'Ilya K',
  customVocabulary: ['Lumind', 'Manet', 'OPFS'],
  languageCodes: ['en-US', 'fr-FR'],
  includeMic: false,
};

function form(patch: Partial<SettingsFormValues> = {}): SettingsFormValues {
  return { ...settingsToForm(FILLED), ...patch };
}

describe('settingsToForm / parseSettingsForm', () => {
  it('round-trips every field', () => {
    for (const s of [DEFAULT_SETTINGS, FILLED]) {
      expect(parseSettingsForm(settingsToForm(s))).toEqual({ ok: true, settings: s });
    }
  });

  it('writes list fields the way the user edits them', () => {
    const v = settingsToForm(FILLED);
    expect(v.customVocabulary).toBe('Lumind\nManet\nOPFS');
    expect(v.languageCodes).toBe('en-US, fr-FR');
    expect(v.retentionDays).toBe('30');
  });

  it('trims keys, ids and the name', () => {
    const r = parseSettingsForm(
      form({
        geminiApiKey: '  AIzaKey \n',
        notionToken: ' ntn_x ',
        notionTeamDbId: ' 1a2b3c4d5e6f40718293a4b5c6d7e8f9 ',
        displayName: '  Marie   Curie ',
      }),
    );
    expect(r.ok && r.settings).toMatchObject({
      geminiApiKey: 'AIzaKey',
      notionToken: 'ntn_x',
      notionTeamDbId: '1a2b3c4d5e6f40718293a4b5c6d7e8f9',
      displayName: 'Marie Curie',
    });
  });

  it('accepts empty keys and ids (settings can be filled in gradually)', () => {
    const r = parseSettingsForm(
      form({ geminiApiKey: '', notionToken: '', notionTeamDbId: '', notionPersonalDbId: '', displayName: '' }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects keys with spaces inside', () => {
    const r = parseSettingsForm(form({ geminiApiKey: 'AIza abc', notionToken: 'ntn x' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['geminiApiKey', 'notionToken']);
  });

  it('rejects database fields that hold no Notion id', () => {
    const r = parseSettingsForm(form({ notionTeamDbId: 'Team meetings', notionPersonalDbId: 'https://example.com/x' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.notionTeamDbId).toMatch(/link or id/);
    expect(r.errors.notionPersonalDbId).toMatch(/link or id/);
  });

  it('validates retention days as a whole number from 0 to 365', () => {
    for (const bad of ['', '-1', '1.5', 'seven', '366']) {
      const r = parseSettingsForm(form({ retentionDays: bad }));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.retentionDays).toBeTruthy();
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

  it('rejects an unknown route', () => {
    const r = parseSettingsForm(form({ defaultRoute: 'shared' }));
    expect(!r.ok && r.errors.defaultRoute).toBeTruthy();
  });

  it('saves language codes Gemini does not list, with a warning', () => {
    const r = parseSettingsForm(form({ languageCodes: 'fr, cmn-hans-cn' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.languageCodes).toEqual(['fr', 'cmn-Hans-CN']);
    expect(r.warnings?.languageCodes).toContain('"fr" (try fr-FR)');
    expect(parseSettingsForm(form()).ok && parseSettingsForm(form())).not.toHaveProperty('warnings');
  });

  it('reports every problem at once', () => {
    const r = parseSettingsForm(form({ retentionDays: 'x', languageCodes: 'english', notionTeamDbId: 'nope' }));
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(['languageCodes', 'notionTeamDbId', 'retentionDays']);
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
    expect(!r.ok && r.errors.customVocabulary).toMatch(/1000/);
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
  it('suggests the listed code for the same language', () => {
    const w = languageCodeWarning(['fr', 'en', 'zh-Hans-CN', 'zz-ZZ'])!;
    expect(w).toMatch(/not in Gemini's list/i);
    expect(w).toContain('"fr" (try fr-FR)');
    expect(w).toContain('"en" (try en-GB, en-IN or en-US)');
    expect(w).toContain('"zh-Hans-CN" (try cmn-Hans-CN or yue-Hant-HK)');
    expect(w).toContain('"zz-ZZ"');
    expect(w).not.toContain('"zz-ZZ" (try');
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
    expect(setupProblems(FILLED, 'team')).toEqual({ blocking: [], geminiKeyMissing: false });
    expect(setupProblems({ ...FILLED, geminiApiKey: '' }, 'team')).toEqual({ blocking: [], geminiKeyMissing: true });
    expect(setupProblems(DEFAULT_SETTINGS, 'personal')).toEqual({
      blocking: ['Notion integration token', 'Notion personal database id', 'Your name'],
      geminiKeyMissing: true,
    });
  });
});
