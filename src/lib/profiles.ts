/**
 * Profiles: kinds of meeting, each with its own notes layout, prompt and Notion
 * database. Pure (no chrome.*), so settings normalization, the pages and the offscreen
 * document can all use it.
 */
import { parseNotionId } from './notion/ids';
import { MAX_VOCABULARY } from './transcribe/requests';
import type { NoteSection, Profile, Settings } from './types';

export const PROFILE_LIMITS = {
  name: 60,
  sections: 12,
  sectionTitle: 60,
  instruction: 500,
  prompt: 2000,
} as const;

/** Always written after the sections, so no section may take its title. */
export const ACTION_ITEMS_TITLE = 'Action items';

const STARTER: NoteSection[] = [
  {
    id: 'summary',
    title: 'Summary',
    format: 'paragraph',
    instruction: 'Two to five sentences on what was discussed and concluded.',
  },
  {
    id: 'key-points',
    title: 'Key points',
    format: 'bullets',
    instruction: 'The main topics and facts, one short sentence each.',
  },
  { id: 'decisions', title: 'Decisions', format: 'bullets', instruction: 'Only explicit agreements or decisions.' },
];

/** The notes layout from before profiles: what Team and Personal start with. */
export const STARTER_SECTIONS: readonly NoteSection[] = STARTER;

export function starterSections(): NoteSection[] {
  return STARTER.map((s) => ({ ...s }));
}

/** Team and Personal, with the ids the old Team | Personal destinations used. */
export function starterProfiles(teamDatabaseId = '', personalDatabaseId = ''): Profile[] {
  const profile = (id: string, name: string, databaseId: string): Profile => ({
    id,
    name,
    databaseId,
    prompt: '',
    sections: starterSections(),
    vocabulary: [],
  });
  return [profile('team', 'Team', teamDatabaseId), profile('personal', 'Personal', personalDatabaseId)];
}

const fold = (s: string) => s.trim().toLocaleLowerCase();

/** `base`, else "base 2", "base 3"…: the first name no entry of `taken` uses, ignoring case. */
export function uniqueName(base: string, taken: readonly string[]): string {
  const used = new Set(taken.map(fold));
  if (!used.has(fold(base))) return base;
  for (let n = 2; ; n++) if (!used.has(fold(`${base} ${n}`))) return `${base} ${n}`;
}

export function newProfile(existing: readonly Profile[], id: string = crypto.randomUUID()): Profile {
  return {
    id,
    name: uniqueName('New profile', existing.map((p) => p.name)),
    databaseId: '',
    prompt: '',
    sections: starterSections(),
    vocabulary: [],
  };
}

export function newSection(existing: readonly NoteSection[], id: string = crypto.randomUUID()): NoteSection {
  return { id, title: uniqueName('New section', existing.map((s) => s.title)), instruction: '', format: 'bullets' };
}

export function profileById(settings: Pick<Settings, 'profiles'>, id: string | undefined): Profile | null {
  if (id === undefined) return null;
  return settings.profiles.find((p) => p.id === id) ?? null;
}

/** The default profile, or the first one when the default id is stale. */
export function defaultProfile(settings: Pick<Settings, 'profiles' | 'defaultProfileId'>): Profile {
  return profileById(settings, settings.defaultProfileId) ?? settings.profiles[0]!;
}

/**
 * The profile a meeting uses: its own, or the default when it has none. Null when its
 * profile was deleted since.
 */
export function profileForSession(
  settings: Pick<Settings, 'profiles' | 'defaultProfileId'>,
  profileId: string | undefined,
): Profile | null {
  return profileId === undefined ? defaultProfile(settings) : profileById(settings, profileId);
}

/** What is wrong with `profile` among `all` (which may include it), in the editor's words; [] when valid. */
export function profileProblems(profile: Profile, all: readonly Profile[]): string[] {
  const problems: string[] = [];
  const add = (problem: string) => {
    if (!problems.includes(problem)) problems.push(problem);
  };
  const name = profile.name.trim();
  if (!name) add('Give the profile a name.');
  else if (name.length > PROFILE_LIMITS.name) add(`Use at most ${PROFILE_LIMITS.name} characters for the name.`);
  else if (all.some((p) => p.id !== profile.id && fold(p.name) === fold(name))) {
    add(`Another profile is already called “${name}”.`);
  }
  const database = profile.databaseId.trim();
  if (database && !parseNotionId(database)) add('Paste the database link or ID from Notion.');
  if (profile.prompt.length > PROFILE_LIMITS.prompt) {
    add(`Keep the prompt to ${PROFILE_LIMITS.prompt.toLocaleString('en-US')} characters or fewer.`);
  }
  if (profile.sections.length > PROFILE_LIMITS.sections) add(`Use at most ${PROFILE_LIMITS.sections} sections.`);
  const seen = new Set<string>();
  for (const section of profile.sections) {
    const title = section.title.trim();
    if (!title) add('Give every section a title.');
    else if (title.length > PROFILE_LIMITS.sectionTitle) {
      add(`Use at most ${PROFILE_LIMITS.sectionTitle} characters for a section title.`);
    } else if (fold(title) === fold(ACTION_ITEMS_TITLE)) {
      add(`“${ACTION_ITEMS_TITLE}” is always added at the end. Give the section another title.`);
    } else if (seen.has(fold(title))) add(`Two sections are called “${title}”.`);
    seen.add(fold(title));
    if (section.instruction.length > PROFILE_LIMITS.instruction) {
      add(`Keep each section’s instruction to ${PROFILE_LIMITS.instruction} characters or fewer.`);
    }
  }
  if (profile.vocabulary.length > MAX_VOCABULARY) {
    add(`Use at most ${MAX_VOCABULARY.toLocaleString('en-US')} vocabulary terms.`);
  }
  return problems;
}
