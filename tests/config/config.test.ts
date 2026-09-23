import { describe, expect, it } from 'vitest';
import {
  buildConfigFile,
  configFileName,
  mergeConfig,
  parseConfigFile,
  previewConfig,
  serializeConfig,
  type ConfigFile,
} from '@lib/config';
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Profile, Settings } from '@lib/types';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function settings(overrides: Partial<Settings> = {}): Settings {
  return normalizeSettings({
    displayName: 'Ilyas',
    geminiApiKey: 'gem-key',
    notionToken: 'ntn_token',
    profiles: starterProfiles(DB, ''),
    customVocabulary: ['Manet'],
    ...overrides,
  });
}

const client: Profile = {
  id: 'client-1',
  name: 'Client meeting',
  databaseId: DB,
  prompt: 'Sales call.',
  sections: [{ id: 'n', title: 'Client needs', instruction: 'Their words.', format: 'bullets' }],
  vocabulary: ['Acme'],
};

describe('buildConfigFile', () => {
  it('holds profiles and shared settings, never your name', () => {
    const file = buildConfigFile(settings(), { name: 'Acme team', includeKeys: false, now: NOW });
    expect(file).toEqual({
      format: 'manet-config',
      version: 1,
      name: 'Acme team',
      exportedAt: '2026-09-23T12:00:00.000Z',
      defaultProfileId: 'team',
      profiles: settings().profiles,
      settings: { customVocabulary: ['Manet'], languageCodes: [], autoTranscribe: true, retentionDays: 7, includeMic: true },
    });
    expect(JSON.stringify(file)).not.toContain('Ilyas');
  });

  it('includes the keys only when asked', () => {
    const file = buildConfigFile(settings(), { name: 'x', includeKeys: true, now: NOW });
    expect(file.keys).toEqual({ geminiApiKey: 'gem-key', notionToken: 'ntn_token' });
  });

  it('names the file after the config', () => {
    expect(configFileName('Acme team / EMEA')).toBe('manet-config-acme-team-emea.json');
    expect(configFileName('  ')).toBe('manet-config.json');
  });

  it('returns copies, not live references into the source settings', () => {
    const s = settings();
    const file = buildConfigFile(s, { name: 'x', includeKeys: false, now: NOW });
    file.profiles[0]!.sections[0]!.title = 'Changed';
    file.settings.customVocabulary.push('New term');
    expect(s.profiles[0]!.sections[0]!.title).not.toBe('Changed');
    expect(s.customVocabulary).not.toContain('New term');
  });
});

describe('parseConfigFile', () => {
  const good = buildConfigFile(settings({ profiles: [...starterProfiles(DB, ''), client] }), {
    name: 'Acme',
    includeKeys: true,
    now: NOW,
  });
  const text = (file: unknown) => (typeof file === 'string' ? file : JSON.stringify(file));
  const error = (file: unknown) => {
    const r = parseConfigFile(text(file));
    return r.ok ? null : r.error;
  };

  it('reads what serializeConfig wrote', () => {
    const r = parseConfigFile(serializeConfig(good));
    expect(r).toEqual({ ok: true, file: good });
  });

  it('rejects what isn’t a Manet config', () => {
    const notConfig = 'This file isn’t a Manet Meetings config. Choose a file exported from Settings › Share.';
    expect(error('{nope')).toBe(notConfig);
    expect(error({ ...good, format: 'other' })).toBe(notConfig);
    expect(error([])).toBe(notConfig);
    expect(error('x'.repeat(1_000_001))).toBe('This file is too large to be a Manet Meetings config.');
  });

  it('measures size in UTF-8 bytes, not UTF-16 units', () => {
    const notTooLarge = 'é'.repeat(400_000); // 800,000 bytes, 400,000 UTF-16 units
    expect(error(notTooLarge)).toBe('This file isn’t a Manet Meetings config. Choose a file exported from Settings › Share.');
    const tooLarge = 'é'.repeat(500_001); // 1,000,002 bytes
    expect(error(tooLarge)).toBe('This file is too large to be a Manet Meetings config.');
  });

  it('asks for a newer version for a newer file', () => {
    expect(error({ ...good, version: 2 })).toBe('This file needs a newer version of Manet Meetings.');
  });

  it('names the first problem with a profile', () => {
    expect(error({ ...good, profiles: [] })).toBe('The file has no profiles.');
    expect(error({ ...good, profiles: [{ id: 'x' }] })).toBe('Profile 1 in the file is incomplete.');
    const dupId = [good.profiles[0], { ...good.profiles[1], id: good.profiles[0]!.id }];
    expect(error({ ...good, profiles: dupId })).toBe('Two profiles in the file share an id.');
    const badDb = [{ ...client, databaseId: 'Meetings' }];
    expect(error({ ...good, profiles: badDb, defaultProfileId: client.id })).toBe(
      '“Client meeting”: Paste the database link or ID from Notion.',
    );
  });

  it('needs the default profile to be one of the file’s', () => {
    expect(error({ ...good, defaultProfileId: 'gone' })).toBe('The file’s default profile isn’t one of its profiles.');
  });

  it('checks the shared settings and the keys', () => {
    expect(error({ ...good, settings: { ...good.settings, retentionDays: -1 } })).toBe(
      'The file’s Keep audio setting must be a number of days from 0 to 365.',
    );
    expect(error({ ...good, settings: { ...good.settings, languageCodes: ['english please'] } })).toBe(
      'The file’s Languages setting has codes that aren’t language codes.',
    );
    expect(error({ ...good, keys: { geminiApiKey: 'a b', notionToken: 'x' } })).toBe('The file’s API keys are damaged.');
  });
});

