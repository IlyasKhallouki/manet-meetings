import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '@lib/settingsSchema';
import { starterProfiles } from '@lib/profiles';

describe('normalizeSettings', () => {
  it('gives a fresh install Team and Personal, Team as default', () => {
    const s = normalizeSettings(undefined);
    expect(s.profiles.map((p) => [p.id, p.name, p.databaseId])).toEqual([
      ['team', 'Team', ''],
      ['personal', 'Personal', ''],
    ]);
    expect(s.defaultProfileId).toBe('team');
    expect(s.customVocabulary).toEqual([]);
  });

  it('turns the two databases and the default route of older settings into profiles', () => {
    const s = normalizeSettings({ notionTeamDbId: 'team-db', notionPersonalDbId: 'me-db', defaultRoute: 'personal' });
    expect(s.profiles.map((p) => [p.id, p.databaseId])).toEqual([
      ['team', 'team-db'],
      ['personal', 'me-db'],
    ]);
    expect(s.defaultProfileId).toBe('personal');
  });

  it('keeps profiles that are already there, and repairs a stale default id', () => {
    const profiles = [{ ...starterProfiles()[0]!, id: 'client', name: 'Client' }];
    expect(normalizeSettings({ profiles, defaultProfileId: 'client' }).profiles).toBe(profiles);
    expect(normalizeSettings({ profiles, defaultProfileId: 'gone' }).defaultProfileId).toBe('client');
  });

  it('is idempotent', () => {
    const once = normalizeSettings({ notionTeamDbId: 'team-db' });
    expect(normalizeSettings(once)).toEqual(once);
  });

  it('fills fields added since the settings were stored', () => {
    const { includeMic: _mic, ...older } = DEFAULT_SETTINGS;
    expect(normalizeSettings(older).includeMic).toBe(true);
  });

  it('never hands out DEFAULT_SETTINGS.profiles itself, even when storage returns it by reference', () => {
    const result = normalizeSettings(DEFAULT_SETTINGS);
    expect(result.profiles).not.toBe(DEFAULT_SETTINGS.profiles);
    result.profiles[0]!.sections[0]!.title = 'Changed';
    expect(DEFAULT_SETTINGS.profiles[0]!.sections[0]!.title).toBe('Summary');
  });

  it('gives Team and Personal when stored profiles is empty', () => {
    expect(normalizeSettings({ profiles: [] }).profiles.map((p) => [p.id, p.name])).toEqual([
      ['team', 'Team'],
      ['personal', 'Personal'],
    ]);
  });

  it('drops the Team | Personal fields once they are profiles', () => {
    const s = normalizeSettings({ notionTeamDbId: 'team-db', notionPersonalDbId: 'me-db', defaultRoute: 'personal' } as never);
    expect(s).not.toHaveProperty('notionTeamDbId');
    expect(s).not.toHaveProperty('notionPersonalDbId');
    expect(s).not.toHaveProperty('defaultRoute');
  });
});
