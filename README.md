# Manet Meetings

A Chrome extension that records Google Meet calls, transcribes them with Gemini and files
them into Notion: one page per meeting with a summary, action items and a speaker-labelled
transcript. Built for the Lumind team (4 people, meetings in mixed English/French). No
backend: each person runs the extension with their own keys.

## How it works

```
Meet tab ── content script ── live captions ──────────────┐  who spoke when
   │                                                      │
   └─ tab audio ─┐                                        ▼
mic ─────────────┴─ offscreen doc ─ MediaRecorder ─ OPFS ─ pipeline ─ Notion
                    (mono Opus, 5 s chunks)          │
                                                     └─ Gemini: what was said
```

- **Speakers come from Meet's live captions**, not from speech diarization. The content
  script reads the caption panel, dedupes Meet's in-place rewrites and timestamps each
  caption block relative to the recording start.
- **Words come from Gemini (`gemini-3.5-transcribe`)** in two passes over the same audio:
  - a *timing pass* with word timestamps (Gemini caps these requests at 30 min, and they
    can't use custom vocabulary), and
  - a *text pass* with custom vocabulary (team jargon plus attendee names, up to 60 min
    per request, no timestamps).

  Text-pass words are aligned onto timing-pass times, then each word gets the caption
  speaker whose block covers it. Long recordings are split with 30 s overlaps (about
  28 min for the timing pass, 55 min for the text pass).
- **A second Gemini call (`gemini-3.5-flash`)** turns the transcript into a title,
  summary, key points, decisions and action items as structured JSON.
- **Notion is the dedupe coordinator.** Each meeting has the key `<meet code>-<YYYY-MM-DD>`.
  Before transcribing or creating anything, the extension looks the key up. If a teammate
  already saved the meeting, it skips and tells you who recorded it. If two people finish
  at the same moment, the oldest page wins and the other archives itself.
- **Nothing is lost.** Audio is written to disk every 5 s from the first second, and an
  interrupted recording is recovered on the next browser start. If the audio or Gemini
  fails, the caption-only transcript is still saved with `Source = captions-only`.

## Install

Chrome 116 or newer.

**From CI.** Download the `manet-meetings-chrome` artifact from the latest green CI run
and unzip it.

**From source.**

```sh
pnpm install
pnpm build        # → .output/chrome-mv3
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and
pick the unzipped folder (or `.output/chrome-mv3`). Pin the extension so its icon is one
click away during calls.

## Key setup

**Settings** opens by itself after you install the extension, with a checklist of what
meetings still need before they can be saved to Notion. Later, open it from the popup
(**Settings**) or right-click the icon → Options. Changes are saved as you make them.

1. **Name** (under *You*): fills *Recorded by* and replaces Meet's "You" caption label.
2. **Gemini API key** (under *Transcription*): create one at
   <https://aistudio.google.com/apikey>, paste it, then click **Check**.
3. **Token** (under *Notion*): use one of these two.
   - **A personal access token (recommended).** Create one at
     <https://www.notion.so/developers/tokens> with the *Notion API* capability, in the
     team's workspace. It acts with your own Notion permissions, so there is nothing to
     share. It is also exempt from the Free-plan block cap (see below).
   - **An internal integration secret.** Create the integration at
     <https://www.notion.so/profile/integrations> with the *Read*, *Update* and *Insert
     content* capabilities, then share both meeting databases with it (database ⋯ menu
     → *Connections*). In a Free workspace with more than one member, Notion caps
     internal integrations at **1,000 blocks for the workspace's lifetime**, and trashing
     pages doesn't give any back. A meeting uses roughly 15–30 blocks, because transcript
     turns are packed into shared paragraphs.
4. **Team database** and **Personal database**: paste each database's link or ID. Then
   **Check both databases** (its **Check** button) checks access and the schema below.
5. **Microphone** (under *Recording*, *Include your microphone*): choose **Allow
   microphone…**, then **Continue** on the page that opens, and allow it in Chrome's
   prompt. Chrome only allows this from a visible extension page, so it is a one-time
   separate step. Without it, only the other participants are recorded.
6. Optional: default destination (Team or Personal), *Transcribe automatically*, how
   long to keep audio (7 days by default), vocabulary, languages.

Keys are stored in `chrome.storage.local` on your machine only. They are sent only to
Gemini and Notion respectively.

## Notion database schema

Create one database for Team meetings and one for your Personal meetings, both with
exactly these properties. Names are case-sensitive.

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

The page body holds the summary, key points, decisions and action items (as to-dos). The
full transcript is in a child page called **Transcript**.

To create a database with this schema under an existing page:

```sh
NOTION_TOKEN=ntn_… node scripts/notion-setup.ts <parent page link or id> "Team meetings"
```

It prints the database id to paste into Settings. With an internal integration, share
the parent page with it first. The client targets Notion API version `2026-03-11`, where
databases contain data sources.

## Using it

1. Join a Meet call, click Manet Meetings in the toolbar and choose **Record this call**
   (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>). Chrome only lets an extension
   capture a tab after you invoke it on that tab, so recording can't start by itself.
   While it records, the popup shows how long it has been recording, the speakers Meet's
   captions have named so far, and whether your microphone is in the recording.
   **Stop recording** ends it, and so does leaving the call.
2. Captions are turned on for you, because they are how speakers are identified. Leave
   them on.
3. When the recording stops, a small window asks **Save this meeting to Team | Personal**
   (or press <kbd>T</kbd> or <kbd>P</kbd>). If you don't choose, your default applies
   when its countdown ends. **Pause** (or <kbd>Esc</kbd>) stops the countdown while you
   decide; close a paused window and the default applies 2 minutes later. A recording
   cut short by a crash or restart asks the same question the next time Chrome starts.
4. With *Transcribe automatically* on (a switch at the top of Meetings and in Settings),
   the meeting is then transcribed and saved to Notion, and Meetings shows the step it
   is on (*Step 4 of 8*). Otherwise choose **Transcribe** on Meetings. If Gemini is
   unavailable, the extension tries again after 10 and 30 minutes before falling back to
   a captions-only transcript. With no Gemini key set, meetings are saved from captions
   only.
5. **Meetings** (from the popup's footer) lists every meeting by day, newest first. Each
   row has one next step (**Transcribe**, **Save to Notion**, **Try again**, **Open in
   Notion**…) and a **⋯** menu with the rest: *Transcribe again*, *Save to Personal
   instead* (or Team), *Delete…*. Meetings that wait on you are pinned in a **Needs you**
   group at the top: a meeting waiting for Team or Personal, one transcribed but not
   saved yet, or one that failed with no retry scheduled. The popup's footer counts them
   (*Meetings · 1 needs you*).
6. A meeting a teammate already saved reads *Saved by Marie*, and yours isn't added. If
   you want your own page as well, choose **⋯ › Save a second copy…**.

### The toolbar icon

- **A red dot** on the icon: recording right now. Red means nothing else anywhere in
  the extension.
- **An amber "!"** while recording: something needs a look (no call audio, the audio
  stopped arriving, no captions yet, or captions went quiet). The popup says what and
  what to do.
- **An amber number** when nothing is recording: how many meetings need you (the *Needs
  you* group). It clears as you deal with them.

The tooltip reads *Recording since 14:02* or shows the record shortcut, and
notifications name a meeting by its start time and length. Neither ever shows a meeting
title, so nothing confidential pops up while you share your screen on the next call.

## Data and privacy

- Audio stays on your machine, in the extension's private file system (OPFS). It is
  deleted 7 days (configurable) after the transcript is saved to Notion, or right away
  with **⋯ › Delete…** on Meetings.
- Gemini requests are sent with `store: false`. Uploaded audio files are deleted once
  transcription finishes (Gemini also expires them after 48 h).

## Development

```sh
pnpm dev          # Chrome with the extension loaded, hot reload
pnpm test         # both Vitest projects
pnpm test:node    # logic + integration tests (Node)
pnpm test:browser # real headless Chrome: DOM fixtures, OPFS, AudioContext, MediaRecorder
pnpm typecheck
pnpm zip          # packed extension in .output/
```

Tests use real dependencies. Integration tests only run when their keys are set, either
in the shell or in a git-ignored `.env.test.local`:

| Variable            | Enables |
|---------------------|---------|
| `GOOGLE_API_KEY`    | Real Gemini transcription and summary tests |
| `NOTION_TOKEN`      | Real Notion writes (with `NOTION_TEST_DB_ID`) |
| `NOTION_TEST_DB_ID` | A scratch database with the schema above, shared with the integration |

A skipped integration test means that path wasn't checked. It is not a pass. CI reads
the same three names from repository secrets and runs the Notion writes only on pushes
to `main`.

Every run of the Notion suite creates a few pages. Keep `NOTION_TEST_DB_ID` in a
single-member or paid workspace, or use a personal access token, so the tests don't use
up the team workspace's Free-plan block allowance.

The audio tests also need `ffmpeg` and `ffprobe` on the `PATH`; tests that need them are
skipped with a reason when they're missing. Browser test files run one at a time,
because real-time audio tests are sensitive to CPU contention.

Layout:

```
entrypoints/content/     caption observer (Meet tab)
entrypoints/background/  session lifecycle, tabCapture, offscreen coordination, recovery, retention
entrypoints/offscreen/   tab + mic mixing, MediaRecorder → OPFS, runs the pipeline
entrypoints/{popup,options,dashboard,permission,routing}/   (dashboard = the Meetings page, options = Settings)
src/lib/meet/captionAdapter.ts   every Meet DOM selector (and only here)
src/lib/transcribe/      Gemini client, two passes, splitting, summary
src/lib/align/           word-sequence alignment
src/lib/merge/           words + captions → speaker-labelled transcript
src/lib/notion/          client, idempotency, page builder
src/lib/pipeline/        orchestration and degradation
tests/fixtures/captions/ saved Meet caption DOM
```

## Known breakage points

These are the places most likely to break silently, and what to check first.

1. **Meet's caption DOM.** Every selector and Meet UI string lives in
   `src/lib/meet/captionAdapter.ts`. The fixtures in `tests/fixtures/captions/` were
   *reconstructed from maintained open-source scrapers*, not captured from a live call.
   During the first real meeting, run the capture snippet in
   `tests/fixtures/captions/README.md` and replace them. Symptoms of breakage: transcripts
   with `Source = audio-only` or "Unknown speaker". The Meet tab's console logs
   `adapterHealth` once per call, showing which hooks matched.
2. **Your own caption label.** Your turns are recognized by Meet's `You` / `Vous` label,
   so use Meet in English or French. In other UI languages your turns keep Meet's label
   instead of your name.
3. **Captions must stay on.** The extension turns them on (at most 3 tries, 3 s apart)
   and never fights you if you turn them off. Without captions there are no speaker
   names; the audio is unaffected. Meet captions follow one spoken-language setting.
   Speakers are matched mainly by timing, so wrong-language captions still give
   speakers, but a captions-only fallback will read poorly.
4. **Starting a recording needs your click.** Chrome only grants tab capture after you
   invoke the extension on that tab: the icon, then **Record this call**, or
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>. Nothing records automatically.
5. **Microphone.** The grant comes only from the permission page. If you picked
   "Allow this time", it expires and later calls record only the other participants
   (the popup says so). On speakers without headphones, remote voices can reach your
   mic. Chrome's echo cancellation of the played-back tab audio hasn't been verified,
   so use headphones.
6. **Gemini.** Model ids are in `src/lib/gemini/models.ts` (`gemini-3.5-transcribe`,
   `gemini-3.5-flash`). Per the docs, word-timestamp requests are capped at 30 min and
   reject `custom_vocabulary`; plain requests are capped at 60 min. That is why there
   are two passes. If either pass fails the other still counts, and the page lists what
   degraded. The integration tests have not yet run against a real key (see
   Development), so the first real transcription is also the first end-to-end check of
   the request shapes and of `store: false`.
7. **Notion.** API version `2026-03-11` (data sources), the property names above, and
   the Free-plan block cap for internal integrations. **Check both databases** in
   Settings checks access and schema but can't check write capability.
8. **Dedupe key.** `<meet code>-<YYYY-MM-DD>` uses each recorder's local date. Two
   teammates in different time zones around midnight get different keys. Two separate
   meetings in the same Meet room on the same day count as one: the second shows as
   *Saved by …* and needs **⋯ › Save a second copy…**. The same happens when you record
   one meeting in two pieces, for example after closing the tab by mistake. Your own
   earlier piece is recognized by your name, so that audio is kept until you act. If two
   teammates save at the same moment, the older page wins (settled within about 20 s).
   A Notion row with an empty `Key` is a save that is still running or was abandoned,
   and dedupe ignores it.
9. **Chrome's recording format.** Long recordings are cut on WebM cluster boundaries.
   Chrome currently writes about one cluster per 5 s chunk, and a browser test asserts
   that layout.
10. **Service worker lifetime.** Recording, transcription and Notion calls run in the
    offscreen document, which reports each job's result as its own message. A worker
    restart therefore doesn't lose a result, and interrupted jobs resume when
    auto-transcribe is on.
11. **Audio failures mid-call.** If the disk quota is hit, a chunk can't be written or
    the recorder dies, audio stops but captions continue until the meeting ends. The
    missing stretch is filled from caption text, and the page notes it. A watchdog
    checks for missing chunks every 30 s. Audio takes about 14 MB per hour.
12. **Tabs opened before an install or update** have no caption observer. It is
    injected when you choose Record this call. If that fails, the popup and Meetings say
    so; reload the Meet tab.
13. **A guest named "You" or "Vous".** Their captions are indistinguishable from your
    own, so their words are attributed to you.
