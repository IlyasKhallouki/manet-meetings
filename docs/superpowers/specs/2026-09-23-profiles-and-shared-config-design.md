# Profiles, shared config and docs cleanup

Date: 2026-09-23. Status: approved in brainstorming, ready for a plan.

This is the first of two specs. The in-person recorder (mic-only recording with on-device
pyannote diarization) gets its own spec once this one ships, and it will record into a
profile like any other meeting.

## Goals

1. Rid the docs and defaults of company-specific details and of "untested" caveats.
2. Replace the fixed Team | Personal choice with profiles. A profile decides the notes'
   sections and prompt and the Notion database a meeting is saved to.
3. Let one person export the whole setup as a file and everyone else import it, so a team
   runs one config.

## Non-goals

- Destinations other than Notion databases (pages, Google Docs, Markdown files).
- Keeping imported config in sync automatically (from a URL, say). Re-importing a newer
  file is how updates spread.
- Profiles locked against local edits.
- Picking a profile from the meeting title or calendar.

## 1. Docs cleanup

Every caveat saying something was never checked has now been verified, so they all go.

- README: drop "Built for the Lumind team (4 people, meetings in mixed English/French)".
  In the known breakage points, drop the claims that the caption fixtures were
  reconstructed and should be replaced (point 1), that echo cancellation was never
  verified (point 5) and that the integration tests never ran against a real key
  (point 6). Keep the troubleshooting content: where the selectors live, what breakage
  looks like, the `adapterHealth` log.
- `src/lib/meet/captionAdapter.ts` header and `tests/fixtures/captions/README.md`: drop the
  "reconstructed", "inferred" and "replace them" wording. Keep the DOM description, the
  selector table and the capture snippet, which still help when Meet changes.
- `DEFAULT_SETTINGS.customVocabulary` becomes `[]`.
- The summary prompt loses "for a small team whose meetings mix English and French". Its
  generic rules keep the part about mixed languages within one sentence.
- Tests keep "Lumind" as sample vocabulary and fixture text.

The README sections on routing, databases and settings are rewritten for profiles as part
of section 2.

## 2. Profiles

### Model

```ts
interface NoteSection {
  id: string;            // stable within the profile; used by import diffs and the editor
  title: string;         // heading on the Notion page, e.g. "Client needs"
  instruction: string;   // what the model writes there
  format: 'paragraph' | 'bullets';
}

interface Profile {
  id: string;            // 'team' and 'personal' for migrated profiles, else a UUID
  name: string;
  databaseId: string;    // Notion link or id, as pasted
  prompt: string;        // context for every summary of this profile; may be empty
  sections: NoteSection[];
  vocabulary: string[];  // added to the global vocabulary for this profile's meetings
}
```

`Settings` loses `notionTeamDbId`, `notionPersonalDbId` and `defaultRoute`, and gains
`profiles: Profile[]` and `defaultProfileId: string`. The `Route` type goes away.

Rules, enforced by the editor and by import:

- At least one profile exists. The default profile cannot be deleted; make another one the
  default first.
- Names are 1–60 characters, unique ignoring case.
- 0–12 sections. Section titles are 1–60 characters, unique ignoring case within a profile,
  and cannot be "Action items". Instructions are at most 500 characters.
- Prompts are at most 2,000 characters.
- Global plus profile vocabulary is capped at `MAX_VOCABULARY` by `buildVocabulary`, as now.

The title and the action items are always generated; they are not sections.

### Migration

A pure `normalizeSettings(stored)` runs inside `getSettings()`. When `profiles` is missing it
builds two profiles from the old fields:

| id         | name     | databaseId           |
|------------|----------|----------------------|
| `team`     | Team     | `notionTeamDbId`     |
| `personal` | Personal | `notionPersonalDbId` |

Both get today's layout as sections, so existing pages look the same:

| Title      | Format    | Instruction |
|------------|-----------|-------------|
| Summary    | paragraph | Two to five sentences on what was discussed and concluded. |
| Key points | bullets   | The main topics and facts, one short sentence each. |
| Decisions  | bullets   | Only explicit agreements or decisions. |

`defaultProfileId` becomes the old `defaultRoute`. The old fields are dropped on the next
write. A fresh install gets the same two profiles with empty databases.

Keeping the ids `team` and `personal` means an old session's `route` maps straight onto a
`profileId`. `getSession` and `listSessions` normalize old metas on read: `route` becomes
`profileId`. Boot moves any session still in `awaiting-route` to `ready` with the default
profile, clears its route alarm, and transcribes it when auto-transcribe is on.