describe('mergeConfig', () => {
  const file: ConfigFile = buildConfigFile(
    settings({ profiles: [{ ...starterProfiles(DB, '')[0]!, prompt: 'Team-wide prompt.' }, client], defaultProfileId: 'client-1', retentionDays: 14 }),
    { name: 'Acme', includeKeys: false, now: NOW },
  );

  it('replaces profiles by id, appends new ones and keeps local-only ones', () => {
    const merged = mergeConfig(settings(), file);
    expect(merged.profiles.map((p) => p.id)).toEqual(['team', 'personal', 'client-1']);
    expect(merged.profiles[0]!.prompt).toBe('Team-wide prompt.');
    expect(merged.defaultProfileId).toBe('client-1');
    expect(merged.retentionDays).toBe(14);
  });

  it('keeps your name, and your keys when the file has none', () => {
    const merged = mergeConfig(settings(), file);
    expect(merged).toMatchObject({ displayName: 'Ilyas', geminiApiKey: 'gem-key', notionToken: 'ntn_token' });
  });

  it('takes the keys when the file has them', () => {
    const withKeys = { ...file, keys: { geminiApiKey: 'team-gem', notionToken: 'ntn_team' } };
    expect(mergeConfig(settings(), withKeys)).toMatchObject({ geminiApiKey: 'team-gem', notionToken: 'ntn_team' });
  });

  it('renames a local profile whose name a file profile takes', () => {
    const local = settings({ profiles: [...starterProfiles(DB, ''), { ...client, id: 'mine', name: 'client meeting' }] });
    const merged = mergeConfig(local, file);
    expect(merged.profiles.map((p) => p.name)).toEqual(['Team', 'Personal', 'client meeting (local)', 'Client meeting']);
  });

  it('never produces two profiles with the same name', () => {
    const a: Profile = { id: 'a', name: 'Sales', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const b: Profile = { id: 'b', name: 'Sales (local)', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const local = settings({ profiles: [a, b] });
    const x: Profile = { id: 'x', name: 'Sales', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const salesFile = buildConfigFile(settings({ profiles: [x] }), { name: 'Acme', includeKeys: false, now: NOW });
    const merged = mergeConfig(local, salesFile);
    expect(merged.profiles.map((p) => p.name)).toEqual(['Sales (local 2)', 'Sales (local)', 'Sales']);
  });

  it('gives distinct renames to two local-only profiles that each clash with a different file profile', () => {
    const a: Profile = { id: 'a', name: 'Alpha', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const b: Profile = { id: 'b', name: 'Beta', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const local = settings({ profiles: [a, b] });
    const x: Profile = { id: 'x', name: 'Alpha', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const y: Profile = { id: 'y', name: 'Beta', databaseId: '', prompt: '', sections: [], vocabulary: [] };
    const twoClash = buildConfigFile(settings({ profiles: [x, y] }), { name: 'Acme', includeKeys: false, now: NOW });
    const merged = mergeConfig(local, twoClash);
    expect(merged.profiles.map((p) => p.name)).toEqual(['Alpha (local)', 'Beta (local)', 'Alpha', 'Beta']);
  });
});

describe('previewConfig', () => {
  it('lists what an import would change', () => {
    const current = settings({ profiles: [...starterProfiles(DB, ''), { ...client, id: 'mine', name: 'Mine' }] });
    const file = buildConfigFile(
      settings({ profiles: [{ ...starterProfiles(DB, '')[0]!, prompt: 'New.' }, starterProfiles(DB, '')[1]!, client], retentionDays: 14 }),
      { name: 'Acme', includeKeys: false, now: NOW },
    );
    expect(previewConfig(current, file)).toEqual({
      name: 'Acme',
      exportedAt: '2026-09-23T12:00:00.000Z',
      profiles: [
        { id: 'team', name: 'Team', change: 'changed', fields: ['prompt'] },
        { id: 'personal', name: 'Personal', change: 'unchanged', fields: [] },
        { id: 'client-1', name: 'Client meeting', change: 'added', fields: [] },
        { id: 'mine', name: 'Mine', change: 'kept', fields: [] },
      ],
      settings: [{ label: 'Keep audio', from: '7 days', to: '14 days' }],
      defaultProfile: null,
      keys: 'kept',
    });
  });
});
