import { describe, expect, it } from 'vitest';
import {
  defaultProfile,
  newProfile,
  newSection,
  profileById,
  profileForSession,
  profileProblems,
  STARTER_SECTIONS,
  starterProfiles,
  uniqueName,
} from '@lib/profiles';
import type { Profile } from '@lib/types';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';

function profile(overrides: Partial<Profile> = {}): Profile {
  return { id: 'p1', name: 'Client meeting', databaseId: DB, prompt: '', sections: [], vocabulary: [], ...overrides };
}

describe('starterProfiles', () => {
  it('builds Team and Personal with the ids old routes used and today’s sections', () => {
    const [team, personal] = starterProfiles('team-db', 'personal-db');
    expect(team).toMatchObject({ id: 'team', name: 'Team', databaseId: 'team-db', prompt: '', vocabulary: [] });
    expect(personal).toMatchObject({ id: 'personal', name: 'Personal', databaseId: 'personal-db' });
    expect(team!.sections.map((s) => [s.title, s.format])).toEqual([
      ['Summary', 'paragraph'],
      ['Key points', 'bullets'],
      ['Decisions', 'bullets'],
    ]);
  });

  it('gives each profile its own copy of the sections', () => {
    const [team, personal] = starterProfiles();
    team!.sections[0]!.title = 'Changed';
    expect(personal!.sections[0]!.title).toBe('Summary');
    expect(STARTER_SECTIONS[0]!.title).toBe('Summary');
  });
});

describe('uniqueName, newProfile and newSection', () => {
  it('numbers a name until it is free, ignoring case', () => {
    expect(uniqueName('New profile', [])).toBe('New profile');
    expect(uniqueName('New profile', ['new profile', 'New profile 2'])).toBe('New profile 3');
  });

  it('starts a profile with the starter sections and no database', () => {
    const p = newProfile(starterProfiles(), 'id-1');
    expect(p).toMatchObject({ id: 'id-1', name: 'New profile', databaseId: '', prompt: '', vocabulary: [] });
    expect(p.sections).toHaveLength(3);
  });

  it('starts a section as bullets with a free title', () => {
    expect(newSection([{ id: 'a', title: 'New section', instruction: '', format: 'paragraph' }], 's')).toEqual({
      id: 's',
      title: 'New section 2',
      instruction: '',
      format: 'bullets',
    });
  });
});

describe('lookups', () => {
  const settings = { profiles: starterProfiles(), defaultProfileId: 'personal' };

  it('finds a profile by id, or null', () => {
    expect(profileById(settings, 'team')?.name).toBe('Team');
    expect(profileById(settings, 'gone')).toBeNull();
    expect(profileById(settings, undefined)).toBeNull();
  });

  it('falls back to the first profile when the default id is stale', () => {
    expect(defaultProfile(settings).id).toBe('personal');
    expect(defaultProfile({ ...settings, defaultProfileId: 'gone' }).id).toBe('team');
  });

  it('gives a meeting its own profile, the default when it has none, and null when it was deleted', () => {
    expect(profileForSession(settings, 'team')?.id).toBe('team');
    expect(profileForSession(settings, undefined)?.id).toBe('personal');
    expect(profileForSession(settings, 'gone')).toBeNull();
  });
});

describe('profileProblems', () => {
  it('accepts a valid profile', () => {
    expect(profileProblems(profile({ sections: [...STARTER_SECTIONS] }), [])).toEqual([]);
  });

  it('needs a name, unique ignoring case, of at most 60 characters', () => {
    expect(profileProblems(profile({ name: '  ' }), [])).toEqual(['Give the profile a name.']);
    expect(profileProblems(profile({ name: 'x'.repeat(61) }), [])).toEqual(['Use at most 60 characters for the name.']);
    expect(profileProblems(profile(), [profile({ id: 'p2', name: 'client MEETING' })])).toEqual([
      'Another profile is already called “Client meeting”.',
    ]);
  });

  it('checks the database link, prompt length and section count', () => {
    expect(profileProblems(profile({ databaseId: 'Meetings' }), [])).toEqual(['Paste the database link or ID from Notion.']);
    expect(profileProblems(profile({ databaseId: '' }), [])).toEqual([]);
    expect(profileProblems(profile({ prompt: 'x'.repeat(2001) }), [])).toEqual([
      'Keep the prompt to 2,000 characters or fewer.',
    ]);
    const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, title: `S${i}`, instruction: '', format: 'bullets' as const }));
    expect(profileProblems(profile({ sections: thirteen }), [])).toEqual(['Use at most 12 sections.']);
  });

  it('checks section titles and instructions', () => {
    const s = (title: string, instruction = '') => ({ id: title, title, instruction, format: 'bullets' as const });
    expect(profileProblems(profile({ sections: [s('')] }), [])).toEqual(['Give every section a title.']);
    expect(profileProblems(profile({ sections: [s('action ITEMS')] }), [])).toEqual([
      '“Action items” is always added at the end. Give the section another title.',
    ]);
    expect(profileProblems(profile({ sections: [s('Risks'), s('risks')] }), [])).toEqual(['Two sections are called “risks”.']);
    expect(profileProblems(profile({ sections: [s('Risks', 'x'.repeat(501))] }), [])).toEqual([
      'Keep each section’s instruction to 500 characters or fewer.',
    ]);
  });
});