Stored results written before profiles hold `summary`, `keyPoints` and `decisions`.
`getResult` turns them into the three sections above.

### Choosing a profile

The profile is chosen before recording, and nothing opens after the call.

- Popup, on a call: a Profile row above *Record this call*, set to the default profile.
  It opens the existing ⋯ menu component listing profiles. *Record this call* sends
  `session/start { tabId, profileId }`.
- Popup, recording: the same row stays and can change the profile
  (`session/set-profile`).
- Keyboard shortcut: records with the default profile.
- When a recording ends, the session goes to `ready`. With auto-transcribe on,
  transcription starts at once.
- A recording recovered after a crash goes to `ready` with its own profile, then follows
  the same rule. Orphan audio adopted at boot gets the default profile.

Removed: the routing window (`entrypoints/routing`, `routingView.ts`, `routing.css`, their
tests and shots), `session/route`, `session/route-hold`, route alarms, `routeDeadline`,
`onWindowRemoved`, `openRoutingPrompt`, `defaultRouteText` and the `awaiting-route` status.

### Changing a meeting's profile

`session/set-profile { sessionId, profileId }` replaces `session/route`. The background
accepts it while a session is `recording`, `ready`, `failed`, `processed`, `empty` or
`duplicate`. Meetings offers it as ⋯ *Change profile…*, which shows the profiles inline
in the row, the way *Delete…* asks inline now. A `ready` row shows its profile as a
button that opens the same list. The popup offers the Profile row.

Every stored result records the profile it was summarized for:
`SessionResult.profile = { id, name }`. A save job gets the session's current profile. When
the ids differ, the offscreen document summarizes again with the new profile before saving.
It reuses the stored transcript, so Gemini never transcribes twice. Editing the profile
itself does not re-summarize a stored result; the result keeps the sections it was written
with.

The duplicate check and the save use the chosen profile's database. The dedupe key does not
change.

### A missing profile

A session can outlive its profile. When a job starts and `profileId` is not in settings,
the session fails with "This meeting’s profile was deleted. Choose another profile." It
then shows under Needs you, with *Choose profile* as its next step.

`missingForSave(settings, profileId)` checks your name, the Notion token and that
profile's database, worded as "the Client meeting profile’s database".

### Summaries

```ts
interface SummarySection {
  title: string;
  format: 'paragraph' | 'bullets';
  text: string;        // paragraph sections
  items: string[];     // bullet sections
}

interface MeetingSummary {
  title: string;
  sections: SummarySection[];
  actionItems: ActionItem[];
  language?: string;
}
```

`summaryRequest(transcript, { attendees, meetingDate, profile })` builds:

- A system instruction. First the fixed rules: use only the transcript, never invent,
  write in the dominant language, the title rules, the action-item and owner rules. Then,
  when the profile has one, "About these meetings:" and the prompt. Then one line per
  section: title, format and instruction.
- A JSON schema, properties in order: `language`, `title`, `sections`, `actionItems`.
  `sections` is an object with keys `s1…sN` in profile order. Paragraph sections are
  strings, bullet sections arrays of strings, each described by its instruction. All are
  required.

`parseMeetingSummary` maps `s1…sN` back onto the profile's sections by position, trims
text, drops blank bullets and keeps the owner matching it does now. A profile with no
sections yields a title and action items only.

### Notion page

`buildMeetingBody` writes the degradation callout, then each section in order: a heading,
then the paragraphs or bullets, or "None." when the section came back empty. Action items
follow as to-dos. Without a summary the page keeps today's "The summary is unavailable…"
text under a Summary heading.

The database schema does not change. One optional addition: when the database has a Select
property named `Profile`, the save fills it with the profile name. Verification never
requires it. `scripts/notion-setup.ts` adds it to new databases, which helps when several
profiles share a database.

### Settings page

The Team database, Personal database and Default destination fields give way to a Profiles
group:

- One row per profile: its name, a *Default* tag, and the database title from the last
  check. When the database is missing or failed its check, the row shows a caution with
  the reason. Tapping a row opens the editor.
- *Add profile* creates "New profile" with the default sections and opens it.

The profile editor is a drill-in view on the Settings page (`options.html#profile/<id>`),
with a back button to Settings. Fields: Name; Notion database with Check; Prompt; Sections,
each with title, a Paragraph | Bullets segmented control, instruction, move up, move
down and remove, then *Add section*; Vocabulary, one term per line; *Use as default*;
*Delete profile…*, confirmed inline. Changes save as you make them, under the rules
Settings uses now: text commits on blur or Enter, and a value that fails a rule is never
written and shows its fix under the field.

