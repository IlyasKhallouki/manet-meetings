# Profiles, Shared Config and Docs Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Team | Personal with profiles (sections, prompt and Notion database per kind of meeting, chosen before recording), add a shareable config file, and rid the docs of company details and "untested" caveats.

**Architecture:** A `Profile` lives in `Settings.profiles`; `normalizeSettings` migrates old Team/Personal settings into profiles with ids `team` and `personal`, so an old meeting's `route` names its profile. The summary request and the Notion page body are built from the profile's sections. Sessions store a `profileId` chosen in the popup; the routing window and the `awaiting-route` status go away. A pure `config.ts` builds, parses, previews and merges `manet-config` files; Settings shows it under Share.

**Tech Stack:** TypeScript (strict), WXT 0.21 Chrome MV3 extension, Vitest 5 (node project with WXT's fake browser, browser project in headless Chrome), Gemini Interactions API, Notion API 2026-03-11.

**Spec:** `docs/superpowers/specs/2026-09-23-profiles-and-shared-config-design.md`

---

## Ground rules for every task

- Commands run from the repo root. `pnpm typecheck` covers `src`, `entrypoints`, `tests` and `scripts` (tsconfig includes them), so a type change shows every file it breaks, tests included.
- `pnpm test:node` runs ~750 node tests in about a minute. `pnpm test:browser` needs Chrome (Playwright `channel: 'chrome'`) and runs files one at a time. Run a single file with `pnpm vitest run --project node tests/path/file.test.ts` or `--project browser`.
- Baseline before this plan: typecheck clean, `test:node` 733 passed / 22 skipped (the skips are integration tests without keys).
- Match the surrounding code: JSDoc on exported functions, typographic apostrophes (’) and quotes (“ ”) in user-facing strings, no default exports, `h()` from `src/lib/ui/dom.ts` for DOM.
- Commit messages follow the repo: `type: summary` in lower case, a short body, **no attribution lines and no assistant name**.
- Each task ends green: `pnpm typecheck` and `pnpm test:node` pass; tasks that touch `src/lib/ui` or `entrypoints` also run the affected browser test files.

## File map

Created:
- `src/lib/profiles.ts`: profile helpers (starter profiles, lookup, validation, new ids).
- `src/lib/config.ts`: config file build, parse, preview and merge.
- `src/lib/ui/profileEditorView.ts`: the profile editor drill-in on Settings.
- `src/lib/ui/shareView.ts`: Settings › Share (export, import preview).
- Tests: `tests/profiles/profiles.test.ts`, `tests/settings/normalizeSettings.test.ts`, `tests/config/config.test.ts`, `tests/storage/resultStore.test.ts` (extend if present), `tests/ui/profileEditorView.browser.test.ts`, `tests/ui/shareView.browser.test.ts`.

Deleted (Task 10): `entrypoints/routing/`, `src/lib/ui/routingView.ts`, `src/lib/ui/css/routing.css`, `tests/ui/routingView.test.ts`, `tests/ui/routingView.browser.test.ts`, `tests/ui/routingLayout.browser.test.ts`, `tests/background/routeHold.test.ts`, `tests/visual/routing.shots.ts`.

Modified: `src/lib/types.ts`, `src/lib/settingsSchema.ts`, `src/lib/settings.ts`, `src/lib/transcribe/summary.ts`, `src/lib/notion/{blocks,schema,properties,store}.ts`, `src/lib/storage/{resultStore,sessionStore}.ts`, `src/lib/pipeline/{process,save,session}.ts`, `src/lib/messages.ts`, `entrypoints/background/{sessionManager,copy,chromeDeps,index}.ts`, `entrypoints/offscreen/main.ts`, `src/lib/ui/{menu,sessionView,dashboardView,popupView,settingsForm,optionsView,extension}.ts`, `entrypoints/{dashboard,popup,options}/main.ts`, CSS under `src/lib/ui/css/`, `scripts/notion-setup.ts`, `README.md`, `src/lib/meet/captionAdapter.ts`, `tests/fixtures/captions/README.md`, and the tests named in each task.

---

### Task 1: Docs cleanup

**Files:**
- Modify: `README.md`, `src/lib/meet/captionAdapter.ts:1-19`, `tests/fixtures/captions/README.md`, `src/lib/settingsSchema.ts:16`, `src/lib/transcribe/summary.ts:17`
- Test: existing suites

- [ ] **Step 1: README intro.** In `README.md`, replace the sentence `Built for the Lumind team (4 people, meetings in mixed English/French).` with `It handles meetings that mix languages, even within one sentence.` The paragraph becomes:

```markdown
A Chrome extension that records Google Meet calls, transcribes them with Gemini and files
them into Notion: one page per meeting with a summary, action items and a speaker-labelled
transcript. It handles meetings that mix languages, even within one sentence. There is no
backend. Each person runs the extension with their own keys.
```

- [ ] **Step 2: README breakage points.** Replace point 1 with:

```markdown
1. Meet's caption DOM. Every selector and Meet UI string lives in
   `src/lib/meet/captionAdapter.ts`, and `tests/fixtures/captions/` holds saved caption
   DOM. Breakage shows up as transcripts with `Source = audio-only` or "Unknown speaker".
   The Meet tab's console logs `adapterHealth` once per call, showing which hooks matched.
   When Meet changes, run the capture snippet in `tests/fixtures/captions/README.md`
   during a call and refresh the fixtures.
```

In point 5, delete the two sentences `On speakers without headphones, remote voices can reach your mic. Chrome's echo cancellation of the played-back tab audio has not been verified, so use headphones.` In point 6, delete the sentence starting `The integration tests have not run against a real key` through `` `store: false`. ``

- [ ] **Step 3: captionAdapter header.** In `src/lib/meet/captionAdapter.ts`, replace the comment lines from ` * Reconstructed (Sept 2026)` through ` * the reconstructed call-ended fixture; the French ones are inferred.` with:

```ts
 * The hooks follow the caption DOM described in tests/fixtures/captions/README.md,
 * which also credits the open-source Meet scrapers they were first drawn from.
```

- [ ] **Step 4: fixtures README.** In `tests/fixtures/captions/README.md`:
  - Replace the first paragraph (the bold "These fixtures were reconstructed…" through "…update that file and these fixtures.") with:

```markdown
Saved Google Meet caption DOM for the caption tests. Everything the extension reads from
Meet goes through `src/lib/meet/captionAdapter.ts`; when Meet changes, update that file
and refresh these fixtures with the [capture snippet](#capturing-real-fixtures).
```

  - In the "UI hooks and strings" table, delete the `Confidence` column (header, separator and last cell of every row).
  - In the "Sources" section and anywhere else, delete sentences that call the fixtures reconstructed, inferred, unverified or due for replacement. Keep the credits to the projects and commits.
  - Rename the heading `## Capturing real fixtures` to `## Capturing fixtures` and update the anchor in the new first paragraph to `#capturing-fixtures`.

- [ ] **Step 5: defaults and prompt.** In `src/lib/settingsSchema.ts` set `customVocabulary: [],`. In `src/lib/transcribe/summary.ts` change the first line of `SYSTEM_INSTRUCTION` to:

```ts
const SYSTEM_INSTRUCTION = `You write meeting notes. Meetings may mix languages, sometimes within one sentence.
```

- [ ] **Step 6: Check nothing else names the company or an untested state**

Run: `grep -rniE "lumind|4 people|not been verified|have not run against|reconstructed|inferred" README.md src entrypoints tests/fixtures/captions/README.md`
Expected: no output. (Tests keep "Lumind" as sample vocabulary; that's intended.)

- [ ] **Step 7: Run tests**

Run: `pnpm typecheck && pnpm test:node`
Expected: PASS. If a test asserted the old default vocabulary or the old prompt sentence, update its expectation to the new value.

- [ ] **Step 8: Commit**

```bash
git add README.md src/lib/meet/captionAdapter.ts tests/fixtures/captions/README.md src/lib/settingsSchema.ts src/lib/transcribe/summary.ts tests
git commit -m "docs: drop company details and untested caveats" -m "The caption fixtures, echo cancellation and the Gemini request shapes have all been checked on real calls, so the caveats go. The default vocabulary starts empty and the summary prompt no longer names a team."
```

---

### Task 2: Profile model and settings normalization

**Files:**
- Modify: `src/lib/types.ts` (Settings, new Profile types), `src/lib/settingsSchema.ts`, `src/lib/settings.ts`
- Create: `src/lib/profiles.ts`
- Test: `tests/profiles/profiles.test.ts`, `tests/settings/normalizeSettings.test.ts`, plus every `Settings` literal the compiler flags

This task is additive: `notionTeamDbId`, `notionPersonalDbId` and `defaultRoute` stay until Task 14.

- [ ] **Step 1: Add the types.** In `src/lib/types.ts`, add a Profiles section right before the `// Settings` section:

```ts
// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

export type SectionFormat = 'paragraph' | 'bullets';

/** One heading of a profile's notes, which the summary model fills. */
export interface NoteSection {
  /** Stable within its profile (editor rows, import previews). */
  id: string;
  title: string;
  /** What the model writes under the heading. */
  instruction: string;
  format: SectionFormat;
}

/** A kind of meeting: how its notes are written and which Notion database it goes to. */
export interface Profile {
  /** 'team' and 'personal' for the profiles migrated from Team | Personal, else a UUID. */
  id: string;
  name: string;
  /** Notion database link or id, as pasted. */
  databaseId: string;
  /** Context for every summary of this profile ("Sales call with a prospect"). May be empty. */
  prompt: string;
  sections: NoteSection[];
  /** Added to Settings.customVocabulary for this profile's meetings. */
  vocabulary: string[];
}
```

and add to `interface Settings` (after `includeMic`):

```ts
  /** Kinds of meeting; always at least one. */
  profiles: Profile[];
  /** Preselected in the popup and used by the keyboard shortcut. */
  defaultProfileId: string;
```

- [ ] **Step 2: Write the failing profile tests.** Create `tests/profiles/profiles.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run --project node tests/profiles/profiles.test.ts`
Expected: FAIL, cannot resolve `@lib/profiles`.

- [ ] **Step 4: Write `src/lib/profiles.ts`**

```ts
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
```

- [ ] **Step 5: Run the profile tests**

Run: `pnpm vitest run --project node tests/profiles/profiles.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing normalization tests.** Create `tests/settings/normalizeSettings.test.ts`:

```ts
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
});
```

- [ ] **Step 7: Run to see it fail**

Run: `pnpm vitest run --project node tests/settings/normalizeSettings.test.ts`
Expected: FAIL, `normalizeSettings` is not exported.

- [ ] **Step 8: Implement in `src/lib/settingsSchema.ts`.** Add the import and the profiles to the defaults, then add `normalizeSettings` after `DEFAULT_SETTINGS`:

```ts
import { starterProfiles } from './profiles';
import type { Route, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  geminiApiKey: '',
  notionToken: '',
  notionTeamDbId: '',
  notionPersonalDbId: '',
  defaultRoute: 'team',
  autoTranscribe: true,
  retentionDays: 7,
  displayName: '',
  customVocabulary: [],
  languageCodes: [],
  includeMic: true,
  profiles: starterProfiles(),
  defaultProfileId: 'team',
};

/** Fields settings stored before profiles may carry. */
interface LegacySettings {
  notionTeamDbId?: string;
  notionPersonalDbId?: string;
  defaultRoute?: string;
}

/**
 * Stored settings made current. Missing fields take their defaults. Settings from before
 * profiles get Team and Personal built from their two databases, with the ids 'team' and
 * 'personal', so a meeting's old destination names its profile; the old default route
 * becomes the default profile. A default id that names no profile falls back to the first.
 */
export function normalizeSettings(stored: (Partial<Settings> & LegacySettings) | null | undefined): Settings {
  const s = stored ?? {};
  const merged: Settings = { ...DEFAULT_SETTINGS, ...s };
  const profiles =
    Array.isArray(s.profiles) && s.profiles.length > 0
      ? s.profiles
      : starterProfiles(s.notionTeamDbId ?? '', s.notionPersonalDbId ?? '');
  const ids = new Set(profiles.map((p) => p.id));
  const defaultProfileId =
    [s.defaultProfileId, s.defaultRoute].find((id): id is string => id !== undefined && ids.has(id)) ?? profiles[0]!.id;
  return { ...merged, profiles, defaultProfileId };
}
```

In `src/lib/settings.ts`, import `normalizeSettings` from `./settingsSchema`, re-export it, and change `getSettings`:

```ts
export { DEFAULT_SETTINGS, databaseIdFor, missingForSave, missingSettings, normalizeSettings } from './settingsSchema';

export async function getSettings(): Promise<Settings> {
  // Settings saved by an older version pick up new fields, and profiles.
  return normalizeSettings(await settingsItem.getValue());
}
```

- [ ] **Step 9: Run the new tests, then fix every `Settings` literal**

Run: `pnpm vitest run --project node tests/settings tests/profiles`
Expected: PASS.

Run: `pnpm typecheck`
Expected: errors only where tests or shots build a `Settings` object literal (for example `tests/helpers/meeting.ts` `testSettings`, `tests/ui/optionsView.browser.test.ts`, `tests/ui/settingsForm.test.ts`, `tests/visual/scenarios.ts`, `tests/visual/settings.shots.ts`). Add these two fields to each literal, with `import { starterProfiles } from '@lib/profiles';`:

```ts
    profiles: starterProfiles(),
    defaultProfileId: 'team',
```

When the literal sets `notionTeamDbId` or `notionPersonalDbId`, pass them: `profiles: starterProfiles(teamDb, personalDb)`.

- [ ] **Step 10: Run everything**

Run: `pnpm typecheck && pnpm test:node`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/types.ts src/lib/profiles.ts src/lib/settingsSchema.ts src/lib/settings.ts tests
git commit -m "feat: add profiles to settings" -m "A profile names a kind of meeting: its notes sections, prompt, extra vocabulary and Notion database. Settings from before profiles get Team and Personal profiles built from their two databases, with ids matching the old destinations."
```

---

### Task 3: Notes follow a profile's sections

**Files:**
- Modify: `src/lib/types.ts` (MeetingSummary, SummarySection, SummarizeOptions), `src/lib/transcribe/summary.ts`, `src/lib/notion/blocks.ts:98-128`, `src/lib/storage/resultStore.ts`, `src/lib/pipeline/process.ts:108-118`
- Test: `tests/transcribe/summary.test.ts`, `tests/notion/blocks.test.ts`, `tests/storage/resultStore.test.ts`, every test that fakes a summary (`grep -rln "keyPoints" tests`)

- [ ] **Step 1: Change the types.** In `src/lib/types.ts` replace `MeetingSummary` and `SummarizeOptions` with:

```ts
/** One section of the notes, as written for a meeting. */
export interface SummarySection {
  title: string;
  format: SectionFormat;
  /** Paragraph sections: the text, paragraphs separated by blank lines. '' for bullets. */
  text: string;
  /** Bullet sections: one entry per bullet. [] for paragraphs. */
  items: string[];
}

export interface MeetingSummary {
  /** Short meeting title (≤ 80 chars), in the meeting's main language. */
  title: string;
  /** The profile's sections, in its order, as written for this meeting. */
  sections: SummarySection[];
  actionItems: ActionItem[];
  /** Main language of the meeting as BCP-47 (e.g. "fr-FR"), best effort. */
  language?: string;
}
```

```ts
export interface SummarizeOptions {
  /** Speaker names that appear in the transcript. */
  attendees: string[];
  meetingDate: string;
  /** Whose prompt and sections the notes follow. */
  profile: Pick<Profile, 'prompt' | 'sections'>;
  signal?: AbortSignal;
}
```

- [ ] **Step 2: Rewrite the summary tests.** In `tests/transcribe/summary.test.ts`, keep the existing request-shape tests (model, `store: false`, `response_format`, date/attendees/transcript in the input, owner `enum`), and change the fixtures and field expectations to the new shape. Add these cases:

