# Minute Book

A Chrome extension that records Google Meet calls, transcribes them with Gemini and files
them into Notion: one page per meeting with a summary, action items and a speaker-labelled
transcript. It handles meetings that mix languages, even within one sentence. There is no
backend. Each person runs the extension with their own keys.

## How it works

```
Meet tab ── content script ── live captions ──────────────┐  who spoke when
   │                                                      │
   └─ tab audio ─┐                                        ▼
mic ─────────────┴─ offscreen doc ─ MediaRecorder ─ OPFS ─ pipeline ─ Notion
                    (mono Opus, 5 s chunks)          │
                                                     └─ Gemini: what was said
```

Speaker names come from Meet's live captions rather than from speech diarization. The
content script reads the caption panel, dedupes Meet's in-place rewrites, and timestamps
each caption block relative to the start of the recording.

The words come from Gemini (`gemini-3.5-transcribe`), which reads the same audio twice.
The timing pass returns word timestamps; Gemini caps those requests at 30 minutes and
rejects custom vocabulary. The text pass uses custom vocabulary (team jargon plus the
names of whoever spoke) and allows 60 minutes per request, but returns no timestamps.
Text-pass words are then aligned onto timing-pass times, and each word takes the speaker
of the caption block covering it. Long recordings are cut into overlapping parts with 30 s
of overlap: about 28 minutes for the timing pass, 55 for the text pass.

A second call, to `gemini-3.5-flash`, turns the finished transcript into a title, a
summary, key points, decisions and action items, as structured JSON.

Every meeting belongs to a profile, chosen in the popup before you record. A profile says
which Notion database the meeting goes to and how its notes are written: a prompt
describing these meetings, and the sections to fill (a paragraph or bullets each, with an
instruction). Action items are always added. Settings starts with Team and Personal.

Notion is what keeps two teammates from filing the same meeting twice. Every meeting has
the key `<meet code>-<YYYY-MM-DD>`, and the extension looks that key up before it
transcribes or creates anything. If a teammate got there first, it skips and tells you who
recorded it. When two people finish at the same moment, the older page wins and the newer
one archives itself.

Losing a meeting takes some doing. Audio is written to disk every 5 s from the first
second, and a recording cut short by a crash is recovered on the next browser start. If
the audio or Gemini fails, the caption-only transcript is still saved, with
`Source = captions-only`.

## Install

Chrome 116 or newer.

From a release: download `minute-book-<version>-chrome.zip` from the repository's
Releases page and unzip it. Each version tag (`v0.2.0`) publishes one.

From CI: download the `minute-book-chrome` artifact from the latest green run and unzip
it.

From source:

```sh
pnpm install
pnpm build        # → .output/chrome-mv3
```

Then open `chrome://extensions`, turn on Developer mode, click Load unpacked and pick the
unzipped folder (or `.output/chrome-mv3`). Pin the extension so its icon is one click away
during calls.

## Key setup

Settings opens by itself after you install the extension, with a checklist of what is
still missing before meetings can reach Notion. Later, open it from the popup or by
right-clicking the icon and choosing Options. Changes save as you make them.

1. Name, under *You*. Fills *Recorded by* in Notion and replaces Meet's "You" caption
   label.
2. Gemini API key, under *Transcription*. Create one at <https://aistudio.google.com/apikey>,
   paste it, then click Check.
3. Token, under *Notion*. Two kinds work. A personal access token is the easier one:
   create it at <https://www.notion.so/developers/tokens> with the *Notion API* capability
   in the team's workspace. It acts with your own Notion permissions, so there is nothing
   to share, and the Free-plan block cap below doesn't apply to it. The other kind is an
   internal integration secret, created at <https://www.notion.so/profile/integrations>
   with the *Read*, *Update* and *Insert content* capabilities. Share each profile's
   database with it afterwards (database ⋯ menu, then *Connections*). In a Free workspace
   with more than one member, Notion caps internal integrations at 1,000 blocks for the
   workspace's lifetime, and trashing pages gives none of them back. A meeting costs
   roughly 15 to 30 blocks, because transcript turns are packed into shared paragraphs.
4. Profiles: open each one and paste its database's link or ID, then press Check. Add
   profiles for other kinds of meeting (client calls, the daily sync) with *Add profile*,
   under *Profiles*.