The setup checklist asks for your name, a Notion token and the default profile's database.
The database item opens the editor at that field.

### Popup and Meetings

- Recent in the popup and rows on Meetings show the profile name where they showed Team or
  Personal now.
- The auto-transcribe hint on Meetings reads "Each meeting is transcribed and saved to
  Notion when the call ends."
- Needs you keeps its rules, minus "waiting for Team or Personal", plus a meeting whose
  profile was deleted.

## 3. Config import and export

### File

`manet-config-<name>.json`:

```json
{
  "format": "manet-config",
  "version": 1,
  "name": "Acme team",
  "exportedAt": "2026-09-23T14:02:00.000Z",
  "defaultProfileId": "team",
  "profiles": [ { "id": "team", "name": "Team", "databaseId": "…", "prompt": "",
                  "sections": [ … ], "vocabulary": [] } ],
  "settings": {
    "customVocabulary": [],
    "languageCodes": [],
    "autoTranscribe": true,
    "retentionDays": 7,
    "includeMic": true
  },
  "keys": { "geminiApiKey": "…", "notionToken": "…" }
}
```

`keys` appears only when the exporter turned on *Include API keys*. The file never holds
your name, your meetings or anything else local.

### Export

A Share group at the bottom of Settings holds *Export config…*. It asks for a config name
(default "Manet config") and shows an *Include API keys* switch, off by default. Turned on,
a caution reads "Anyone with this file can use these keys." *Export* downloads the file
through a Blob URL and an `<a download>` link.

### Import

*Import config…* opens a file picker. The file is parsed strictly by
`parseConfigFile(text)`:

- valid JSON, under 1 MB, `format` equal to `manet-config`;
- `version` 1 (a newer version reads "This file needs a newer version of Manet Meetings.");
- every profile and setting passing the rules in section 2;
- `defaultProfileId` naming a profile that exists after the merge.

A rejected file shows one sentence under the button saying what to fix. Nothing changes.

A valid file shows a preview in place of the Share group before anything is written. It
lists profiles as added, changed (with the changed fields named), unchanged, or kept
because they are only local; each setting that changes, old → new; and keys as "replaced"
or "not in file, yours kept". *Cancel* discards it. *Import* applies it in one settings
write.

Merge rules, in `mergeConfig(current, file)`:

- Profiles match by `id`. A file profile replaces the local one with its id or is
  appended. Local profiles absent from the file stay.
- Shared settings and `defaultProfileId` take the file's values.
- Keys change only when the file has them.
- A name clash (a file profile's name matches a different local profile) renames the local
  one to "Name (local)".

After an import, Settings checks every profile's database and shows the results on the
profile rows.

## Messages

- `session/start`: `{ tabId, profileId? }`. The keyboard path omits `profileId` and gets
  the default.
- `session/set-profile`: `{ sessionId, profileId }`.
- `session/route` and `session/route-hold` are removed.
- `SaveJob` and `ProcessJob` carry `profile: Profile` instead of `route`.

Import and export run in the Settings page and need no background messages.

## Errors

- Unknown profile at job time: see "A missing profile".
- The profile's database fails at save: today's Notion errors, with the profile named
  where the text says "the Team database" now.
- A summary that fails or breaks the schema: today's degradation. The transcript is
  saved, and the page notes that the summary could not be generated.
- A rejected import file: a sentence under Import, nothing written.

## Testing

Node tests:

- `normalizeSettings`: fresh install; old settings with both databases; old settings with
  none; idempotent on new settings.
- Legacy session and result normalization.
- `summaryRequest` and `parseMeetingSummary` for a custom profile, a profile with no
  sections, and `s1…sN` mapping.
- `buildMeetingBody` with custom sections and empty sections.
- `parseConfigFile` (each rejection), `mergeConfig` (add, replace, keep, rename on clash,
  keys present or absent) and the preview diff.
- `sessionView`: statuses and actions without `awaiting-route`, *Change profile…*, the
  missing profile.
- Session manager: recording ends at `ready` and auto-transcribes; set-profile in every
  accepting status; a save after a profile change re-summarizes; recovery with no routing;
  a legacy `awaiting-route` session at boot.

Browser tests: the Settings profiles list, editor, export and import preview; the popup
Profile row; the Meetings profile picker and *Change profile…*.

`pnpm shots`: add the profile editor, import preview and popup Profile row; remove the
routing window.

Integration (with `GOOGLE_API_KEY`): summarize a fixture transcript with a custom
three-section profile and check the shape.