```ts
import { STARTER_SECTIONS } from '@lib/profiles';
import type { NoteSection } from '@lib/types';

const CLIENT: NoteSection[] = [
  { id: 'a', title: 'Client needs', format: 'bullets', instruction: 'What they asked for, in their words.' },
  { id: 'b', title: 'Pricing', format: 'paragraph', instruction: 'Any numbers discussed.' },
];
const PROFILE = { prompt: 'Sales call with a prospect. Be concise.', sections: CLIENT };

const valid = {
  title: 'Roadmap Manet et déploiement',
  language: 'fr-FR',
  sections: { s1: ['Un export PDF'], s2: 'Environ 40 000 € par an.' },
  actionItems: [
    { task: 'Envoyer le modèle Notion', owner: 'Ilya K.', due: 'vendredi' },
    { task: 'Déployer la version 1.2', owner: 'Paul Martin' },
  ],
};

describe('summaryRequest with a profile', () => {
  const req = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE });
  const schema = req.response_format?.schema as {
    properties: Record<string, { properties?: Record<string, { type: string; description?: string }>; required?: string[] }>;
    required: string[];
  };

  it('lists the fields in order, sections keyed s1…sN by format', () => {
    expect(Object.keys(schema.properties)).toEqual(['language', 'title', 'sections', 'actionItems']);
    expect(schema.required).toEqual(['language', 'title', 'sections', 'actionItems']);
    const sections = schema.properties.sections!;
    expect(sections.required).toEqual(['s1', 's2']);
    expect(sections.properties?.s1).toMatchObject({ type: 'array', description: 'What they asked for, in their words.' });
    expect(sections.properties?.s2).toMatchObject({ type: 'string', description: 'Any numbers discussed.' });
  });

  it('puts the prompt and each section’s instruction in the system instruction', () => {
    const system = String(req.system_instruction);
    expect(system).toContain('About these meetings:\nSales call with a prospect. Be concise.');
    expect(system).toContain('- s1 “Client needs” (bullets): What they asked for, in their words.');
    expect(system).toContain('- s2 “Pricing” (paragraph): Any numbers discussed.');
    expect(system).not.toMatch(/small team/i);
  });

  it('leaves the sections out entirely for a profile without any', () => {
    const bare = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: { prompt: '', sections: [] } });
    const props = (bare.response_format?.schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['language', 'title', 'actionItems']);
    expect(String(bare.system_instruction)).not.toContain('About these meetings');
  });
});

describe('parseMeetingSummary with a profile', () => {
  const parse = (raw: unknown, sections: readonly NoteSection[] = CLIENT) =>
    parseMeetingSummary(JSON.stringify(raw), { attendees: ATTENDEES, sections });

  it('maps s1…sN back onto the sections by position', () => {
    expect(parse(valid).sections).toEqual([
      { title: 'Client needs', format: 'bullets', text: '', items: ['Un export PDF'] },
      { title: 'Pricing', format: 'paragraph', text: 'Environ 40 000 € par an.', items: [] },
    ]);
  });

  it('reads a missing section as empty and tolerates a string for bullets or a list for a paragraph', () => {
    const out = parse({ ...valid, sections: { s1: 'Un export PDF', s2: ['Un.', 'Deux.'] } });
    expect(out.sections[0]!.items).toEqual(['Un export PDF']);
    expect(out.sections[1]!.text).toBe('Un.\n\nDeux.');
    expect(parse({ ...valid, sections: {} }).sections.map((s) => [s.text, s.items])).toEqual([
      ['', []],
      ['', []],
    ]);
  });

  it('has no sections for a profile without any, whatever the model sent', () => {
    expect(parse({ ...valid, sections: undefined }, []).sections).toEqual([]);
  });

  it('rejects sections that are not an object', () => {
    expect(() => parse({ ...valid, sections: ['x'] })).toThrow(/sections is not an object/);
  });

  it('writes the starter layout for Team and Personal', () => {
    const out = parse(
      { ...valid, sections: { s1: 'Revue de la roadmap.', s2: ['Roadmap revue'], s3: ['Version 1.2 validée'] } },
      STARTER_SECTIONS,
    );
    expect(out.sections.map((s) => s.title)).toEqual(['Summary', 'Key points', 'Decisions']);
  });
});
```

Update the existing owner-matching and title-capping tests to pass `sections: CLIENT` in the options and use `valid` above.

- [ ] **Step 3: Run to see them fail**

Run: `pnpm vitest run --project node tests/transcribe/summary.test.ts`
Expected: FAIL (types and schema differ).

- [ ] **Step 4: Rewrite the request and parser in `src/lib/transcribe/summary.ts`.** Replace everything from `export const SUMMARY_SCHEMA_FIELDS` through the end of `summaryRequest`, and change `parseMeetingSummary` and `summarize`, as follows. Keep `fail`, `text`, `optionalText`, `textList`, `fold`, `matchOwner`, `capTitle` and `cleanNames` as they are.

```ts
import type { ActionItem, MeetingSummary, NoteSection, SummarizeOptions, SummarySection } from '../types';

/** Schema property order; the model writes fields in this order, language first. */
export const SUMMARY_SCHEMA_FIELDS = ['language', 'title', 'sections', 'actionItems'] as const;

const RULES = `You write meeting notes. Meetings may mix languages, sometimes within one sentence.

Rules:
- Write every field in the dominant language of the meeting: the language most of the transcript is spoken in. Keep names, product names and technical terms as spoken.
- Use only what the transcript says. Never invent facts, decisions, owners or dates. Leave a section or list empty rather than guess.
- language: the dominant language as a BCP-47 code, e.g. "fr-FR" or "en-US".
- title: short and specific, at most 80 characters, without the date.
- sections: fill each section listed below under its key, following its instruction. A paragraph section is a string; a bullets section is a list of short strings.
- actionItems: concrete follow-ups someone committed to or was asked to do. Set owner only when the transcript makes clear who owns the task, and only to one of the attendee names exactly as listed. Set due only when a deadline is stated, worded as it was said.`;

/** The schema key of the section at `index`: s1, s2… */
export function sectionKey(index: number): string {
  return `s${index + 1}`;
}

function sectionInstruction(section: Pick<NoteSection, 'title' | 'instruction'>): string {
  return section.instruction.trim() || `What belongs under “${section.title.trim()}”.`;
}

/** The fixed rules, then the profile's prompt and sections. */
export function systemInstruction(profile: SummarizeOptions['profile']): string {
  const parts = [RULES];
  const prompt = profile.prompt.trim();
  if (prompt) parts.push(`About these meetings:\n${prompt}`);
  if (profile.sections.length > 0) {
    const lines = profile.sections.map(
      (s, i) => `- ${sectionKey(i)} “${s.title.trim()}” (${s.format}): ${sectionInstruction(s)}`,
    );
    parts.push(['Sections:', ...lines].join('\n'));
  }
  return parts.join('\n\n');
}

function schema(attendees: string[], sections: readonly NoteSection[]): Record<string, unknown> {
  const list = { type: 'array', items: { type: 'string' } };
  const properties: Record<string, unknown> = {
    language: { type: 'string', description: 'Dominant language of the meeting, BCP-47.' },
    title: { type: 'string', description: 'Short meeting title, at most 80 characters.' },
  };
  // Gemini rejects an object schema without properties, so a profile without sections has no field for them.
  if (sections.length > 0) {
    properties.sections = {
      type: 'object',
      properties: Object.fromEntries(
        sections.map((s, i) => [
          sectionKey(i),
          s.format === 'bullets'
            ? { ...list, description: sectionInstruction(s) }
            : { type: 'string', description: sectionInstruction(s) },
        ]),
      ),
      required: sections.map((_, i) => sectionKey(i)),
    };
  }
  properties.actionItems = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        owner: {
          type: 'string',
          description: 'Attendee who owns the task, exactly as listed.',
          ...(attendees.length > 0 ? { enum: attendees } : {}),
        },
        due: { type: 'string', description: 'Deadline as stated, if any.' },
      },
      required: ['task'],
    },
  };
  return { type: 'object', properties, required: Object.keys(properties) };
}

export function summaryRequest(
  transcriptText: string,
  opts: Pick<SummarizeOptions, 'attendees' | 'meetingDate' | 'profile'>,
): InteractionRequest {
  const attendees = cleanNames(opts.attendees);
  const input = [
    `Meeting date: ${opts.meetingDate}`,
    `Attendees: ${attendees.length > 0 ? attendees.join(', ') : 'unknown'}`,
    '',
    'Transcript (one line per speaker turn):',
    '<transcript>',
    transcriptText.trim(),
    '</transcript>',
  ].join('\n');
  return {
    model: SUMMARY_MODEL,
    system_instruction: systemInstruction(opts.profile),
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema: schema(attendees, opts.profile.sections) },
    store: false,
  };
}
```

The parser: replace the body after the `actionItems` loop so it builds sections instead of `summary`/`keyPoints`/`decisions`, and add `sections` to its options:

```ts
/** One section's value from the model, shaped by its format. Missing means empty. */
function sectionValue(value: unknown, section: Pick<NoteSection, 'title' | 'format'>, field: string): SummarySection {
  const base = { title: section.title.trim(), format: section.format };
  if (value === undefined || value === null) return { ...base, text: '', items: [] };
  if (section.format === 'bullets') {
    const items = typeof value === 'string' ? [value.trim()].filter(Boolean) : textList(value, field);
    return { ...base, text: '', items };
  }
  const paragraph = Array.isArray(value) ? textList(value, field).join('\n\n') : text(value, field);
  return { ...base, text: paragraph, items: [] };
}

export function parseMeetingSummary(
  raw: string,
  opts: { attendees: readonly string[]; sections: readonly Pick<NoteSection, 'title' | 'format'>[]; transcript?: string },
): MeetingSummary {
  // … unchanged: unfence, JSON.parse, object check, title, attendees, actionItems loop, language …
  const rawSections = obj.sections ?? {};
  if (typeof rawSections !== 'object' || Array.isArray(rawSections)) fail('sections is not an object');
  const sections = opts.sections.map((section, i) =>
    sectionValue((rawSections as Record<string, unknown>)[sectionKey(i)], section, `sections.${sectionKey(i)}`),
  );
  return { title, sections, actionItems, ...(language ? { language } : {}) };
}
```

In `summarize`, pass the sections to the parser:

```ts
  return parseMeetingSummary(outputText(interaction), {
    attendees: opts.attendees,
    sections: opts.profile.sections,
    transcript: transcriptText,
  });
```

Delete the old `SYSTEM_INSTRUCTION` constant.

- [ ] **Step 5: Run the summary tests**

Run: `pnpm vitest run --project node tests/transcribe/summary.test.ts`
Expected: PASS.

- [ ] **Step 6: Notion page body.** In `tests/notion/blocks.test.ts`, change the summary fixture to the new shape and add:

```ts
  it('writes each section in order, then the action items', () => {
    const summary = {
      title: 'Pricing call',
      sections: [
        { title: 'Client needs', format: 'bullets' as const, text: '', items: ['A PDF export', 'SSO'] },
        { title: 'Pricing', format: 'paragraph' as const, text: 'About 40k a year.\n\nPilot is separate.', items: [] },
        { title: 'Objections', format: 'bullets' as const, text: '', items: [] },
      ],
      actionItems: [{ task: 'Send the quote', owner: 'Marie', due: 'Friday' }],
    };
    const blocks = buildMeetingBody({ ...input, transcript: { ...input.transcript, notes: [] }, summary });
    expect(blocks.map((b) => [b.type, blockText(b)])).toEqual([
      ['heading_2', 'Client needs'],
      ['bulleted_list_item', 'A PDF export'],
      ['bulleted_list_item', 'SSO'],
      ['heading_2', 'Pricing'],
      ['paragraph', 'About 40k a year.'],
      ['paragraph', 'Pilot is separate.'],
      ['heading_2', 'Objections'],
      ['paragraph', 'None.'],
      ['heading_2', 'Action items'],
      ['to_do', 'Marie — Send the quote (Friday)'],
    ]);
  });
```

(`input` is the file's existing `MeetingPageInput` fixture; name it that way if it isn't already.) Replace the body of `buildMeetingBody` after the notes callout with:

```ts
  const { summary } = input;
  if (!summary) {
    blocks.push(...simple('heading_2', richText('Summary')));
    blocks.push(...muted('The summary is unavailable for this meeting. The full transcript is below.'));
    return blocks;
  }
  for (const s of summary.sections) {
    if (s.format === 'paragraph') {
      const paragraphs = s.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      blocks.push(...simple('heading_2', richText(s.title)));
      blocks.push(...(paragraphs.length ? paragraphs.flatMap((p) => simple('paragraph', richText(p))) : muted('None.')));
    } else {
      blocks.push(...section(s.title, s.items, (t) => simple('bulleted_list_item', richText(t))));
    }
  }
  blocks.push(...section('Action items', summary.actionItems.filter((a) => a.task.trim()).map(formatActionItem), todos));
  return blocks;
```

- [ ] **Step 7: Stored results from before profiles.** Add to `tests/storage/resultStore.test.ts` (create it with the imports below if it doesn't exist; `fakeBrowser` comes from `wxt/testing`, as in `tests/storage/sessionStore.test.ts`):

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getResult, normalizeSummary } from '@lib/storage/resultStore';

describe('normalizeSummary', () => {
  it('turns a summary from before profiles into the three starter sections', () => {
    const old = { title: 'Sync', summary: 'We met.', keyPoints: ['A'], decisions: [], actionItems: [], language: 'en-US' };
    expect(normalizeSummary(old as never)).toEqual({
      title: 'Sync',
      sections: [
        { title: 'Summary', format: 'paragraph', text: 'We met.', items: [] },
        { title: 'Key points', format: 'bullets', text: '', items: ['A'] },
        { title: 'Decisions', format: 'bullets', text: '', items: [] },
      ],
      actionItems: [],
      language: 'en-US',
    });
  });

  it('leaves a current summary and null alone', () => {
    const current = { title: 'Sync', sections: [], actionItems: [] };
    expect(normalizeSummary(current)).toBe(current);
    expect(normalizeSummary(null)).toBeNull();
  });
});

describe('getResult', () => {
  beforeEach(() => fakeBrowser.reset());

  it('reads an old stored result in the new shape', async () => {
    await fakeBrowser.storage.local.set({
      'result:s1': { title: 'Sync', attendees: [], transcript: { turns: [], source: 'audio-only', notes: [] },
        summary: { title: 'Sync', summary: 'We met.', keyPoints: [], decisions: [], actionItems: [] },
        transcription: null, createdAt: 1 },
    });
    expect((await getResult('s1'))?.summary?.sections[0]).toEqual({ title: 'Summary', format: 'paragraph', text: 'We met.', items: [] });
  });
});
```

Implement in `src/lib/storage/resultStore.ts`:

```ts
import { STARTER_SECTIONS } from '../profiles';
import type { ActionItem, MeetingSummary, SessionResult } from '../types';

/** A summary stored before profiles: a fixed summary, key points and decisions. */
interface LegacySummary {
  title: string;
  summary?: string;
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: ActionItem[];
  language?: string;
}

/** A stored summary in the current shape; one from before profiles gets the starter sections. */
export function normalizeSummary(value: MeetingSummary | LegacySummary | null | undefined): MeetingSummary | null {
  if (!value) return null;
  if (Array.isArray((value as MeetingSummary).sections)) return value as MeetingSummary;
  const old = value as LegacySummary;
  const [summary, keyPoints, decisions] = STARTER_SECTIONS;
  return {
    title: old.title,
    sections: [
      { title: summary!.title, format: 'paragraph', text: old.summary ?? '', items: [] },
      { title: keyPoints!.title, format: 'bullets', text: '', items: old.keyPoints ?? [] },
      { title: decisions!.title, format: 'bullets', text: '', items: old.decisions ?? [] },
    ],
    actionItems: old.actionItems ?? [],
    ...(old.language ? { language: old.language } : {}),
  };
}