5. Microphone, under *Recording*. Choose *Allow microphone…*, then Continue on the page
   that opens, and allow it in Chrome's prompt. Chrome only allows this from a visible
   extension page, which is why it is a separate one-time step. Without it, only the other
   participants are recorded.
6. Optional: *Transcribe automatically*, how long to keep audio (7 days by default),
   vocabulary and languages. The default profile is set in that profile's editor, with *Use
   as default*.
7. If a teammate sent you a config file, use Settings › Share › Import config… first: it
   sets up the profiles and shared settings, and the keys too when the file has them.

Keys are stored in `chrome.storage.local` on your machine. They are sent only to Gemini
and Notion respectively.

## Notion database schema

Each profile's database needs exactly these properties. Names are case-sensitive. A fresh
install starts with Team and Personal profiles, each pointing at its own database, but a
profile can point at any database, including one shared with other profiles.

| Property      | Type         | Filled with |
|---------------|--------------|-------------|
| `Name`        | Title        | Meeting title (from the summary, else Meet's title) |
| `Date`        | Date         | Recording start, with time |
| `Duration`    | Number       | Minutes |
| `Attendees`   | Multi-select | Speaker names seen in captions, plus you |
| `Meet code`   | Text         | e.g. `abc-defg-hij` |
| `Recorded by` | Text         | Your name from settings |
| `Source`      | Select       | `audio+captions`, `audio-only` or `captions-only` |
| `Key`         | Text         | Dedupe key `<meet code>-<YYYY-MM-DD>` |

The page body holds each of the profile's sections, then action items (as to-dos). The
full transcript lives in a child page called Transcript.

An optional `Profile` Select property, when present, is filled with the profile's name.
It's useful when several profiles share a database. `scripts/notion-setup.ts` adds it to
new databases.

To create a database with this schema under an existing page:

```sh
NOTION_TOKEN=ntn_… node scripts/notion-setup.ts <parent page link or id> "Team meetings"
```

It prints the database id to paste into Settings. With an internal integration, share the
parent page with it first. The client targets Notion API version `2026-03-11`, where
databases contain data sources.

## Using it

1. Join a Meet call, click Minute Book in the toolbar and, above *Record this call*, a
   Profile row shows which profile the meeting will use (it's hidden when you only have
   one). Pick a different one if you need to, then choose Record this call (or press
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>, which always uses the default profile).
   Chrome only lets an extension capture a tab after you invoke it on that tab, so
   recording never starts by itself. While it records, the popup shows how long it has
   been going, the speakers Meet's captions have named so far, whether your microphone is
   in the recording, and the same Profile row, which you can still change mid-call.
   Stop recording ends it, and so does leaving the call.
2. Captions get turned on for you, since they are how speakers are identified. Leave them
   on.
3. When the call ends, the meeting is transcribed and saved to its profile's database
   (with auto-transcribe on). A recording cut short by a crash or restart picks up again
   the next time Chrome starts.
4. With *Transcribe automatically* on (a switch at the top of Meetings and in Settings),
   the meeting is transcribed and saved to Notion, and Meetings shows the step it is on
   (*Step 4 of 8*). Otherwise choose Transcribe on Meetings. If Gemini is unavailable, the
   extension tries again after 10 and 30 minutes before falling back to a captions-only
   transcript. With no Gemini key set, meetings are saved from captions only.
5. Meetings, from the popup's footer, lists every meeting by day, newest first. Each row
   has one next step (Transcribe, Save to Notion, Try again, Open in Notion) and a ⋯ menu
   with the rest: *Transcribe again*, *Change profile…*, *Delete…*. A meeting not yet
   transcribed shows its profile as a button, which opens the same picker. Meetings that
   wait on you are pinned in a Needs you group at the top: one transcribed but not saved
   yet, one whose profile was deleted, or one that failed with no retry scheduled. The
   popup's footer counts them (*Meetings · 1 needs you*).
6. A meeting a teammate already saved reads *Saved by Marie*, and yours isn't added. If you
   want your own page too, choose ⋯ then *Save a second copy…*.

Changing the profile of an already-transcribed meeting rewrites only its summary, from the
transcript already on hand; Gemini never transcribes the audio again.

### The toolbar icon

A red dot on the icon means a recording is running right now. Red means nothing else
anywhere in the extension.

An amber "!" while recording means something needs a look: no call audio, audio that
stopped arriving, no captions yet, or captions that went quiet. The popup says which and
what to do about it.

An amber number when nothing is recording counts the meetings that need you, the same ones
in the Needs you group. It clears as you deal with them.

The tooltip reads *Recording since 14:02* or shows the record shortcut, and notifications
name a meeting by its start time and length. Neither ever shows a meeting title, so
nothing confidential pops up while you share your screen on the next call.

## Sharing a config

Settings › Share holds *Export config…* and *Import config…*, so a team can run one setup
instead of everyone typing in their own profiles and token.

A config file holds a name, the default profile, all profiles (name, database, prompt,
sections, vocabulary) and the shared settings (vocabulary, languages, auto-transcribe,
audio retention, whether to include the mic). *Export config…* asks for a name and has an
*Include API keys* switch, off by default; turning it on shows a warning, since anyone
with the file can then use those keys. It never includes your name or your meetings.

*Import config…* checks the file first and, if it's valid, shows a preview before changing
anything: each profile as new, changed, unchanged or kept because it's only local; each
changed setting as old → new; the default profile; and whether keys are replaced or kept as
they are. Importing merges profiles by id, and the file's version wins for any id it
names. A profile that only exists locally is kept, and if the file has a different profile
with the same name, the local one is renamed "Name (local)" so both survive. The shared
settings listed above come from the file. Your own name is never exported or changed by an
import.

Re-importing an updated file is how changes spread to the team; nothing stays in sync on
its own.

## Data and privacy

Audio stays on your machine, in the extension's private file system (OPFS). It is deleted
7 days after the transcript reaches Notion, or right away with ⋯ then *Delete…* on
Meetings. The 7 days are configurable.

Gemini requests are sent with `store: false`, and uploaded audio files are deleted once
transcription finishes. Gemini expires them after 48 h anyway.

A config file exported with *Include API keys* on carries your Gemini and Notion keys in
plain text. Treat it like a password and send it somewhere private.

## Development

```sh
pnpm dev          # Chrome with the extension loaded, hot reload
pnpm test         # both Vitest projects
pnpm test:node    # logic + integration tests (Node)
pnpm test:browser # real headless Chrome: DOM fixtures, OPFS, AudioContext, MediaRecorder
pnpm typecheck
pnpm shots        # renders every page state to UI_SHOTS_DIR, for design review
pnpm zip          # packed extension in .output/
```

To release, set the version in `package.json`, commit it to `main`, then push an
annotated tag named after it (`git tag -a v0.3.0`). The tag's message becomes the release
notes, and the Release workflow attaches the packed extension.

Tests run against real dependencies. The integration tests only run when their keys are
set, either in the shell or in a git-ignored `.env.test.local`:

| Variable            | Enables |
|---------------------|---------|
| `GOOGLE_API_KEY`    | Real Gemini transcription and summary tests |
| `NOTION_TOKEN`      | Real Notion writes (with `NOTION_TEST_DB_ID`) |
| `NOTION_TEST_DB_ID` | A scratch database with the schema above, shared with the integration |

A skipped integration test means that path wasn't checked. It is not a pass. CI reads the
same three names from repository secrets, and runs the Notion writes only on pushes to
`main`.

Every run of the Notion suite creates a few pages. Keep `NOTION_TEST_DB_ID` in a
single-member or paid workspace, or use a personal access token, so the tests don't eat
the team workspace's Free-plan block allowance.

The audio tests also want `ffmpeg` and `ffprobe` on the `PATH`; the tests that need them
skip with a reason when they are missing. Browser test files run one at a time, because
real-time audio tests are sensitive to CPU contention.

Layout:

```
entrypoints/content/     caption observer (Meet tab)
entrypoints/background/  session lifecycle, tabCapture, offscreen coordination, recovery, retention
entrypoints/offscreen/   tab + mic mixing, MediaRecorder → OPFS, runs the pipeline
entrypoints/{popup,options,dashboard,permission}/   (dashboard = the Meetings page, options = Settings)
src/lib/meet/captionAdapter.ts   every Meet DOM selector (and only here)
src/lib/transcribe/      Gemini client, two passes, splitting, summary
src/lib/align/           word-sequence alignment
src/lib/merge/           words + captions → speaker-labelled transcript
src/lib/notion/          client, idempotency, page builder
src/lib/pipeline/        orchestration and degradation
src/lib/profiles.ts      profile model, migration, validation
src/lib/config.ts        config export, import parsing and merging
src/lib/ui/              design system (styles.css), shared controls, one view per page
tests/fixtures/captions/ saved Meet caption DOM
```

## Known breakage points

The places most likely to break quietly, and what to check first.

1. Meet's caption DOM. Every selector and Meet UI string lives in
   `src/lib/meet/captionAdapter.ts`, and `tests/fixtures/captions/` holds saved caption
   DOM. Breakage shows up as transcripts with `Source = audio-only` or "Unknown speaker".
   The Meet tab's console logs `adapterHealth` once per call, showing which hooks matched.
   When Meet changes, run the capture snippet in `tests/fixtures/captions/README.md`
   during a call and refresh the fixtures.
2. Your own caption label. Your turns are recognized by Meet's `You` or `Vous` label, so
   use Meet in English or French. In other UI languages your turns keep Meet's label
   instead of your name.
3. Captions must stay on. The extension turns them on (at most 3 tries, 3 s apart) and
   never fights you if you turn them off again. Without captions there are no speaker
   names, though the audio is unaffected. Meet captions follow one spoken-language
   setting. Speakers are matched mainly by timing, so captions in the wrong language still
   identify who spoke, but a captions-only fallback will read poorly.
4. Starting a recording needs your click. Chrome grants tab capture only after you invoke
   the extension on that tab: the icon, then Record this call, or
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>.
5. Microphone. The grant comes only from the permission page. If you picked "Allow this
   time" it expires, and later calls record only the other participants; the popup says
   so.
6. Gemini. Model ids are in `src/lib/gemini/models.ts` (`gemini-3.5-transcribe`,
   `gemini-3.5-flash`). Per the docs, word-timestamp requests are capped at 30 minutes and
   reject `custom_vocabulary`, while plain requests are capped at 60. Hence the two passes.
   If one pass fails the other still counts, and the page lists what degraded. A pass that
   hits its output cap can loop, repeating the same stretch; anything past the last word
   that matched the timing pass is dropped, and the timing pass covers that stretch
   instead.
7. Notion. API version `2026-03-11` (data sources), the property names above, and the
   Free-plan block cap for internal integrations. *Check databases*, in the Profiles group
   in Settings, checks access and schema for every profile's database, but it cannot check
   write capability.
8. The dedupe key. `<meet code>-<YYYY-MM-DD>` uses each recorder's local date, so two
   teammates in different time zones around midnight get different keys. Two separate
   meetings in the same Meet room on the same day count as one: the second shows as *Saved
   by …* and needs ⋯ then *Save a second copy…*. The same happens when you record one
   meeting in two pieces, say after closing the tab by mistake. Your own earlier piece is
   recognized by your name, so that audio is kept until you act. When two teammates save at
   the same moment, the older page wins, settled within about 20 s. A Notion row with an
   empty `Key` is a save still running or abandoned, and dedupe ignores it.
9. Chrome's recording format. Long recordings are cut on WebM cluster boundaries. Chrome
   currently writes about one cluster per 5 s chunk, and a browser test asserts that
   layout.
10. Service worker lifetime. Recording, transcription and Notion calls all run in the
    offscreen document, which reports each job's result as its own message. A worker
    restart therefore doesn't lose a result, and interrupted jobs resume when auto
    transcribe is on.
11. Audio failures mid-call. If the disk quota is hit, a chunk can't be written or the
    recorder dies, the audio stops but captions continue until the meeting ends. The
    missing stretch is filled from caption text and the page notes it. A watchdog checks
    for missing chunks every 30 s. Audio takes about 14 MB per hour.
12. Tabs opened before an install or update have no caption observer. It is injected when
    you choose Record this call. If that fails, the popup and Meetings say so; reload the
    Meet tab.
13. A guest named "You" or "Vous". Their captions are indistinguishable from your own, so
    their words are attributed to you.

## Design

The pages follow the iOS 26 visual language: inset grouped lists on a grouped background,
capsule controls, Inter, and a navy accent for the single filled button on a screen. Liquid
Glass appears on exactly three floating surfaces, each over content that really scrolls:
the page bar on Meetings and Settings, the popup's bottom toolbar, and the ⋯ menu. Rows,
cards and the microphone page stay opaque, and a test enforces that budget. Reduced
transparency, increased contrast, forced colours and reduced motion each fall back to an
opaque bar that keeps its hairline.

`pnpm shots` renders every page in every state, light and dark, at the widths people use.