export async function getResult(sessionId: string): Promise<SessionResult | null> {
  const key = resultKey(sessionId);
  const got = await browser.storage.local.get(key);
  const stored = got[key] as SessionResult | undefined;
  return stored ? { ...stored, summary: normalizeSummary(stored.summary) } : null;
}
```

- [ ] **Step 8: The pipeline passes the profile.** In `src/lib/pipeline/process.ts`, import `defaultProfile, profileById` from `'../profiles'` and pass the profile to `summarize` (Task 7 replaces this lookup with the job's own profile):

```ts
      summary = await deps.ai.summarize(formatTranscript(merged), {
        attendees,
        meetingDate: localDate(meta.startedAt),
        profile: profileById(settings, route) ?? defaultProfile(settings),
      });
```

- [ ] **Step 9: Fix the remaining fakes and fixtures**

Run: `pnpm typecheck`
Expected: errors only in tests that build a `MeetingSummary` with `summary`/`keyPoints`/`decisions` or call `summarize`/`summaryRequest` without `profile`. Convert each fake summary to `{ title, sections: [], actionItems: [] }` (or the starter sections where a test checks the Notion body), and pass `profile: { prompt: '', sections: [...STARTER_SECTIONS] }` where options are built. In `tests/transcribe/summarize.integration.test.ts`, add a second case that summarizes the fixture transcript with the `CLIENT` profile above and checks `sections.map(s => s.title)` equals `['Client needs', 'Pricing']`.

- [ ] **Step 10: Run everything**

Run: `pnpm typecheck && pnpm test:node`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/types.ts src/lib/transcribe/summary.ts src/lib/notion/blocks.ts src/lib/storage/resultStore.ts src/lib/pipeline/process.ts tests
git commit -m "feat: write notes in a profile's sections" -m "The summary schema gets one field per section (s1…sN, a string or a list by format) plus title, language and action items, and the profile's prompt joins the fixed rules. The Notion page writes the sections in order. Results stored before profiles read as the three starter sections."
```

---

### Task 4: Optional Profile column in Notion

**Files:**
- Modify: `src/lib/notion/schema.ts`, `src/lib/notion/properties.ts`, `src/lib/notion/store.ts:160-175`, `src/lib/types.ts` (MeetingPageInput)
- Test: `tests/notion/properties.test.ts`, `tests/notion/store.test.ts`

- [ ] **Step 1: Failing tests.** Append to `tests/notion/properties.test.ts`:

```ts
import { profileProperty } from '@lib/notion/properties';

describe('profileProperty', () => {
  it('fills the Profile select with the profile name, without commas', () => {
    expect(profileProperty('Client, EMEA')).toEqual({ Profile: { select: { name: 'Client EMEA' } } });
  });

  it('writes nothing for a blank name', () => {
    expect(profileProperty('  ')).toEqual({});
  });
});
```

Append to `tests/notion/store.test.ts`:

```ts
import { pageProperties } from '@lib/notion/store';

describe('pageProperties', () => {
  const input = {
    key: 'abc-defg-hij-2026-09-19', title: 'Sync', startedAt: 0, durationMs: 60_000, attendees: [], meetCode: 'abc-defg-hij',
    recordedBy: 'Ilyas', source: 'audio-only' as const, summary: null, transcript: { turns: [], source: 'audio-only' as const, notes: [] },
    profileName: 'Client meeting',
  };

  it('fills Profile when the database has that select', () => {
    const props = pageProperties(input, { titleProperty: 'Name', properties: { Profile: 'select' } });
    expect(props.Profile).toEqual({ select: { name: 'Client meeting' } });
  });

  it('leaves Profile out when the database has none, or it isn’t a select', () => {
    expect(pageProperties(input, { titleProperty: 'Name', properties: {} })).not.toHaveProperty('Profile');
    expect(pageProperties(input, { titleProperty: 'Name', properties: { Profile: 'rich_text' } })).not.toHaveProperty('Profile');
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project node tests/notion/properties.test.ts tests/notion/store.test.ts`
Expected: FAIL, missing exports.

- [ ] **Step 3: Implement.** `src/lib/notion/schema.ts`, after `MEETING_DB_SCHEMA`:

```ts
/** Filled when the database has them, never required: a Select named Profile tells profiles sharing a database apart. */
export const OPTIONAL_PROPS = { profile: 'Profile' } as const;
```

and in `databaseSchemaPayload()` add `[OPTIONAL_PROPS.profile]: { type: 'select', select: { options: [] } },` after the Key.

`src/lib/notion/properties.ts`:

```ts
import { MEETING_PROPS, OPTIONAL_PROPS } from './schema';

/** The optional Profile select. Nothing for a blank name. */
export function profileProperty(name: string): Record<string, unknown> {
  const [option] = sanitizeMultiSelect([name]);
  return option ? { [OPTIONAL_PROPS.profile]: { select: { name: option } } } : {};
}
```

`src/lib/types.ts`, in `MeetingPageInput` after `recordedBy`:

```ts
  /** Fills the database's optional Profile select, when it has one. */
  profileName?: string;
```

`src/lib/notion/store.ts`: import `profileProperty` and `OPTIONAL_PROPS`, add the helper above `createNotionMeetingStore`, and use it in `createMeeting` in place of `buildMeetingProperties(input, db.titleProperty)`:

```ts
/** The row's properties but the Key; the Profile select only where the database has one. */
export function pageProperties(
  input: MeetingPageInput,
  db: Pick<ResolvedDatabase, 'titleProperty' | 'properties'>,
): Record<string, unknown> {
  const hasProfile = db.properties[OPTIONAL_PROPS.profile] === 'select';
  return {
    ...buildMeetingProperties(input, db.titleProperty),
    ...(input.profileName && hasProfile ? profileProperty(input.profileName) : {}),
  };
}
```

```ts
          properties: pageProperties(input, db),
```

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test:node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/notion src/lib/types.ts tests/notion
git commit -m "feat: fill an optional Profile column in Notion" -m "When a meetings database has a Select named Profile, saved pages carry their profile's name, which tells profiles sharing a database apart. The setup script adds the column; verification doesn't require it."
```

---

### Task 5: Config file module

**Files:**
- Create: `src/lib/config.ts`
- Test: `tests/config/config.test.ts`

- [ ] **Step 1: Failing tests.** Create `tests/config/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project node tests/config/config.test.ts`
Expected: FAIL, cannot resolve `@lib/config`.

- [ ] **Step 3: Write `src/lib/config.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run --project node tests/config/config.test.ts`
Expected: PASS. If `previewConfig`'s order or wording differs from the test, fix the code, not the test: the test is the spec.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts tests/config
git commit -m "feat: build, check and merge shareable config files" -m "A manet-config file carries profiles, the default profile and the settings a team shares, plus the API keys only when asked. Parsing names the first problem in one sentence; the preview lists what an import would change; merging replaces profiles by id and keeps local-only ones."
```

---

### Task 6: Menus that show a choice

**Files:**
- Modify: `src/lib/ui/menu.ts` (MenuItem, build), `src/lib/ui/css/` file that styles `.menu-item` (find it with `grep -rn "menu-item" src/lib/ui/css src/lib/ui/styles.css`)
- Test: `tests/ui/dashboardMenu.browser.test.ts` (or a new `tests/ui/menu.browser.test.ts`)

- [ ] **Step 1: Failing test.** Create `tests/ui/menu.browser.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { createMenu } from '@lib/ui/menu';

describe('menu items with a checkmark', () => {
  afterEach(() => document.body.replaceChildren());

  it('marks a checked item as the selected radio item with a check glyph', () => {
    const host = document.createElement('div');
    const anchor = document.createElement('button');
    document.body.append(host, anchor);
    const menu = createMenu(host);
    menu.open(anchor, [
      { label: 'Team', checked: true, onSelect: () => undefined },
      { label: 'Client meeting', checked: false, onSelect: () => undefined },
      { label: 'Delete…', onSelect: () => undefined },
    ]);
    const items = [...menu.element.querySelectorAll('.menu-item')];
    expect(items.map((i) => [i.getAttribute('role'), i.getAttribute('aria-checked')])).toEqual([
      ['menuitemradio', 'true'],
      ['menuitemradio', 'false'],
      ['menuitem', null],
    ]);
    expect(items[0]!.querySelector('.glyph-check')).not.toBeNull();
    expect(items[1]!.querySelector('.glyph-check')).toBeNull();
    menu.destroy();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project browser tests/ui/menu.browser.test.ts`
Expected: FAIL (`checked` is not a MenuItem field; roles are all `menuitem`).

- [ ] **Step 3: Implement.** In `src/lib/ui/menu.ts` add to `MenuItem`:

```ts
  /** A choice among the items: true shows ✓ and aria-checked. Undefined for a plain action. */
  checked?: boolean;
```

import `svg` from `./icons`, and in `build()` create the element with:

```ts
      const choice = item.checked !== undefined;
      const el = h(
        'button',
        {
          type: 'button',
          ...item.attrs,
          class: choice ? 'menu-item menu-item-choice' : 'menu-item',
          role: choice ? 'menuitemradio' : 'menuitem',
          'aria-checked': choice ? String(item.checked) : undefined,
          tabindex: '-1',
          'aria-disabled': item.disabled ? 'true' : undefined,
        },
        choice ? h('span', { class: 'menu-item-check' }, item.checked ? svg('check') : null) : null,
        h('span', { class: 'menu-item-label' }, item.label),
        item.note ? h('span', { class: 'menu-item-note' }, item.note) : null,
      );
```

In the stylesheet that defines `.menu-item`, add a leading 1em column for choices:

```css
.menu-item-choice {
  display: grid;
  grid-template-columns: 1.25em 1fr;
  column-gap: 6px;
}
.menu-item-choice .menu-item-note {
  grid-column: 2;
}
.menu-item-check {
  display: inline-flex;
  align-items: center;
  color: var(--tint);
}
```

(Use the variable the file already uses for the accent colour if `--tint` isn't it.)

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run --project browser tests/ui/menu.browser.test.ts tests/ui/dashboardMenu.browser.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/menu.ts src/lib/ui/css src/lib/ui/styles.css tests/ui/menu.browser.test.ts
git commit -m "feat: let menu items show the current choice" -m "A checked item is a menuitemradio with a check glyph, for picking a profile from the same menu the rows use."
```

### Task 7: Jobs and meetings carry a profile

The backend switch. After this task a meeting records its `profileId`, jobs send the whole `Profile`, the pipeline uses the profile's database, vocabulary and sections, and a meeting's profile can change. The routing window still exists (Task 10 removes it); choosing Team or Personal there sets `profileId` to `team` or `personal`.

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/settingsSchema.ts`, `src/lib/pipeline/{process,save,session,notes}.ts`, `entrypoints/offscreen/main.ts`, `src/lib/messages.ts`, `src/lib/storage/sessionStore.ts`, `entrypoints/background/{sessionManager,copy}.ts`, `src/lib/ui/{extension,popupView,settingsForm,sessionView}.ts`, `entrypoints/{popup,dashboard}/main.ts`
- Test: `tests/helpers/meeting.ts`, `tests/background/harness.ts`, `tests/pipeline/*.test.ts`, `tests/offscreen/main.test.ts`, `tests/background/{lifecycle,copy,index}.test.ts`, `tests/storage/sessionStore.test.ts`, `tests/ui/{popupView,sessionView,settingsForm}.test.ts`, new `tests/background/profiles.test.ts`

- [ ] **Step 1: Types.** In `src/lib/types.ts`:

```ts
// SessionMeta, after `route?: Route;`
  /**
   * The meeting's profile (a Settings.profiles id), chosen before recording. Meetings from
   * before profiles read their Team | Personal route here (sessionStore normalizes them).
   */
  profileId?: string;
```

```ts
// SessionResult, after `transcription`
  /** The profile the summary was written for. Absent on results from before profiles. */
  profile?: { id: string; name: string };
```

Replace `route: Route;` in `ProcessJob` and `SaveJob` with:

```ts
  /** The meeting's profile: its database, vocabulary, prompt and sections. */
  profile: Profile;
```

and add to `ProcessJob`:

```ts
  /**
   * Summarize this stored result again for `profile` instead of transcribing: the
   * meeting's profile changed after it was transcribed.
   */
  reuse?: SessionResult;
```

- [ ] **Step 2: Missing settings name the profile's database.** In `src/lib/settingsSchema.ts` change both helpers to take the profile (import `type Profile`):

```ts
/**
 * Everything a full audio transcript needs, in the words of missingForSave, then
 * "a Gemini key" (Settings asks for it last).
 */
export function missingSettings(settings: Settings, profile: Pick<Profile, 'name' | 'databaseId'>): string[] {
  return [...missingForSave(settings, profile), ...(settings.geminiApiKey.trim() ? [] : ['a Gemini key'])];
}

/**
 * What blocks filing a meeting at all, as words that fit "Add … in Settings": "your
 * name", "a Notion token", "the Client meeting profile’s database", in the order Settings
 * asks for them. A blank value counts as missing, as in the popup and Settings. Without a
 * Gemini key the pipeline still saves a transcript built from captions.
 */
export function missingForSave(settings: Settings, profile: Pick<Profile, 'name' | 'databaseId'>): string[] {
  const missing: string[] = [];
  if (!settings.displayName.trim()) missing.push('your name');
  if (!settings.notionToken.trim()) missing.push('a Notion token');
  if (!profile.databaseId.trim()) missing.push(`the ${profile.name.trim()} profile’s database`);
  return missing;
}
```

`databaseIdFor` stays until Task 14; nothing in the pipeline uses it after this task.

- [ ] **Step 3: Test helpers.** In `tests/helpers/meeting.ts` add, and use `profileId: 'team'` in `sessionMeta()`:

```ts
import { starterProfiles } from '@lib/profiles';
import type { Profile } from '@lib/types';

/** The migrated Team profile with a database, as most pipeline tests want it. */
export function testProfile(overrides: Partial<Profile> = {}): Profile {
  return { ...starterProfiles('team-db')[0]!, ...overrides };
}
```

In `tests/background/harness.ts`, `FULL_SETTINGS` gets `profiles: starterProfiles('team-db', 'personal-db'), defaultProfileId: 'team',` (import `starterProfiles` from `@lib/profiles`). Without it the stored profiles keep the empty databases of `DEFAULT_SETTINGS` and every save is blocked.

- [ ] **Step 4: Failing pipeline tests.** Create `tests/pipeline/profile.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { processSession } from '@lib/pipeline/process';
import { saveSession } from '@lib/pipeline/save';
import type { MeetingAI, MeetingStore, ProcessJob, SessionResult } from '@lib/types';
import { sessionMeta, testProfile, testSettings } from '../helpers/meeting';

const CLIENT = testProfile({
  id: 'client',
  name: 'Client meeting',
  databaseId: 'client-db',
  prompt: 'Sales call.',
  sections: [{ id: 'n', title: 'Client needs', instruction: 'Their words.', format: 'bullets' }],
  vocabulary: ['Acme'],
});

function deps(overrides: { ai?: Partial<MeetingAI>; store?: Partial<MeetingStore> } = {}) {
  const ai: MeetingAI = {
    transcribe: vi.fn(async () => ({
      words: [{ text: 'Bonjour', start: 0, end: 500 }],
      text: 'Bonjour',
      timingPass: { ok: true as const },
      textPass: { ok: true as const },
    })),
    summarize: vi.fn(async () => ({ title: 'Acme call', sections: [], actionItems: [] })),
    ...overrides.ai,
  };
  const store: MeetingStore = {
    findByKey: vi.fn(async () => null),
    createMeeting: vi.fn(async () => ({ pageId: 'p1', url: 'https://notion.so/p1' })),
    listByKey: vi.fn(async () => []),
    archivePage: vi.fn(async () => undefined),
    ...overrides.store,
  };
  const audio = {
    readAudio: vi.fn(async () => new Blob([new Uint8Array(10)], { type: 'audio/webm' })),
    writeChunk: vi.fn(),
    stat: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  };
  return { ai, store, audio };
}

function job(overrides: Partial<ProcessJob> = {}): ProcessJob {
  return {
    meta: sessionMeta({ profileId: 'client' }),
    captions: [],
    settings: testSettings({ geminiApiKey: 'k', customVocabulary: ['Manet'] }),
    profile: CLIENT,
    ...overrides,
  };
}

describe('the pipeline with a profile', () => {
  it('checks the profile’s database, adds its vocabulary and writes its sections', async () => {
    const d = deps();
    const outcome = await processSession(job(), d);
    expect(d.store.findByKey).toHaveBeenCalledWith('client-db', expect.any(String));
    expect(vi.mocked(d.ai.transcribe).mock.calls[0]![1].customVocabulary).toEqual(
      expect.arrayContaining(['Manet', 'Acme']),
    );
    expect(vi.mocked(d.ai.summarize).mock.calls[0]![1].profile).toBe(CLIENT);
    expect(outcome.status === 'processed' && outcome.result.profile).toEqual({ id: 'client', name: 'Client meeting' });
  });

  it('summarizes a stored result again without touching the audio', async () => {
    const d = deps();
    const reuse: SessionResult = {
      title: 'Old',
      attendees: ['Marie'],
      transcript: {
        turns: [{ speaker: 'Marie', start: 0, end: 1000, text: 'Bonjour' }],
        source: 'audio+captions',
        notes: ['The summary could not be generated: timeout', 'Kept note.'],
      },
      summary: null,
      transcription: { timingPass: { ok: true }, textPass: { ok: true } },
      profile: { id: 'team', name: 'Team' },
      createdAt: 1,
    };
    const outcome = await processSession(job({ reuse }), d);
    expect(d.ai.transcribe).not.toHaveBeenCalled();
    expect(d.audio.readAudio).not.toHaveBeenCalled();
    expect(d.ai.summarize).toHaveBeenCalledOnce();
    if (outcome.status !== 'processed') throw new Error(outcome.status);
    expect(outcome.result.profile).toEqual({ id: 'client', name: 'Client meeting' });
    expect(outcome.result.transcript.turns).toEqual(reuse.transcript.turns);
    expect(outcome.result.transcript.notes).toEqual(['Kept note.']);
    expect(outcome.result.title).toBe('Acme call');
  });

  it('saves to the profile’s database with the profile’s name', async () => {
    const d = deps();
    const result: SessionResult = {
      title: 'Acme call', attendees: [], summary: null, transcription: null, createdAt: 1,
      transcript: { turns: [{ speaker: 'A', start: 0, end: 1, text: 'x' }], source: 'audio-only', notes: [] },
      profile: { id: 'client', name: 'Client meeting' },
    };
    // force skips the duplicate check and the settle loop, which would otherwise wait on Notion's index.
    await saveSession({ meta: sessionMeta({ profileId: 'client' }), result, settings: testSettings(), profile: CLIENT, force: true }, d);
    expect(d.store.createMeeting).toHaveBeenCalledWith('client-db', expect.objectContaining({ profileName: 'Client meeting' }));
  });
});
```

(If `processSession`'s deps type needs `onStage`, it is optional; the audio fake only needs the methods the pipeline calls.)

- [ ] **Step 5: Run to see it fail**

Run: `pnpm vitest run --project node tests/pipeline/profile.test.ts`
Expected: FAIL (the job type has `route`, not `profile`).

- [ ] **Step 6: Pipeline.** In `src/lib/pipeline/notes.ts` add next to `summaryFailedNote`:

```ts
const SUMMARY_FAILED = 'The summary could not be generated';

export function summaryFailedNote(err: unknown): string {
  return `${SUMMARY_FAILED}: ${shortError(err)}`;
}

/** A summary is being written again, so an earlier failure to write one no longer applies. */
export function isSummaryFailedNote(note: string): boolean {
  return note.startsWith(SUMMARY_FAILED);
}
```

In `src/lib/pipeline/process.ts`:
- Take `profile` from the job instead of `route`: `const { meta, captions, settings, profile } = job;`
- Duplicate check: `deps.store.findByKey(profile.databaseId, meta.idempotencyKey)`; remove the `databaseIdFor` and `profileById`/`defaultProfile` imports.
- Right after the duplicate check: `if (job.reuse) return summarizeAgain(job, job.reuse, deps, notes, stage);`
- Vocabulary: `customVocabulary: buildVocabulary([...settings.customVocabulary, ...profile.vocabulary], attendees),`
- Summary: `profile,` in the summarize options.
- Result: add `profile: { id: profile.id, name: profile.name },`.

Add the function (import `isDuplicateCheckNote`, `isSummaryFailedNote` from `./notes`):

```ts
/**
 * The stored transcript summarized again for the meeting's new profile. No audio is read
 * and nothing is transcribed; notes about an earlier summary or duplicate check are
 * replaced by this run's.
 */
async function summarizeAgain(
  job: ProcessJob,
  reuse: SessionResult,
  deps: PipelineDeps,
  notes: string[],
  stage: (s: JobStage) => void,
): Promise<ProcessOutcome> {
  const { meta, settings, profile } = job;
  const kept = reuse.transcript.notes.filter((n) => !isSummaryFailedNote(n) && !isDuplicateCheckNote(n));
  const transcript: MeetingTranscript = { ...reuse.transcript, notes: [...notes, ...kept] };
  let summary: MeetingSummary | null = null;
  if (settings.geminiApiKey.trim() !== '' && transcript.turns.length > 0) {
    stage('summarizing');
    try {
      summary = await deps.ai.summarize(formatTranscript(transcript), {
        attendees: reuse.attendees,
        meetingDate: localDate(meta.startedAt),
        profile,
      });
    } catch (err) {
      transcript.notes.push(summaryFailedNote(err));
    }
  }
  return {
    status: 'processed',
    result: {
      ...reuse,
      title: meetingTitle(summary, meta),
      transcript,
      summary,
      profile: { id: profile.id, name: profile.name },
      createdAt: Date.now(),
    },
  };
}
```

`src/lib/pipeline/save.ts`: `const databaseId = job.profile.databaseId;` (drop `databaseIdFor`).

`src/lib/pipeline/session.ts` `buildMeetingPageInput({ meta, result, settings, profile })`: add `profileName: profile.name,` after `recordedBy`.

- [ ] **Step 7: Offscreen job check.** In `entrypoints/offscreen/main.ts` replace the route line in `checkJob` with:

```ts
  const profile = job.profile as { id?: unknown; databaseId?: unknown; sections?: unknown } | undefined;
  if (typeof profile !== 'object' || profile === null || typeof profile.id !== 'string') throw problem('profile is missing');
  if (typeof profile.databaseId !== 'string' || !Array.isArray(profile.sections)) throw problem('profile is incomplete');
```

Update `tests/offscreen/main.test.ts`: jobs carry `profile: testProfile()` instead of `route`, and the "unknown route" case becomes "profile is missing" (send a job without `profile`).

- [ ] **Step 8: Messages.** In `src/lib/messages.ts`:

```ts
  /** Popup / keyboard command: start recording this tab (needs a user invocation). No profile: the default. */
  'session/start': { req: { tabId: number; profileId?: string }; res: StartResult };
```

and after `'session/route-hold'`:

```ts
  /** Popup / Meetings: the meeting's profile, before, during or after recording. */
  'session/set-profile': { req: { sessionId: string; profileId: string }; res: void };
```

`src/lib/ui/extension.ts`:

```ts
export async function startRecording(tabId: number, profileId?: string): Promise<string> {
  const result = await sendToBackground('session/start', profileId ? { tabId, profileId } : { tabId });
  if (!result.ok) throw new Error(result.error);
  return result.sessionId;
}
```

- [ ] **Step 9: Old metas read with a profile.** Add to `src/lib/storage/sessionStore.ts` and apply it in `read()`, in `listSessions()` (map before sorting) and to both values in `watchSessions`:

```ts
/** A meta as any version stored it: a meeting from before profiles takes its Team | Personal destination as its profile. */
export function normalizeMeta(meta: SessionMeta): SessionMeta {
  if (meta.profileId !== undefined || meta.route === undefined) return meta;
  return { ...meta, profileId: meta.route };
}
```

Test in `tests/storage/sessionStore.test.ts`:

```ts
  it('reads a meeting from before profiles with its destination as its profile', async () => {
    const { profileId: _p, ...old } = meta({ route: 'personal' }); // the file's meta fixture helper
    await fakeBrowser.storage.local.set({ [sessionKey(old.id)]: old });
    expect((await getSession(old.id))?.profileId).toBe('personal');
    expect((await listSessions())[0]?.profileId).toBe('personal');
  });
```

(Use the fixture helper the file already has for a `SessionMeta`.)

- [ ] **Step 10: Words.** In `entrypoints/background/copy.ts`:

Replace `SETTING_WORDS` and `settingsPhrase` with:

```ts
/**
 * The settings missingSettings names ("your name", "a Notion token", "the Team profile’s
 * database", "a Gemini key"), in the order Settings asks for them. Older records' names
 * ("Notion integration token", "Notion team database id", "Gemini API key") map to words too.
 * A profile's database is matched first, so a profile called "Token" still reads right.
 */
const SETTING_WORDS: [RegExp, (item: string) => string, number][] = [
  [/profile’s database$/i, (item) => item, 2],
  [/name/i, () => 'your name', 0],
  [/token/i, () => 'a Notion token', 1],
  [/team/i, () => 'the Team database', 2],
  [/personal/i, () => 'the Personal database', 2],
  [/gemini/i, () => 'a Gemini key', 3],
];

/** "your name, a Notion token and the Team profile’s database". */
export function settingsPhrase(missing: readonly string[]): string {
  const words = missing
    .map((item) => {
      const match = SETTING_WORDS.find(([pattern]) => pattern.test(item));
      return match ? { order: match[2], text: match[1](item) } : { order: SETTING_WORDS.length, text: item };
    })
    .sort((a, b) => a.order - b.order)
    .map((w) => w.text);
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
```

`notes.saved` names where the meeting went:

```ts
  saved(meta: Meeting, where: string, now: number, locale?: string): Note {
    const length = meta.durationMs ? ` (${meetingLength(meta.durationMs)})` : '';
    return {
      title: 'Saved to Notion',
      message: `Your ${meetingName(meta.startedAt, now, locale)}${length} is in ${where}.`,
    };
  },
```

and add to `problems`:

```ts
  /** The meeting's profile no longer exists; Meetings offers the others. */
  profileDeleted: 'This meeting’s profile was deleted. Choose another profile.',

  /** A page asked for a profile that is gone (deleted in another tab). */
  unknownProfile: 'That profile no longer exists. Reload the page and choose another.',

  cannotChangeProfile(status: SessionStatus): string {
    return occupied(status, 'change its profile') ?? 'The profile can’t be changed now. Reload Meetings.';
  },
```

In `src/lib/ui/sessionView.ts`, insert as the third entry of `SETTING_NAMES`: `[/profile’s database$/i, (m) => m.input ?? m[0]],`. In `src/lib/ui/settingsForm.ts`, add `[/profile’s database/i, 'notionTeamDbId'],` to `MISSING_FIELDS` (Task 11 points it at the Profiles group), and make `setupProblems` take the profile:

```ts
export function setupProblems(settings: Settings, profile: Pick<Profile, 'name' | 'databaseId'>): { blocking: string[]; geminiKeyMissing: boolean } {
  return { blocking: missingForSave(settings, profile), geminiKeyMissing: !settings.geminiApiKey };
}
```

`entrypoints/dashboard/main.ts`: `setupProblems(settings, defaultProfile(settings))`.

- [ ] **Step 11: Popup setup sentence.** In `src/lib/ui/popupView.ts`:

```ts
/** What blocks saving to Notion, in the order the setup sentence names them. */
export type SetupGap = 'name' | 'token' | 'database';

/** The Settings field that fixes each gap ("Open settings" lands on the first one). */
const GAP_FIELD: Record<SetupGap, FieldName> = { name: 'displayName', token: 'notionToken', database: 'notionTeamDbId' };

/** Mirrors missingForSave(settings, the default profile), as items the popup can name in a sentence. */
export function setupGaps(settings: Settings): SetupGap[] {
  const gaps: SetupGap[] = [];
  if (!settings.displayName.trim()) gaps.push('name');
  if (!settings.notionToken.trim()) gaps.push('token');
  if (!defaultProfile(settings).databaseId.trim()) gaps.push('database');
  return gaps;
}

const GAP_WORDS: Record<Exclude<SetupGap, 'database'>, string> = { name: 'your name', token: 'a Notion token' };

/** "Add your name, a Notion token and the Team profile’s database." */
export function setupSentence(gaps: readonly SetupGap[], profileName: string): string {
  const words = gaps.map((g) => (g === 'database' ? `the ${profileName} profile’s database` : GAP_WORDS[g]));
  if (words.length === 0) return '';
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
  return `Add ${list}.`;
}
```

Add to `PopupModel`:

```ts
  /** Every profile, in Settings order: the Profile row's choices. */
  profiles: readonly Pick<Profile, 'id' | 'name'>[];
  defaultProfileId: string;
```

In `renderSetup`, call `setupSentence(m.setup, profileName(m, m.defaultProfileId))` with this helper at module level:

```ts
function profileName(m: Pick<PopupModel, 'profiles'>, id: string | undefined): string {
  return m.profiles.find((p) => p.id === id)?.name ?? m.profiles[0]?.name ?? '';
}
```

`entrypoints/popup/main.ts` fills `profiles: settings.profiles.map(({ id, name }) => ({ id, name })), defaultProfileId: settings.defaultProfileId,`.

- [ ] **Step 12: Background.** In `entrypoints/background/sessionManager.ts` (import `defaultProfile, profileById, profileForSession` from `@lib/profiles`, `type Profile` from `@lib/types`):

```ts
/** A meeting's profile can change until it is in Notion or on its way there. */
const PROFILE_CHANGEABLE = new Set<SessionStatus>(['recording', 'awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);
```

Interface additions:

```ts
  /** Starts recording `tabId` for `profileId` (the default profile when absent or unknown). */
  start(tabId: number, profileId?: string): Promise<StartResult>;
  /** Sets the meeting's profile. The next transcription or save uses it. */
  setProfile(sessionId: string, profileId: string): Promise<void>;
```

`start(tabId, profileId)` passes `profileId` to `startRecording(tabId, profileId)`, which resolves it right after `const settings = await deps.getSettings();`:

```ts
    const profile = profileById(settings, profileId) ?? defaultProfile(settings);
```

and adds `profileId: profile.id,` to the `putSession` meta.

`applyRoute` sets the profile along with the route (`{ ...m, route, profileId: route, status: 'ready' }` and `{ ...m, route, profileId: route }`).

New functions, next to `markMissingSettings`:

```ts
  /** The meeting's profile was deleted: it waits for another (Meetings offers them). */
  async function markProfileMissing(id: string, kind: Job['kind']): Promise<void> {
    let changed = false;
    const meta = await updateSession(id, (m) => {
      if (RUNNING.has(m.status)) return m;
      changed = true;
      return { ...m, status: 'failed', stage: undefined, job: undefined, error: problems.profileDeleted };
    });
    if (meta && changed) await notify(id, failureNote(meta, kind, problems.profileDeleted));
  }

  async function changeProfile(id: string, profileId: string): Promise<void> {
    if (!profileById(await deps.getSettings(), profileId)) throw new MeetingProblem(problems.unknownProfile);
    const meta = await updateSession(id, (m) => {
      if (!PROFILE_CHANGEABLE.has(m.status)) throw new MeetingProblem(problems.cannotChangeProfile(m.status));
      return m.profileId === profileId ? m : { ...m, profileId };
    });
    if (!meta) throw new MeetingProblem(problems.deleted);
  }
```

`transcribeNow(id, opts: { force?: boolean; attempt?: number; summaryOnly?: boolean } = {})`: replace the `route`/`missing` lines with:

```ts
    const settings = await deps.getSettings();
    const profile = profileForSession(settings, meta.profileId);
    if (!profile) {
      await markProfileMissing(id, 'process');
      return;
    }
    const route = meta.route ?? settings.defaultRoute;
    const missing = missingForSave(settings, profile);
```

set `profileId: profile.id,` in the `processing` meta, and send:

```ts
    const reuse = opts.summaryOnly ? await getResult(id) : null;
    await launch(id, job.id, 'process', async () => {
      const captions = await loadCaptions(id);
      await deps.offscreen.send('offscreen/process', {
        jobId: job.id,
        meta: processing,
        captions,
        settings,
        profile,
        attempt,
        ...(reuse ? { reuse } : {}),
        ...(force ? { force } : {}),
      });
    });
```

`saveNow`: resolve the profile the same way (`markProfileMissing(id, 'save')` when null), then, before claiming the job:

```ts
    // The notes were written for another profile: write them again for this one; the save follows.
    const writtenFor = result.profile?.id ?? meta.route;
    if (writtenFor !== undefined && writtenFor !== profile.id) {
      await transcribeNow(id, { summaryOnly: true, ...(opts.force ? { force: true } : {}) });
      return;
    }
```

and send `profile` in place of `route` in `'offscreen/save'` (keep setting `route` on the meta for the pages until Task 10).

In `saveDone`, name the profile in the notification:

```ts
        const where = profileForSession(settings, saved?.profileId)?.name ?? 'Notion';
        if (saved) await notify(id, notes.saved(saved, where, savedAt));
```

Public API and handlers:

```ts
    start: (tabId, profileId) => start(tabId, profileId),

    setProfile(sessionId, profileId) {
      return request('change the profile', async () => {
        await ready();
        await changeProfile(sessionId, profileId);
      });
    },
```

```ts
    'session/start': (req) => manager.start(req.tabId, req.profileId),
    'session/set-profile': (req) => manager.setProfile(req.sessionId, req.profileId),
```

- [ ] **Step 13: Background tests.** Create `tests/background/profiles.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { starterProfiles } from '@lib/profiles';
import { getResult, putResult } from '@lib/storage/resultStore';
import { getSession } from '@lib/storage/sessionStore';
import { sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { configure, MEET_CODE, resultFor, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const CLIENT = { ...starterProfiles('client-db')[0]!, id: 'client', name: 'Client meeting' };

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  // Auto-transcribe off: each test starts the jobs itself, so a profile change never meets a running job.
  await configure({ profiles: [...starterProfiles('team-db', 'personal-db'), CLIENT], defaultProfileId: 'team', autoTranscribe: false });
  m = h.createManager();
  await m.boot();
});

describe('profiles', () => {
  it('records for the profile chosen in the popup, or the default', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    expect((await getSession(ID))?.profileId).toBe('client');
  });

  it('falls back to the default profile for an unknown id', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'gone');
    expect((await getSession(ID))?.profileId).toBe('team');
  });

  it('sends the profile with the jobs and saves to its database', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    await m.stop(ID);
    await m.route(ID, 'team'); // routing window, until Task 10 removes it
    await m.setProfile(ID, 'client');
    await m.transcribe(ID);
    await m.idle();
    expect(h.offscreen.callsOf('offscreen/process')[0]?.profile.id).toBe('client');
    expect(h.offscreen.callsOf('offscreen/save')[0]?.profile.databaseId).toBe('client-db');
  });

  it('summarizes again, without transcribing, when the profile changed after transcription', async () => {
    h.offscreen.save = () => ({ status: 'error', error: 'Notion is busy right now. Try again in a minute.' });
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'team');
    await m.stop(ID);
    await m.route(ID, 'team');
    await m.transcribe(ID);
    await m.idle(); // processed with Team, save failed
    expect((await getResult(ID))?.profile?.id).toBe('team');

    await m.setProfile(ID, 'client');
    await m.save(ID);
    await m.idle();
    const processes = h.offscreen.callsOf('offscreen/process');
    expect(processes).toHaveLength(2);
    expect(processes[1]?.reuse?.profile?.id).toBe('team');
    expect(processes[1]?.profile.id).toBe('client');
  });

  it('asks for another profile when the meeting’s was deleted', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId, 'client');
    await m.stop(ID);
    await m.route(ID, 'personal');
    await m.setProfile(ID, 'client');
    await configure({ profiles: starterProfiles('team-db', 'personal-db') });
    await m.transcribe(ID);
    expect(await getSession(ID)).toMatchObject({ status: 'failed', error: 'This meeting’s profile was deleted. Choose another profile.' });
  });

  it('refuses an unknown profile and a meeting on its way to Notion', async () => {
    const tabId = await h.openMeetTab();
    await m.start(tabId);
    await expect(m.setProfile(ID, 'gone')).rejects.toThrow('That profile no longer exists. Reload the page and choose another.');
  });
});
```

Make the harness's fake `process` keep what it's given: `resultFor(job, createdAt)` should include `profile: { id: job.profile.id, name: job.profile.name }` and, for a job with `reuse`, return `{ ...job.reuse, profile: { id: job.profile.id, name: job.profile.name } }`. Update `resultFor` in `tests/background/harness.ts` accordingly.

- [ ] **Step 14: Update the other tests**

Run: `pnpm typecheck`
Then fix every error: jobs built with `route` get `profile: testProfile()` (or the harness's profile); calls to `missingForSave`/`missingSettings`/`setupProblems` pass a profile; `notes.saved(meta, now)` becomes `notes.saved(meta, 'Team', now)`; `setupSentence(gaps)` gets the profile name; popup models get `profiles` and `defaultProfileId`. Expectations that read "the Team database" for a missing database now read "the Team profile’s database".

- [ ] **Step 15: Run everything**

Run: `pnpm typecheck && pnpm test:node && pnpm vitest run --project browser tests/ui/popupView.browser.test.ts tests/ui/dashboardView.browser.test.ts tests/ui/routingView.browser.test.ts`
Expected: PASS.

- [ ] **Step 16: Commit**

```bash
git add src entrypoints tests
git commit -m "feat: send each meeting's profile with its jobs" -m "A meeting stores the profile it was recorded for; the pipeline checks and saves to that profile's database, adds its vocabulary and writes its sections. Changing the profile of a transcribed meeting summarizes the stored transcript again instead of transcribing. A deleted profile leaves the meeting waiting for another."
```

---

### Task 8: Meetings page chooses profiles

**Files:**
- Modify: `src/lib/ui/sessionView.ts`, `src/lib/ui/dashboardView.ts`, `entrypoints/dashboard/main.ts`, `src/lib/ui/css/meetings.css`
- Test: `tests/ui/sessionView.test.ts`, `tests/ui/dashboardView.browser.test.ts`, `tests/ui/dashboardFixtures.ts`, `tests/ui/dashboardMenu.browser.test.ts`

Behaviour:
- A row shows its profile's name where it showed Team or Personal (`routeName` becomes `profileName`). A meeting whose profile no longer exists shows no name.
- The `Team | Personal` segmented control goes. A row that needs a profile shows **Choose profile** as its primary button: `awaiting-route` (with `then: 'transcribe'`, which also ends the wait until Task 10 removes it) and failed with `problems.profileDeleted` (with `then` as for Try again); a `ready` row shows its profile as a bordered button with a chevron (`Client meeting ⌄`). Both open the page's ⋯ menu with one checked item per profile.
- The ⋯ menu's `Save to Personal instead` becomes **Change profile…**, available when the background accepts it (`recording`, `awaiting-route`, `ready`, `failed`, `processed`, `empty`, `duplicate`). It re-opens the same menu, anchored to ⋯, with the profile list.
- Picking a profile sends `session/set-profile`, then, for a row with a stored result or a failed transcription, what `then` says (save when a result is stored, else transcribe), the way reroute did. A `ready` or `recording` row only changes the profile.
- `defaultRouteText` and the route note stay until Task 10, fed from the default profile's name.

- [ ] **Step 1: Failing view-model tests.** In `tests/ui/sessionView.test.ts`, replace the reroute cases with:

```ts
describe('profiles on a row', () => {
  const names = new Map([['team', 'Team'], ['client', 'Client meeting']]);

  it('shows the profile name', () => {
    expect(sessionRow(meta({ status: 'saved', profileId: 'client' }), { now: NOW, profileNames: names }).profileName).toBe('Client meeting');
    expect(sessionRow(meta({ status: 'saved', profileId: 'gone' }), { now: NOW, profileNames: names }).profileName).toBeUndefined();
  });

  it('offers Change profile… where the background accepts it, then the next step', () => {
    const processed = rowActions(meta({ status: 'processed', profileId: 'team' }), { hasResult: true });
    expect(processed.menu.find((a) => a.kind === 'change-profile')).toMatchObject({ label: 'Change profile…', then: 'save' });
    const failed = rowActions(meta({ status: 'failed', profileId: 'team', error: 'Transcribing stopped before it finished. Try again.' }), { hasResult: false });
    expect(failed.menu.find((a) => a.kind === 'change-profile')?.then).toBe('transcribe');
    const ready = rowActions(meta({ status: 'ready' }), { hasResult: false });
    expect(ready.menu.find((a) => a.kind === 'change-profile')?.then).toBeUndefined();
    const saved = rowActions(meta({ status: 'saved', notion: { pageId: 'p', url: 'u' } }), { hasResult: true });
    expect(saved.menu.some((a) => a.kind === 'change-profile')).toBe(false);
  });

  it('makes Choose profile the next step when the profile was deleted', () => {
    const m = meta({ status: 'failed', profileId: 'gone', error: 'This meeting’s profile was deleted. Choose another profile.' });
    expect(rowActions(m, { hasResult: true }).primary).toMatchObject({ kind: 'choose-profile', label: 'Choose profile', then: 'save' });
    expect(statusView(m)).toEqual({ tone: 'caution', label: 'Choose a profile' });
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project node tests/ui/sessionView.test.ts`
Expected: FAIL.

- [ ] **Step 3: sessionView.** In `src/lib/ui/sessionView.ts`:
  - `RowActionKind`: replace `'reroute'` with `'change-profile' | 'choose-profile'`. `RowAction`: replace `route?: Route` with nothing (the page supplies the list); keep `then`.
  - Add `const PROFILE_CHANGEABLE = new Set<SessionStatus>(['recording', 'awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);` and export `canChangeProfile(meta)`.
  - Add `export function profileMissing(meta: Pick<SessionMeta, 'status' | 'error'>): boolean { return meta.status === 'failed' && meta.error === PROFILE_DELETED; }` with `const PROFILE_DELETED = 'This meeting’s profile was deleted. Choose another profile.';` (the same words as `problems.profileDeleted`; the pages can't import background code).
  - `statusView`: first thing in `case 'failed'`: `if (profileMissing(meta)) return { tone: 'caution', label: 'Choose a profile' };`
  - `rowActions`: replace `reroute()` with

```ts
  const changeProfile = (then?: 'save' | 'transcribe') => act('change-profile', 'Change profile…', then ? { then } : {});
```

    use `changeProfile(next)` where `reroute()` was (processed, duplicate, failed), `changeProfile()` for `ready` and `recording` (menu, before Delete…), `primary = act('choose-profile', 'Choose profile', { then: 'transcribe' })` for `awaiting-route`, and for a missing profile:

```ts
    case 'failed': {
      if (profileMissing(meta)) {
        primary = act('choose-profile', 'Choose profile', { then: next });
        break;
      }
      // … existing branches, with changeProfile(next) in place of reroute()
```

  - `SessionRowView.routeName` → `profileName?: string`; `sessionRow` options gain `profileNames?: ReadonlyMap<string, string>` and set `if (meta.profileId && opts.profileNames?.has(meta.profileId)) row.profileName = opts.profileNames.get(meta.profileId);`
  - `routeChoice` now returns `'required' | null` (required only for `awaiting-route`); `routeLabel` stays for `defaultRouteText` until Task 10.

- [ ] **Step 4: Run the view-model tests**

Run: `pnpm vitest run --project node tests/ui/sessionView.test.ts`
Expected: PASS after updating older expectations that used `reroute` or `routeName`.

- [ ] **Step 5: dashboardView.** In `src/lib/ui/dashboardView.ts`:
  - `DashboardData`: replace `defaultRoute?: Route` with `profiles: readonly Pick<Profile, 'id' | 'name'>[]; defaultProfileId: string;`.
  - `DashboardHandlers`: replace `route(sessionId, route)` with `setProfile(sessionId: string, profileId: string): Promise<void>;`.
  - Remove `entry.segmented`, `chooseRoute`, `choices`, and the segmented block in `patchRow`. Keep `entry.route` as the slot for the profile button.
  - Add the profile menu:

```ts
  /** The profiles as checked menu items; picking one sets it, then carries the meeting on (`then`). */
  function profileItems(entry: RowEntry, then?: 'save' | 'transcribe'): MenuItem[] {
    const d = data!;
    return d.profiles.map((p) => ({
      label: p.name,
      checked: p.id === entry.meta.profileId,
      attrs: { 'data-key': `${entry.id}:profile-${p.id}` },
      onSelect: () => chooseProfile(entry, p.id, then),
    }));
  }

  function chooseProfile(entry: RowEntry, profileId: string, then?: 'save' | 'transcribe'): void {
    const id = entry.id;
    if (profileId === entry.meta.profileId && !then) return;
    run(id, async () => {
      await handlers.setProfile(id, profileId);
      if (then === 'save') await handlers.save(id, {});
      else if (then === 'transcribe') await handlers.transcribe(id, {});
    });
  }

  function openProfiles(entry: RowEntry, anchor: HTMLElement, then: 'save' | 'transcribe' | undefined, focus: 'first' | 'last' | 'menu'): void {
    menu.open(anchor, profileItems(entry, then), {
      focus,
      signature: `profiles:${JSON.stringify(data?.profiles)}:${entry.meta.profileId}`,
      label: `Profile for ${entry.view.title}`,
    });
  }
```

  - In `perform`, `case 'change-profile'` and `case 'choose-profile'` call `openProfiles(entry, action.kind === 'choose-profile' ? entry.primary : entry.more, action.then, 'first')`. (A menu item's `onSelect` runs after the menu closed and focus went back to ⋯, so re-opening it there is safe.)
  - A `ready` row gets a profile button in `entry.route`, built once per row and patched: `button([h('span', { class: 'meeting-profile-name' }, name), svg('chevron')], { kind: 'bordered', class: 'meeting-profile', attrs: { ...menuButtonAttrs(menu), 'data-key': `${id}:profile` }, onClick: (e) => openProfiles(entry, profileButton, undefined, e.detail === 0 ? 'first' : 'menu') })`, with `menuButtonKeys` on keydown, `aria-label` "Profile: Client meeting", disabled while the row is pending. It is shown only for `ready`, and the detail line then leaves the profile name out (it's on the button).
  - Close an open profile menu when its signature is stale, the same way the ⋯ menu does.
  - Needs you: `routeNote` uses `defaultRouteText(defaultProfileName, meta.routeDeadline, format)` where `routeLabel` is replaced by the profile's name; change `defaultRouteText(route: Route, …)` to take the name string.

  `entrypoints/dashboard/main.ts`: `setProfile: (sessionId, profileId) => sendToBackground('session/set-profile', { sessionId, profileId })`, and pass `profiles: settings.profiles.map(({ id, name }) => ({ id, name }))`, `defaultProfileId`, and `profileNames` (a `Map` built from the profiles) through to `sessionRow`.

  CSS (`src/lib/ui/css/meetings.css`): `.meeting-profile` is a compact bordered capsule (reuse the `.segmented` height); the chevron is 0.8em and `--label-2`.

- [ ] **Step 6: Browser tests.** In `tests/ui/dashboardView.browser.test.ts` replace the Team | Personal tests with:

```ts
describe('profiles', () => {
  const profiles = [{ id: 'team', name: 'Team' }, { id: 'client', name: 'Client meeting' }];

  it('shows a ready meeting’s profile as a button that opens the profile list', async () => {
    const { root, handlers } = mountDashboard({ sessions: [meta({ id: 'r', status: 'ready', profileId: 'team' })], profiles });
    const button = root.querySelector<HTMLButtonElement>('[data-key="r:profile"]')!;
    expect(button.textContent).toBe('Team');
    button.click();
    const items = [...document.querySelectorAll('.menu .menu-item')];
    expect(items.map((i) => [i.textContent, i.getAttribute('aria-checked')])).toEqual([['Team', 'true'], ['Client meeting', 'false']]);
    (items[1] as HTMLElement).click();
    await settle();
    expect(handlers.setProfile).toHaveBeenCalledWith('r', 'client');
    expect(handlers.transcribe).not.toHaveBeenCalled();
  });

  it('changes a transcribed meeting’s profile from ⋯, then saves', async () => {
    const { root, handlers } = mountDashboard({ sessions: [meta({ id: 'p', status: 'processed', profileId: 'team' })], resultIds: new Set(['p']), profiles });
    root.querySelector<HTMLButtonElement>('[data-key="p:more"]')!.click();
    document.querySelector<HTMLElement>('[data-key="menu:change-profile"]')!.click();
    document.querySelector<HTMLElement>('[data-key="p:profile-client"]')!.click();
    await settle();
    expect(handlers.setProfile).toHaveBeenCalledWith('p', 'client');
    expect(handlers.save).toHaveBeenCalledWith('p', {});
  });

  it('asks for a profile when the meeting’s was deleted', () => {
    const m = meta({ id: 'f', status: 'failed', profileId: 'gone', error: 'This meeting’s profile was deleted. Choose another profile.' });
    const { root } = mountDashboard({ sessions: [m], profiles });
    expect(root.querySelector('[data-key="f:primary"]')?.textContent).toBe('Choose profile');
    expect(root.querySelector('[data-cell="status"]')?.textContent).toContain('Choose a profile');
  });
});
```

(`mountDashboard`, `meta` and `settle` are the file's existing helpers; extend `mountDashboard`'s data with `profiles` and `defaultProfileId: 'team'` defaults and its handlers with a `setProfile` mock.) Update `tests/ui/dashboardFixtures.ts` and `tests/visual/dashboard.shots.ts` to pass `profiles` and `defaultProfileId`.

- [ ] **Step 7: Run tests**

Run: `pnpm typecheck && pnpm test:node && pnpm vitest run --project browser tests/ui/dashboardView.browser.test.ts tests/ui/dashboardMenu.browser.test.ts tests/ui/dashboardLayout.browser.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui entrypoints/dashboard tests/ui tests/visual
git commit -m "feat: choose and change profiles on Meetings" -m "Rows name their profile. A meeting not yet transcribed shows its profile as a button; Change profile… in ⋯ picks another and carries the meeting on, and a meeting whose profile was deleted asks for one."
```

---

### Task 9: Popup profile row

**Files:**
- Modify: `src/lib/ui/popupView.ts`, `entrypoints/popup/main.ts`, `src/lib/ui/css/popup.css`
- Test: `tests/ui/popupView.test.ts`, `tests/ui/popupView.browser.test.ts`, `tests/visual/popup.shots.ts`

Behaviour:
- On a call (idle) and while recording, a **Profile** fact sits above the hero button: label "Profile", value = a plain button with the profile name and a chevron, opening a menu of checked profiles (create one `createMenu(root)` for the popup).
- Idle: the choice is local to the popup (`selectedProfileId`, starting at `defaultProfileId`, kept in `sessionStorage` under `manet:popup-profile` so reopening the popup within the browser session keeps it). *Record this call* calls `handlers.record(tabId, selectedProfileId)`.
- Recording: the value is the session's profile; choosing sends `handlers.setProfile(sessionId, profileId)`. `PopupState` recording gets `profileId?: string` from the meta.
- Recent rows show the profile name where they showed Team or Personal: `recentRow(meta, now, opts, profileNames?)`.
- The hero hint while recording reads "It’s transcribed when the call ends." once Task 10 lands; in this task leave it, but change the "Stopped" note to "Stopped. Choose Team or Personal in the window that opened." only if the routing window still opens (it does until Task 10).

- [ ] **Step 1: Failing tests.** In `tests/ui/popupView.test.ts`:

```ts
describe('recentRow with profiles', () => {
  it('names the profile', () => {
    const names = new Map([['client', 'Client meeting']]);
    const row = recentRow(meta({ status: 'saved', profileId: 'client', notion: { pageId: 'p', url: 'u' } }), NOW, {}, names);
    expect(row.details).toContain('Client meeting');
  });
});
```

In `tests/ui/popupView.browser.test.ts`:

```ts
describe('the Profile row', () => {
  const profiles = [{ id: 'team', name: 'Team' }, { id: 'client', name: 'Client meeting' }];

  it('records with the profile picked in the popup', async () => {
    const { root, handlers, update } = mountPopup({ state: idle(), profiles, defaultProfileId: 'team' });
    const row = root.querySelector<HTMLButtonElement>('[data-key="profile"]')!;
    expect(row.textContent).toBe('Team');
    row.click();
    document.querySelector<HTMLElement>('[data-key="profile-client"]')!.click();
    update();
    expect(root.querySelector('[data-key="profile"]')!.textContent).toBe('Client meeting');
    root.querySelector<HTMLButtonElement>('[data-key="record"]')!.click();
    expect(handlers.record).toHaveBeenCalledWith(TAB_ID, 'client');
  });

  it('changes the profile of the recording', async () => {
    const { root, handlers } = mountPopup({ state: recording({ profileId: 'team' }), profiles, defaultProfileId: 'team' });
    root.querySelector<HTMLButtonElement>('[data-key="profile"]')!.click();
    document.querySelector<HTMLElement>('[data-key="profile-client"]')!.click();
    expect(handlers.setProfile).toHaveBeenCalledWith(SESSION_ID, 'client');
  });

  it('hides the row when there is only one profile', () => {
    const { root } = mountPopup({ state: idle(), profiles: [profiles[0]!], defaultProfileId: 'team' });
    expect(root.querySelector('[data-key="profile"]')).toBeNull();
  });
});
```

(Use the file's existing helpers for mounting, states and ids; add `setProfile` to the handler mocks and `profiles`/`defaultProfileId` to the model defaults.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project browser tests/ui/popupView.browser.test.ts` and `pnpm vitest run --project node tests/ui/popupView.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `src/lib/ui/popupView.ts`:
  - `PopupHandlers.record(tabId: number, profileId: string): Promise<void>;` and `setProfile(sessionId: string, profileId: string): Promise<void>;`.
  - `popupState` copies `session.profileId` into the recording state.
  - A persistent Profile row element created once (like the hero), inserted before `heroBlock`, patched by `renderProfile(m, s)`: hidden unless `s.kind` is `idle` or `recording` and `m.profiles.length > 1`; the button's text is `profileName(m, current)` where `current` is `s.profileId` while recording, else `selectedProfileId ?? m.defaultProfileId`; clicking opens the menu with `m.profiles.map((p) => ({ label: p.name, checked: p.id === current, attrs: { 'data-key': `profile-${p.id}` }, onSelect: () => pick(p.id) }))`.
  - `pick(id)`: idle → `selectedProfileId = id`, save to `sessionStorage` (try/catch), re-render; recording → `run('profile', () => handlers.setProfile(s.sessionId, id))` using the existing request/error plumbing so a failure shows in the hero error line.
  - `onHero` record: `handlers.record(s.tabId, selectedProfileId ?? m.defaultProfileId)`; if the stored selection names a profile that no longer exists, use the default.
  - `recentRow(meta, now, opts = {}, profileNames?: ReadonlyMap<string, string>)`: `const where = (meta.profileId && profileNames?.get(meta.profileId)) || null;` replaces `route`.

  `entrypoints/popup/main.ts`: `record: async (tabId, profileId) => { await startRecording(tabId, profileId); await refresh(); }`, `setProfile: (sessionId, profileId) => sendToBackground('session/set-profile', { sessionId, profileId })`, and pass the profile names for Recent.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run --project node tests/ui/popupView.test.ts && pnpm vitest run --project browser tests/ui/popupView.browser.test.ts`
Expected: PASS. Popups are 600 px tall at most: `tests/ui/popupView.browser.test.ts` has height checks; if the extra row pushes a state past them, tighten the row (fact rows are one line) rather than relaxing the check.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/popupView.ts src/lib/ui/css/popup.css entrypoints/popup tests/ui tests/visual/popup.shots.ts
git commit -m "feat: pick the profile in the popup" -m "A Profile row above Record this call starts with the default profile and can change it before or during the recording. Recent names each meeting's profile."
```

---

### Task 10: Remove the routing window and the awaiting-route status

**Files:**
- Delete: `entrypoints/routing/`, `src/lib/ui/routingView.ts`, `src/lib/ui/css/routing.css`, `tests/ui/routingView.test.ts`, `tests/ui/routingView.browser.test.ts`, `tests/ui/routingLayout.browser.test.ts`, `tests/background/routeHold.test.ts`, `tests/visual/routing.shots.ts`
- Modify: `src/lib/types.ts`, `src/lib/messages.ts`, `src/lib/storage/sessionStore.ts`, `entrypoints/background/{sessionManager,chromeDeps,index,copy}.ts`, `src/lib/ui/{sessionView,dashboardView,popupView}.ts`, `entrypoints/dashboard/main.ts`, `tests/background/{lifecycle,recovery,index,toolbar,actionState}.test.ts`, `tests/storage/sessionStore.test.ts`, `tests/ui/*`

- [ ] **Step 1: Failing lifecycle tests.** In `tests/background/lifecycle.test.ts`, change the main lifecycle test so the meeting goes `recording → ready → processing → saving → saved` with no `m.route` call, and add:

```ts
  it('transcribes as soon as the call ends, with auto-transcribe on', async () => {
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(h.windowsCreated()).toEqual([]); // no routing window
    expect((await getSession(ID))?.status).toBe('saved');
  });

  it('waits for Transcribe with auto-transcribe off', async () => {
    await configure({ autoTranscribe: false });
    const tabId = await record();
    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', profileId: 'team' });
  });
```

(`h.windowsCreated()` is a small harness helper returning the `browser.windows.create` calls the fake saw; add it to `tests/background/harness.ts` if the harness has no such accessor.) In `tests/background/recovery.test.ts`, orphaned recordings end in `ready` (then auto-transcribe), never `awaiting-route`, and there is no routing window. In `tests/storage/sessionStore.test.ts`:

```ts
  it('reads a meeting left waiting for Team or Personal as ready', async () => {
    await fakeBrowser.storage.local.set({ [sessionKey('s')]: { ...meta({ id: 's' }), status: 'awaiting-route', route: 'team', routeDeadline: 5 } });
    expect(await getSession('s')).toMatchObject({ status: 'ready', profileId: 'team' });
    expect((await getSession('s'))?.routeDeadline).toBeUndefined();
  });
```

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project node tests/background/lifecycle.test.ts tests/storage/sessionStore.test.ts`
Expected: FAIL (the meeting stops at `awaiting-route`).

- [ ] **Step 3: Types and storage.** In `src/lib/types.ts` remove `'awaiting-route'` from `SessionStatus` and `routeDeadline` from `SessionMeta`. Keep `route?: Route` (read by `normalizeMeta` only; Task 14 removes it). In `sessionStore.ts`:

```ts
/** What versions before profiles stored on a meta. */
type LegacyMeta = Omit<SessionMeta, 'status'> & { status: SessionStatus | 'awaiting-route'; routeDeadline?: number };

/**
 * A meta as any version stored it: a meeting from before profiles takes its Team |
 * Personal destination as its profile, and one left waiting for that choice reads as
 * ready (its leftover route alarm fires once and is ignored).
 */
export function normalizeMeta(stored: SessionMeta): SessionMeta {
  const meta = stored as LegacyMeta;
  if (meta.status !== 'awaiting-route' && meta.routeDeadline === undefined && (meta.profileId !== undefined || meta.route === undefined)) {
    return stored;
  }
  const { routeDeadline: _deadline, ...rest } = meta;
  return {
    ...rest,
    status: meta.status === 'awaiting-route' ? 'ready' : meta.status,
    ...(meta.profileId === undefined && meta.route !== undefined ? { profileId: meta.route } : {}),
  } as SessionMeta;
}
```

`WAITING_ON_YOU` becomes `new Set<SessionStatus>(['processed'])`, and the `needsYou` comment drops "it waits for Team or Personal".

- [ ] **Step 4: Background.** In `entrypoints/background/sessionManager.ts`:
  - Delete `ROUTE_DELAY_MS`, `ROUTE_ALARM_PREFIX`, `ROUTING_PREFIX`, `RoutingPrompt`, `withRouteDeadline`, `routeAlarm`, `askForRoute`, `armRouteAlarm`, `clearRouteAlarm`, `routing`, `setRouting`, `forgetRouting`, `isHeld`, `routingOps`/`routingOp`, `holdRoute`, `resumeRoute`, `applyRoute`, `applyDefaultRoute`, `REROUTABLE`, the `route`, `routeHold` and `onWindowRemoved` methods, `openRoutingPrompt` from `SessionManagerDeps`, and every call to them (`transcribeNow`'s `clearRouteAlarm`, `removeSession`'s route cleanup, `restoreAlarms`' awaiting-route branch, `onAlarm`'s route branch).
  - `TRANSCRIBABLE` loses `'awaiting-route'`; `PROFILE_CHANGEABLE` too.
  - `endRecording`: the session goes to `ready`, and auto-transcribe starts outside the lifecycle chain:

```ts
    await updateSession(id, (m) => {
      if (m.status !== 'recording') return m;
      ended = true;
      const audio = withCounts(m.audio, counts);
      return {
        ...m,
        status: 'ready',
        endedAt,
        durationMs: Math.max(0, endedAt - m.startedAt),
        audio: recorderError && !audio.error ? { ...audio, error: recorderError } : audio,
      };
    });
    if (ended) track(autoTranscribe(id));
```

```ts
  /** With auto-transcribe on, a meeting that just ended is transcribed and saved. */
  async function autoTranscribe(id: string): Promise<void> {
    if (!(await deps.getSettings()).autoTranscribe) return;
    await transcribeNow(id).catch((err: unknown) => warn('Auto-transcribe failed:', err));
  }
```

  - `recoverRecordings`: orphans become `{ ...m, status: 'ready', recovered: true, endedAt, durationMs }` and are returned as before; `runBoot` then runs `track(autoTranscribe(id))` for each recovered id after `restoreAlarms`.
  - `adoptOrphanAudio`: `profileId: defaultProfile(settings).id` in place of `route`.
  - Keep setting `route` nowhere; `transcribeNow`/`saveNow` stop writing `route`.
  - `onAlarm` ignores names it doesn't know (old `route:` alarms).
  - Messages: remove `'session/route'` and `'session/route-hold'` from `BackgroundProtocol` and `backgroundHandlers`.
  - `copy.ts`: delete `problems.cannotRoute` and `routeName`; `Meeting` picks `'startedAt' | 'durationMs'`.
  - `chromeDeps.ts`: delete `openRoutingPrompt`. `index.ts`: delete the `windows.onRemoved` listener.

- [ ] **Step 5: Pages.** Remove every `'awaiting-route'` case and the routing words:
  - `sessionView.ts`: delete `routeChoice`, `routeLabel`, `defaultRouteText`, `canChooseRoute`, the `awaiting-route` cases; `TRANSCRIBABLE`/`PROFILE_CHANGEABLE` lose it; `SETTING_NAMES`' team/personal entry becomes `[/(team|personal) database/i, (m) => `the ${m[1]![0]!.toUpperCase()}${m[1]!.slice(1).toLowerCase()} database`]` so old records still read.
  - `dashboardView.ts`: delete `routeNote`, `entry.routeNote` and the "If you don’t choose…" line; the auto-transcribe hint becomes "Each meeting is transcribed and saved to Notion when the call ends."
  - `popupView.ts`: delete the `awaiting-route` case in `recentRow`, the "Stopped. Choose Team or Personal…" note (`renderStopped` and `stopped`), and change the recording hint to "It’s transcribed when the call ends." (or, with auto-transcribe off in the model, "You’ll find it in Meetings."; add `autoTranscribe: boolean` to `PopupModel`, filled from settings).
  - `entrypoints/dashboard/main.ts`: drop the routeDeadline comment.
  - Delete the files listed above and remove their imports.

- [ ] **Step 6: Run everything**

Run: `pnpm typecheck && pnpm test:node && pnpm test:browser`
Expected: PASS. Fix tests that still expect `awaiting-route`, the routing window or route alarms by expecting the new flow; delete tests that only covered the routing window.

- [ ] **Step 7: Commit**

```bash
git add -A src entrypoints tests
git commit -m "feat: start transcribing when the call ends" -m "The profile is chosen before recording, so the Team | Personal window, its countdown and the waiting state go. A recording that ends, or is recovered after a crash, is transcribed right away with auto-transcribe on. Meetings left waiting by an older version read as not transcribed."
```

### Task 11: Profile editor view

A standalone view module, tested on its own; Task 12 puts it on the Settings page.

**Files:**
- Create: `src/lib/ui/profileEditorView.ts`, `tests/ui/profileEditorView.browser.test.ts`
- Modify: `src/lib/ui/settingsForm.ts` (export `databaseCheckMessage`), `src/lib/ui/css/settings.css`

**Interface:**

```ts
export interface ProfileEditorHandlers {
  /** Stores `profile` in place of the one with its id; resolves to the stored settings. */
  save(profile: Profile): Promise<Settings>;
  /** Deletes the profile; resolves to the stored settings. */
  remove(profileId: string): Promise<Settings>;
  makeDefault(profileId: string): Promise<Settings>;
  /** Checks a database with the stored Notion token (notion/verify.ts verifyDatabase). */
  verifyDatabase(databaseId: string): Promise<VerifyResult>;
  /** Back to Settings. */
  back(): void;
}

export type ProfileField = 'name' | 'databaseId' | 'prompt' | 'vocabulary';

export interface ProfileEditorView {
  readonly element: HTMLElement;
  /** Shows the profile from these settings; a field being edited keeps its edit. */
  load(settings: Settings): void;
  focus(field: ProfileField): void;
  /** Commits edits still in their fields; true while anything is unsaved. */
  flush(): boolean;
}

export function createProfileEditorView(
  profileId: string,
  handlers: ProfileEditorHandlers,
  timing?: Partial<{ savedMs: number; fadeMs: number }>,
): ProfileEditorView;
```

**Layout** (grouped rows, same classes as Settings: `section()`, `field()`, `textInput()`, `switchInput()`, `segmented()`, `button()` from `controls.ts`):

```
‹ Settings                                    back button (kind: 'plain', data-key="back")
Client meeting                                h1, follows the saved name
[Profile]      Name                  [Client meeting          ]
               Notion database       [link…            ] [Check]
               Use as default        (switch)  hint: "Preselected in the popup and used by the keyboard shortcut."
[Notes]        Prompt                [textarea 4 rows]    hint: "What these meetings are, and how to write their notes."
               Section rows, each:   Title [      ]  [Paragraph | Bullets]
                                     Instruction [textarea 2 rows]
                                     Move up · Move down · Remove        (plain buttons)
               [Add section]                                  disabled at 12, note "Up to 12 sections."
               "Action items are always added after the sections."   (hint)
[Transcription] Vocabulary           [textarea] hint: "Added to the vocabulary in Settings for these meetings only."
[Delete profile…]                     link-style destructive button; inline confirm
```

**Rules:**
- A field commits on blur, on Enter in an input, and on Ctrl/⌘+Enter in a textarea; Esc restores the saved value. The commit builds a candidate profile with only that field changed (section fields: that section's title or instruction), checks it with `profileProblems(candidate, settings.profiles)`, and writes nothing when there's a problem: the first problem shows under the field (`setFieldMessage(fieldEl, text, 'caution')`). A value equal to the saved one writes nothing.
- Vocabulary parses with `parseVocabulary` from `settingsForm.ts`.
- Format, Add section, Move up/down and Remove save at once. Remove asks nothing (a section is cheap to re-add). Move up is disabled on the first section, Move down on the last.
- A successful save shows "✓ Saved" beside the field label for `savedMs` (2 s), then fades, as Settings does (copy the `savedSlot`/`flashSaved` pattern from `optionsView.ts`).
- Check runs `handlers.verifyDatabase(field value)` and shows `databaseCheckMessage(result)` under the database field (done or caution). With an empty field it says "Paste the database link first."
- *Use as default* is on and disabled for the default profile; turning it on for another calls `makeDefault`.
- *Delete profile…* is disabled with the note "Make another profile the default first." for the default profile. Otherwise it swaps itself for "Delete “Client meeting”? Meetings recorded with it will ask for another profile." with Cancel and Delete; Delete calls `remove`, then `back()`.
- `load()` with settings that no longer have the profile (deleted in another tab) shows "This profile was deleted." and a Back button.
- Every control gets a `data-key` (`name`, `databaseId`, `check`, `default`, `prompt`, `vocabulary`, `section-<id>-title`, `section-<id>-format`, `section-<id>-instruction`, `section-<id>-up`, `section-<id>-down`, `section-<id>-remove`, `add-section`, `delete`, `delete-confirm`, `delete-cancel`).

In `src/lib/ui/settingsForm.ts`, rename the private `databaseMessage` to an exported `databaseCheckMessage(result: VerifyResult | null): CheckMessage` whose empty-result text is "No database yet. Add one to save meetings with this profile." (Task 12 removes `notionCheckMessages`.)

- [ ] **Step 1: Failing tests.** Create `tests/ui/profileEditorView.browser.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Profile, Settings } from '@lib/types';
import { createProfileEditorView, type ProfileEditorHandlers } from '@lib/ui/profileEditorView';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';

function setup(profiles: Profile[] = starterProfiles(DB, ''), id = 'personal') {
  let settings: Settings = normalizeSettings({ profiles, defaultProfileId: 'team', notionToken: 'ntn_x' });
  const replace = (next: Settings) => {
    settings = next;
    return Promise.resolve(next);
  };
  const handlers: ProfileEditorHandlers = {
    save: vi.fn((p: Profile) => replace({ ...settings, profiles: settings.profiles.map((q) => (q.id === p.id ? p : q)) })),
    remove: vi.fn((pid: string) => replace({ ...settings, profiles: settings.profiles.filter((q) => q.id !== pid) })),
    makeDefault: vi.fn((pid: string) => replace({ ...settings, defaultProfileId: pid })),
    verifyDatabase: vi.fn(async () => ({ ok: true as const, title: 'Personal meetings' })),
    back: vi.fn(),
  };
  const view = createProfileEditorView(id, handlers, { savedMs: 10, fadeMs: 1 });
  document.body.append(view.element);
  view.load(settings);
  const el = <T extends HTMLElement>(key: string) => view.element.querySelector<T>(`[data-key="${key}"]`)!;
  const type = (key: string, value: string) => {
    const input = el<HTMLInputElement | HTMLTextAreaElement>(key);
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { view, handlers, el, type, settle, get: () => settings };
}

afterEach(() => document.body.replaceChildren());

describe('profile editor', () => {
  it('saves a renamed profile on blur', async () => {
    const { handlers, type, settle, view } = setup();
    type('name', 'Weekly meeting');
    await settle();
    expect(handlers.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'personal', name: 'Weekly meeting' }));
    expect(view.element.querySelector('h1')?.textContent).toBe('Weekly meeting');
  });

  it('refuses a name another profile has, and says why under the field', async () => {
    const { handlers, type, settle, view } = setup();
    type('name', 'team');
    await settle();
    expect(handlers.save).not.toHaveBeenCalled();
    expect(view.element.textContent).toContain('Another profile is already called “team”.');
  });

  it('adds, moves, reformats and removes sections', async () => {
    const { handlers, el, settle, get } = setup();
    el('add-section').click();
    await settle();
    expect(get().profiles[1]!.sections.map((s) => s.title)).toEqual(['Summary', 'Key points', 'Decisions', 'New section']);
    const added = get().profiles[1]!.sections[3]!;
    el(`section-${added.id}-up`).click();
    await settle();
    expect(get().profiles[1]!.sections[2]!.id).toBe(added.id);
    el(`section-${added.id}-format`).querySelector<HTMLElement>('[data-value="paragraph"]')!.click();
    await settle();
    expect(get().profiles[1]!.sections[2]!.format).toBe('paragraph');
    el(`section-${added.id}-remove`).click();
    await settle();
    expect(get().profiles[1]!.sections).toHaveLength(3);
    expect(handlers.save).toHaveBeenCalledTimes(4);
  });

  it('refuses a section called Action items', async () => {
    const { type, settle, view, get } = setup();
    const first = get().profiles[1]!.sections[0]!;
    type(`section-${first.id}-title`, 'Action items');
    await settle();
    expect(view.element.textContent).toContain('“Action items” is always added at the end.');
    expect(get().profiles[1]!.sections[0]!.title).toBe('Summary');
  });

  it('checks the database with the stored token', async () => {
    const { el, type, settle, handlers, view } = setup();
    type('databaseId', DB);
    await settle();
    el('check').click();
    await settle();
    expect(handlers.verifyDatabase).toHaveBeenCalledWith(DB);
    expect(view.element.textContent).toContain('“Personal meetings” is ready.');
  });

  it('makes a profile the default, and keeps the default from being deleted', async () => {
    const { el, settle, handlers } = setup();
    el<HTMLInputElement>('default').click();
    await settle();
    expect(handlers.makeDefault).toHaveBeenCalledWith('personal');
    const team = setup(starterProfiles(DB, ''), 'team');
    expect(team.el('delete').getAttribute('aria-disabled')).toBe('true');
    expect(team.view.element.textContent).toContain('Make another profile the default first.');
  });

  it('deletes after asking, then goes back', async () => {
    const { el, settle, handlers } = setup();
    el('delete').click();
    el('delete-confirm').click();
    await settle();
    expect(handlers.remove).toHaveBeenCalledWith('personal');
    expect(handlers.back).toHaveBeenCalled();
  });
});
```

(If `segmented()` marks options with something other than `data-value`, use its marker; check `controls.ts` `segmented`.)

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project browser tests/ui/profileEditorView.browser.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/ui/profileEditorView.ts`** following the interface, layout and rules above. Structure it as: a `commitField(key, build: (p: Profile) => Profile, fieldEl)` that validates and saves; `renderSections(profile)` that rebuilds the section rows only when the section ids, order or formats change (keep inputs being edited: compare `document.activeElement`); the delete confirm swapped in place. Keep it under ~450 lines; add its styles (section row card, the move/remove button row, the confirm box) to `src/lib/ui/css/settings.css` using the existing tokens.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run --project browser tests/ui/profileEditorView.browser.test.ts && pnpm vitest run --project node tests/ui/settingsForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/profileEditorView.ts src/lib/ui/settingsForm.ts src/lib/ui/css/settings.css tests/ui/profileEditorView.browser.test.ts
git commit -m "feat: add the profile editor" -m "Name, database with Check, prompt, sections (title, paragraph or bullets, instruction, order), vocabulary, default and delete. Fields save as they're committed and never store a profile that breaks a rule."
```

---

### Task 12: Settings lists the profiles

**Files:**
- Modify: `src/lib/ui/settingsForm.ts`, `src/lib/ui/optionsView.ts`, `entrypoints/options/main.ts`, `src/lib/ui/extension.ts` (PagePath), `src/lib/ui/popupView.ts` (GAP_FIELD), `src/lib/ui/css/settings.css`
- Test: `tests/ui/settingsForm.test.ts`, `tests/ui/optionsView.browser.test.ts`, `tests/visual/settings.shots.ts`

Behaviour:
- The Notion group keeps only the Token. A new **Profiles** group follows it: one row per profile (a full-width button, `data-key="profile-<id>"`): the name, a "Default" tag on the default, and under it the database line: the last check's title ("“Client meetings” is ready."), or a ▲ with the reason when the check failed, or "No database yet" (▲) when empty, or "Not checked" before any check. Then an **Add profile** row and a **Check databases** action (same button style as today's Check; checks every profile with a database, with the Token field's value, results on the rows; a token problem shows once under the Token field, as `notionCheckMessages` did).
- A row opens the editor: `handlers.openProfile(id)`; the page sets `location.hash = 'profile/<id>'`. Add profile saves `newProfile(settings.profiles)` and opens it.
- `options.html#profile/<id>` shows the editor (Task 11) in place of the groups, and `#profile/<id>/databaseId` focuses that field. Back sets the hash to empty and shows the groups again, scrolled to that profile's row. Leaving the editor (hash change, tab close) calls its `flush()` first.
- The Default destination segmented control and both database fields are gone. `settingsForm.ts` loses `notionTeamDbId`, `notionPersonalDbId`, `defaultRoute` from `SettingsFormValues`, `FIELDS` and `parseField`, and `notionCheckMessages`; `FieldName` becomes `keyof SettingsFormValues | 'profiles'`.
- The setup checklist: Your name, Notion token, **Database for <default profile name>** (key `profiles`, done when the default profile has a database; its link opens the default profile's editor at the database field), Gemini API key (optional).
- `MISSING_FIELDS` maps "profile’s database" and the old "team/personal database" names to `profiles`; `firstMissingField` can return `'profiles'`, and `openSettings('profiles')` opens Settings on the Profiles group. In `popupView.ts`, `GAP_FIELD.database` becomes `'profiles'`. `PagePath` gains `` `/options.html#profile/${string}` ``.

- [ ] **Step 1: Failing tests.** In `tests/ui/settingsForm.test.ts`, replace the database and default-route cases with:

```ts
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
```

In `tests/ui/optionsView.browser.test.ts`, replace the database-field and default-destination tests with:

```ts
describe('Profiles group', () => {
  it('lists the profiles with the default marked, and opens one', () => {
    const { root, handlers } = mountOptions(settingsWith({ profiles: starterProfiles(DB, ''), defaultProfileId: 'team' }));
    const rows = [...root.querySelectorAll('[data-key^="profile-"]')];
    expect(rows.map((r) => r.querySelector('.profile-row-name')?.textContent)).toEqual(['Team', 'Personal']);
    expect(rows[0]!.textContent).toContain('Default');
    expect(rows[1]!.textContent).toContain('No database yet');
    (rows[1] as HTMLElement).click();
    expect(handlers.openProfile).toHaveBeenCalledWith('personal');
  });

  it('adds a profile and opens it', async () => {
    const { root, handlers } = mountOptions(settingsWith({}));
    root.querySelector<HTMLButtonElement>('[data-key="add-profile"]')!.click();
    await settle();
    const saved = vi.mocked(handlers.update).mock.calls.at(-1)![0].profiles!;
    expect(saved.at(-1)!.name).toBe('New profile');
    expect(handlers.openProfile).toHaveBeenCalledWith(saved.at(-1)!.id);
  });

  it('checks every profile’s database and shows the result on its row', async () => {
    const { root, handlers } = mountOptions(settingsWith({ profiles: starterProfiles(DB, DB) }));
    vi.mocked(handlers.verifyNotion).mockResolvedValueOnce({ ok: true, title: 'Team meetings' }).mockResolvedValueOnce({ ok: false, problems: ['This database isn’t shared with your token.'] });
    root.querySelector<HTMLButtonElement>('[data-key="check-notion"]')!.click();
    await settle();
    expect(root.querySelector('[data-key="profile-team"]')!.textContent).toContain('“Team meetings” is ready.');
    expect(root.querySelector('[data-key="profile-personal"]')!.textContent).toContain('This database isn’t shared with your token.');
  });

  it('no longer shows database fields or a default destination', () => {
    const { root } = mountOptions(settingsWith({}));
    expect(root.querySelector('#notionTeamDbId, #notionPersonalDbId, [data-role="defaultRoute"]')).toBeNull();
  });
});
```

(`mountOptions`, `settingsWith`, `settle` and `DB` are the file's helpers; add `openProfile: vi.fn()` to its handlers.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm vitest run --project node tests/ui/settingsForm.test.ts && pnpm vitest run --project browser tests/ui/optionsView.browser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above:
  - `settingsForm.ts`: the removals, `FieldName`, `SetupItem.key` (`'displayName' | 'notionToken' | 'profiles' | 'geminiApiKey'`), `setupChecklist(s)` using `defaultProfile(s)`, `MISSING_FIELDS` entries for `profiles`, and `profileCheckMessages(results: Map<string, VerifyResult | null>): { token?: CheckMessage; profiles: Map<string, CheckMessage> }` in place of `notionCheckMessages` (token problem once, else `databaseCheckMessage` per profile).
  - `optionsView.ts`: `OptionsHandlers` gains `openProfile(profileId: string): void`; the view keeps `checks = new Map<string, CheckMessage>()` and re-renders the Profiles rows on `load()` and after a check; `Add profile` writes `{ profiles: [...stored.profiles, created] }` through the existing `write()` queue, then `handlers.openProfile(created.id)`; `focusField('profiles')` scrolls to and focuses the first row; the setup item `profiles` calls `handlers.openProfile(defaultProfile(stored).id)` with the database field (`openProfile(id, 'databaseId')`, so the handler takes an optional field).
  - `entrypoints/options/main.ts`: route on the hash. `#profile/<id>[/<field>]` hides the options root, creates (or reuses) a `createProfileEditorView(id, …)` in a sibling container, with handlers: `save` → `updateSettings({ profiles })`, `remove` → `updateSettings({ profiles: without })`, `makeDefault` → `updateSettings({ defaultProfileId })`, `verifyDatabase` → `verifyDatabase((await getSettings()).notionToken, databaseId)`, `back` → `location.hash = ''`. Any other hash keeps today's `focusFromHash`. `settingsItem.watch` also reloads an open editor. `beforeunload` flushes whichever view is showing.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm test:node && pnpm vitest run --project browser tests/ui/optionsView.browser.test.ts tests/ui/profileEditorView.browser.test.ts tests/ui/popupView.browser.test.ts tests/ui/dashboardView.browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui entrypoints/options tests/ui tests/visual/settings.shots.ts
git commit -m "feat: manage profiles in Settings" -m "A Profiles group replaces the Team and Personal database fields and the default destination: each profile's row shows its database check, Add profile creates one, and a row opens its editor. The setup checklist asks for the default profile's database."
```

---

### Task 13: Share: export and import a config

**Files:**
- Create: `src/lib/ui/shareView.ts`, `tests/ui/shareView.browser.test.ts`
- Modify: `src/lib/ui/optionsView.ts` (append the Share group), `entrypoints/options/main.ts`, `src/lib/ui/css/settings.css`

**Interface:**

```ts
export interface ShareHandlers {
  /** The stored settings, or null before they load. */
  current(): Settings | null;
  /** Stores the whole merged settings; resolves to what was stored. */
  apply(next: Settings): Promise<Settings>;
  /** Hands the file to the browser as a download. */
  download(fileName: string, text: string): void;
  /** After an import: check every profile's database. */
  imported(): void;
}

export function createShareView(handlers: ShareHandlers, options?: { now?: () => number; format?: FormatOptions }): { element: HTMLElement };
```

**Behaviour:**
- A **Share** group (`section({ title: 'Share', id: 'settings-share' })`) with two rows: "Export config…" and "Import config…" (bordered buttons, `data-key="export"` / `data-key="import"`), hint: "Give everyone the same profiles and settings. Your name and meetings are never in the file."
- Export opens an inline form in its row: Name (`data-key="export-name"`, default "Manet config"), *Include API keys* switch (`data-key="export-keys"`, off), and when it is on a caution "Anyone with this file can use these keys."; buttons Cancel and Export (`data-key="export-go"`). Export calls `handlers.download(configFileName(name), serializeConfig(buildConfigFile(current, { name, includeKeys, now })))` and closes the form with "✓ Exported" for 2 s.
- Import clicks a hidden `<input type="file" accept=".json,application/json">`. The chosen file's text goes through `parseConfigFile`. A rejection shows its sentence under the button (`role="alert"`). A valid file shows the preview in the row (`data-role="import-preview"`):
  - "Import “Acme team”", and "Exported Wed 23 Sep 2026" (use `sessionView` date words: `shortDay`) when `exportedAt` parses.
  - Profiles, one line each: "New: Client meeting", "Changes Team: prompt, sections", "Unchanged: Personal", "Kept, only on this computer: Mine".
  - Settings, one line each: "Keep audio: 7 days → 14 days"; "Default profile: Team → Client meeting" when it changes; none: "Settings: no changes".
  - Keys: "API keys: replaced with the file’s" (caution tone) or "API keys: not in the file, yours are kept".
  - Cancel (`data-key="import-cancel"`) and Import (`data-key="import-go"`, prominent). Import calls `handlers.apply(mergeConfig(current, file))`, shows "✓ Imported “Acme team”", then `handlers.imported()`. A failed write shows "Couldn’t import: <reason>" and keeps the preview.

- [ ] **Step 1: Failing tests.** Create `tests/ui/shareView.browser.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfigFile, parseConfigFile, serializeConfig } from '@lib/config';
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Settings } from '@lib/types';
import { createShareView } from '@lib/ui/shareView';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function setup(current: Settings = normalizeSettings({ displayName: 'Ilyas', geminiApiKey: 'gem', notionToken: 'ntn', profiles: starterProfiles(DB, '') })) {
  let stored = current;
  const handlers = {
    current: () => stored,
    apply: vi.fn(async (next: Settings) => (stored = next)),
    download: vi.fn(),
    imported: vi.fn(),
  };
  const { element } = createShareView(handlers, { now: () => NOW });
  document.body.append(element);
  const el = <T extends HTMLElement>(key: string) => element.querySelector<T>(`[data-key="${key}"]`)!;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  async function choose(text: string) {
    const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([text], 'manet-config.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 20));
  }
  return { element, handlers, el, settle, choose, stored: () => stored };
}

afterEach(() => document.body.replaceChildren());

describe('Share', () => {
  it('exports without keys unless asked', () => {
    const { el, handlers } = setup();
    el('export').click();
    const name = el<HTMLInputElement>('export-name');
    name.value = 'Acme team';
    el('export-go').click();
    const [fileName, text] = handlers.download.mock.calls[0]!;
    expect(fileName).toBe('manet-config-acme-team.json');
    const parsed = parseConfigFile(text);
    expect(parsed.ok && parsed.file.keys).toBeFalsy();
    expect(text).not.toContain('Ilyas');
  });

  it('warns when the keys go in the file, and includes them', () => {
    const { el, element, handlers } = setup();
    el('export').click();
    el<HTMLInputElement>('export-keys').click();
    expect(element.textContent).toContain('Anyone with this file can use these keys.');
    el('export-go').click();
    const parsed = parseConfigFile(handlers.download.mock.calls[0]![1]);
    expect(parsed.ok && parsed.file.keys).toEqual({ geminiApiKey: 'gem', notionToken: 'ntn' });
  });

  it('previews an import, then applies it', async () => {
    const team = normalizeSettings({ profiles: [...starterProfiles(DB, ''), { ...starterProfiles(DB)[0]!, id: 'client', name: 'Client meeting' }], retentionDays: 14 });
    const { choose, element, el, handlers, stored } = setup();
    await choose(serializeConfig(buildConfigFile(team, { name: 'Acme team', includeKeys: false, now: NOW })));
    const preview = element.querySelector('[data-role="import-preview"]')!;
    expect(preview.textContent).toContain('Import “Acme team”');
    expect(preview.textContent).toContain('New: Client meeting');
    expect(preview.textContent).toContain('Keep audio: 7 days → 14 days');
    expect(preview.textContent).toContain('API keys: not in the file, yours are kept');
    el('import-go').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stored().profiles.map((p) => p.id)).toEqual(['team', 'personal', 'client']);
    expect(stored().displayName).toBe('Ilyas');
    expect(handlers.imported).toHaveBeenCalled();
    expect(element.textContent).toContain('Imported “Acme team”');
  });

  it('says what is wrong with a file that isn’t a config, and changes nothing', async () => {
    const { choose, element, handlers } = setup();
    await choose('{"hello": 1}');
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(
      'This file isn’t a Manet Meetings config. Choose a file exported from Settings › Share.',
    );
    expect(handlers.apply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project browser tests/ui/shareView.browser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/ui/shareView.ts`** per the behaviour above, using `previewConfig` for the lines. In `optionsView.ts`, `OptionsHandlers` gains `share: ShareHandlers` minus `current` (the view supplies `current: () => stored`); append the Share group after the Recording group; `imported()` runs the same all-profile check as *Check databases*. In `entrypoints/options/main.ts`:

```ts
function download(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
```

and `apply: (next) => updateSettings(next)`.

- [ ] **Step 4: Run tests**

Run: `pnpm typecheck && pnpm vitest run --project browser tests/ui/shareView.browser.test.ts tests/ui/optionsView.browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/shareView.ts src/lib/ui/optionsView.ts src/lib/ui/css/settings.css entrypoints/options tests/ui/shareView.browser.test.ts
git commit -m "feat: export and import a shared config in Settings" -m "Export writes profiles and shared settings to a manet-config file, with the API keys only when switched on. Import checks the file, previews every change and applies it in one write, then checks each profile's database."
```

---

### Task 14: Drop the Team | Personal settings

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/settingsSchema.ts`, `src/lib/settings.ts`, `src/lib/storage/sessionStore.ts`, anything the compiler flags
- Test: `tests/settings/normalizeSettings.test.ts`, the rest of the suite

- [ ] **Step 1: Failing test.** Add to `tests/settings/normalizeSettings.test.ts`:

```ts
  it('drops the Team | Personal fields once they are profiles', () => {
    const s = normalizeSettings({ notionTeamDbId: 'team-db', notionPersonalDbId: 'me-db', defaultRoute: 'personal' } as never);
    expect(s).not.toHaveProperty('notionTeamDbId');
    expect(s).not.toHaveProperty('notionPersonalDbId');
    expect(s).not.toHaveProperty('defaultRoute');
  });
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm vitest run --project node tests/settings/normalizeSettings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Remove.** From `Settings` delete `notionTeamDbId`, `notionPersonalDbId`, `defaultRoute`; delete `export type Route` and `SessionMeta.route` (move the field onto `LegacyMeta` in `sessionStore.ts`: `route?: 'team' | 'personal'`); delete `databaseIdFor` and its re-export. `normalizeSettings` returns without the legacy fields:

```ts
  const { notionTeamDbId: _team, notionPersonalDbId: _personal, defaultRoute: _route, ...rest } = { ...DEFAULT_SETTINGS, ...s } as Settings & LegacySettings;
  return { ...rest, profiles, defaultProfileId };
```

`updateSettings` writes `normalizeSettings(...)` output, so stored settings lose the fields on the next write.

- [ ] **Step 4: Fix what the compiler flags**

Run: `pnpm typecheck`
Expected: errors where tests, shots or the harness still set the removed fields or `route`. Remove those fields; where a test meant "the Personal database", it now builds a profile.

Run: `grep -rnE "notionTeamDbId|notionPersonalDbId|defaultRoute|databaseIdFor|\bRoute\b" src entrypoints scripts`
Expected: matches only in `normalizeSettings`'s `LegacySettings`, `sessionStore.ts`'s `LegacyMeta`/`normalizeMeta`, and `settingsForm`/`copy`/`sessionView` patterns that read old error records.

- [ ] **Step 5: Run everything**

Run: `pnpm typecheck && pnpm test:node && pnpm test:browser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src entrypoints tests scripts
git commit -m "refactor: drop the Team and Personal settings" -m "Profiles hold the databases and the default now; old settings and meetings are still read through normalizeSettings and normalizeMeta."
```

---

### Task 15: README and screenshots

**Files:**
- Modify: `README.md`, `tests/visual/{settings,popup,dashboard,scenarios}.shots.ts` (and `scenarios.ts`), `scripts/notion-setup.ts` (usage text only if it names Team/Personal)

- [ ] **Step 1: README.** Rewrite for profiles and sharing; keep the voice (plain, short sentences, no marketing):
  - "How it works": add one paragraph: "Every meeting belongs to a profile, chosen in the popup before you record. A profile says which Notion database the meeting goes to and how its notes are written: a prompt describing these meetings, and the sections to fill (a paragraph or bullets each, with an instruction). Action items are always added. Settings starts with Team and Personal."
  - "Key setup": step 4 becomes "Profiles: open each one and paste its database's link or ID, then press Check. Add profiles for other kinds of meeting (client calls, the daily sync)…"; step 6 drops "default destination" and says the default profile is set in the profile's editor. Add a step: "If a teammate sent you a config file, use Settings › Share › Import config… first: it sets up the profiles and shared settings, and the keys too when the file has them."
  - "Notion database schema": note the optional `Profile` Select, filled with the profile's name, useful when profiles share a database; the setup script adds it.
  - "Using it": step 1 mentions the Profile row; step 3 (the Team or Personal window) is replaced by "When the call ends, the meeting is transcribed and saved to its profile's database (with auto-transcribe on)."; step 5's ⋯ menu lists *Change profile…* instead of *Save to Personal instead*; Needs you drops "one waiting for Team or Personal" and adds "one whose profile was deleted".
  - New section "Sharing a config" after "Using it": what the file holds, the *Include API keys* switch and its risk, how import previews and merges (by profile id, file wins, local-only profiles kept, your name never touched), and that re-importing an updated file is how changes spread.
  - "Data and privacy": add that a config file with keys carries them in plain text.
  - Layout block: remove `routing` from `entrypoints/{…}` and add `src/lib/profiles.ts`, `src/lib/config.ts`.

- [ ] **Step 2: Screenshots.** In `tests/visual/`, add shots for: Settings with the Profiles group (setup incomplete and complete), the profile editor (starter profile; a client profile with four sections; a name error), the Share group (export form with keys on; import preview; import error), the popup Profile row (idle, recording, menu open), Meetings with a `ready` profile button and a "Choose a profile" row. Remove anything left that references the routing window.

Run: `UI_SHOTS_DIR=/tmp/claude-1000/manet-shots pnpm shots`
Expected: PASS, and the new PNGs render without clipped text in light and dark. Look at them.

- [ ] **Step 3: Commit**

```bash
git add README.md tests/visual scripts
git commit -m "docs: describe profiles and shared configs" -m "The README explains choosing a profile before recording, editing profiles, and exporting and importing a config; the screenshot gallery covers the new pages and drops the routing window."
```

---

### Task 16: Final verification

- [ ] **Step 1: Full checks**

Run: `pnpm typecheck && pnpm test:node && pnpm test:browser && pnpm build`
Expected: all PASS; `.output/chrome-mv3/manifest.json` has no `routing.html` and the build lists no routing entrypoint.

- [ ] **Step 2: Leftovers**

Run: `grep -rniE "team or personal|team \| personal|awaiting-route|routing" src entrypoints README.md`
Expected: matches only in the legacy-reading code (`normalizeMeta`, `normalizeSettings`, old-record patterns) and their comments.

- [ ] **Step 3: Spec matches what shipped.** Re-read `docs/superpowers/specs/2026-09-23-profiles-and-shared-config-design.md` and correct anything the implementation settled differently (for example: Change profile opens a menu; a meeting left waiting for Team or Personal reads as not transcribed; the popup hides the Profile row with a single profile). Commit the spec with `docs: bring the profiles spec in line with the build` if it changed.

- [ ] **Step 4: Manual smoke test in Chrome** (`pnpm dev`): record a short Meet call with a non-default profile chosen in the popup; confirm it transcribes when the call ends and the Notion page shows that profile's sections; change a saved-failed meeting's profile from ⋯ and confirm it re-summarizes (Step "Summarizing", no "Transcribing"); export a config with keys off, import it in a second Chrome profile, and check the preview and the result.
