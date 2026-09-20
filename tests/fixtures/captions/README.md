# Google Meet caption fixtures

**These fixtures were reconstructed, not captured from a live call.** They mirror the
Meet captions DOM as described by actively maintained open-source Meet scrapers
(September 2026), and two anonymized snapshots those projects committed. Replace them
with real captures as soon as someone can run the [capture snippet](#capturing-real-fixtures)
during a call. Everything the extension reads from Meet goes through
`src/lib/meet/captionAdapter.ts`; when Meet changes, update that file and these fixtures.

## What the DOM looks like

```
div[jsname="dsyhDe"].iOzk7                         caption panel
└─ div.vNKgIf.UDinHf[role="region"][tabindex="0"][aria-label="Captions"]
   ├─ div.nMcdL.bj4p3b                             one block per speaker turn
   │  ├─ div.adE6rb                                header
   │  │  ├─ img.Z6byG.r6DyN                        avatar
   │  │  └─ div.KcIKyf.jxFHg > span.NWpY1d         speaker name ("You" for the local user)
   │  └─ div.ygicle.VbkSUe                         caption text (a single text node)
   ├─ div.nMcdL.bj4p3b …
   ├─ div                                          two trailing non-caption children,
   └─ div > button "Jump to bottom"                the last one holds a button
```

Behaviour the tracker and watcher are built around:

- Meet refines the active block **in place**: it edits the text node's data
  (`characterData` mutations); TranscripTonic listens for exactly these.
- Meet also corrects **older** blocks after a new one has started, so any block can
  receive a new revision.
- Old blocks are removed as new ones arrive; newer builds keep a scrollable history
  ("Jump to bottom" / "Jump to the most recent captions").
- The whole region is **recreated** when captions are toggled or the layout changes,
  so observers must re-find it (TranscripTonic and meetcaptioner poll every 2 s).
- A block Meet reuses for another speaker (chen-ye's "node recycling guard") is a new
  segment.
- After a long monologue (~30 min) Meet appears to restart the block with a much shorter
  text (TranscripTonic treats a drop of more than 250 characters as a restart and marks
  it "TO VERIFY IF NEEDED"). The tracker keeps the old text as its own segment.

## UI hooks and strings

| What | Hook used by the adapter (in order) | Confidence |
| --- | --- | --- |
| Captions region | `[jsname="dsyhDe"] [role="region"]`, aria-label `Captions` / `Sous-titres`, `[role="region"].vNKgIf`, then any `[role="region"][tabindex="0"]` holding block-shaped children | EN label and classes in several 2026 sources; `Sous-titres` inferred |
| Block / name / text | `.nMcdL` / `.NWpY1d`, `.KcIKyf` / `.ygicle`, `.VbkSUe`, then block shape (header first, text last) | classes stable in all 2025 to 2026 sources |
| Local user | speaker label `You` (EN), `Vous` (FR) | `You` seen in an anonymized capture; `Vous` from the team, not found in any source |
| CC toggle | `button[jsname="RrG0hf"]` (since the Feb 2026 redesign), `button[jsname="r8qRAd"]` (before), then a button outside the captions region with a `closed_caption(_off)` icon, then one labelled "caption" / "sous-titre" (not settings/language) | jsnames and icons from ChrisRegado; EN labels from attendee and notetaker |
| CC state | icon `closed_caption_off` = off, `closed_caption` = on; then `aria-pressed`; then label `Turn on captions` / `Turn off captions`, `Activer les sous-titres` / `Désactiver les sous-titres` | icon and EN labels observed by others; FR labels inferred from Meet's French mic/camera labels ("Activer le micro") and MeetBot's word lists |
| In call | `button[jsname="CQylAd"]`, label `Leave call` / `Quitter l'appel`, icon `call_end` | all three corroborated; TranscripTonic notes `call_end` also shows while waiting in the lobby |
| Call ended | heading `You left the meeting` / `You've been removed from the meeting` / `Vous avez quitté la réunion`, or a `Return to home screen` / `Revenir à l'écran d'accueil` button | EN strings as in `call-ended.html`; FR inferred. Only speeds up leaving: without it the content script leaves after the leave button has been gone for 3 ticks |
| CC toggle identity | a jsname match must also show a CC icon or a caption label, otherwise the icon and label strategies run; aria-pressed is only read on a control verified that way | guards against a jsname reused on another toggle |
| Meeting title | `[jsname="NeC6gb"]`, `.u6vdEc`, then `document.title` minus `Meet - `; a bare meeting code means "no title" | chen-ye, TranscripTonic |

Some projects (vincelamm/gMeetTranscriptCapture, the hermes-agent Meet bot) cite a
jsname-based caption tree (`tgaKEf`, `YSxPC`, `r4nke`, `bVV8Bd`). No committed capture
backs it and the 2026 snapshots above contradict it, so the adapter does not rely on it.

## Sources

| Project | File | Commit | What it contributed |
| --- | --- | --- | --- |
| [vivek-nexus/transcriptonic](https://github.com/vivek-nexus/transcriptonic) | `extension/content-scripts/google-meet/{config,index}.js`, `common-utils.js` | `0cb5eb5667759cd9cd0bb98d1ce6bdb763a30151` (HEAD, 2026-09-10); selector logic in `8689e50f5f97eb39fd3ecac94217af186c432a7a` (2026-07-17) and `5a40e3ae1114df245b4028096acd66b43f2016a2` (2025-12-23) | region `div[role="region"][tabindex="0"]`, in-place `characterData` edits, trailing non-caption children, region re-attach, `call_end` / `closed_caption_off` icons, `.u6vdEc`, 250-char restart |
| [sanand0/tools](https://github.com/sanand0/tools) | `meetcaptions/__fixtures__/captions-anonymized.html`, `meetcaptions/meetcaptions.js` | `0a20f915932a4cc27885ab2e675058f25fdd1a59` (2026-07-08) | anonymized capture: `[jsname="dsyhDe"]` panel, `.nMcdL` / `.NWpY1d` / `.ygicle`, `You` label |
| [chen-ye/meet-cc-transcript](https://github.com/chen-ye/meet-cc-transcript) | `fixtures/caption-region-sample.html`, `meet-transcript.user.js` | `32fbeba81aacb28b5cf609aae8000108744f2176` (2026-09-09), `36b83db9e9ff9357292db13213120f9784a45765` (2026-09-10) | anonymized region with avatars, CC `aria-pressed` / label state incl. `activer` / `désactiver`, "Jump to bottom", node recycling, title `[jsname="NeC6gb"]` |
| [ChrisRegado/streamdeck-googlemeet](https://github.com/ChrisRegado/streamdeck-googlemeet) | `browser-extension/event_handlers/captions_event_handler.js`, `leave_call_event_handler.js` | `3ab4e06f3b215fe8c3ef6321031c95982ed6b852` (2026-03-01), `913832e0415e4b2a93aa2f274d2759a76da2ab55` | CC jsname `RrG0hf` after the Feb 2026 redesign (`r8qRAd` before), icon-based state, leave `CQylAd` |
| [attendee-labs/attendee](https://github.com/attendee-labs/attendee) | `bots/google_meet_bot_adapter/google_meet_ui_methods.py` | `11d70a1ca936b71146a93bde5cfd24c0599f4444` (2026-09-15) | `Turn on captions` / `Turn off captions`, `button[jsname="CQylAd"][aria-label="Leave call"]` |
| [JamieMcNaught/notetaker](https://github.com/JamieMcNaught/notetaker) | `src/meet-captions.mjs` | `5f59bdf72214f3b749cfbac307be4fe7c35faedc` (2026-08-31) | "Real control from the dump: aria-label="Turn on captions" / icon closed_caption_off", `RrG0hf` |
| [Renater/SIPMediaGW](https://github.com/Renater/SIPMediaGW) | `browsing/assets/googlemeet.js` | `8cb88044f65c87c46b2a34ded52b2277654a23cd` (2026-03-30) | French control labels (`Activer le micro`, `Désactiver la caméra`), leave `CQylAd` |
| [AntoNova1212/MeetBot](https://github.com/AntoNova1212/MeetBot) | `meetbot/meet/locators.py` | `5b434b35586ae38d90bdfb333a673bbcf9e7b8c7` (2026-08-21) | French words `quitter l'appel`, `sous-titres`, `désactiver` |
| [LeHoangTuanbk/meetcaptioner](https://github.com/LeHoangTuanbk/meetcaptioner) | `entrypoints/content/observer.ts` | `2071161226053d6cce345f012a44a22bedec4a83` (2026-01-12) | `[role="region"].vNKgIf.UDinHf`, re-observe when the region is replaced |
| [jueduizone/openclaw-meet](https://github.com/jueduizone/openclaw-meet) | `content/meet.js` | `901d933473a37ff5fd66d7411b971b9d0d9c38ae` (2026-03-25) | tree `dsyhDe > nMcdL > KcIKyf.jxFHg > NWpY1d` + `ygicle.VbkSUe`, "measured 2026" |
| [recallai/chrome-recording-transcription-extension](https://github.com/recallai/chrome-recording-transcription-extension) | `src/scrapingScript.ts` | `ac7f91d51cdf141f8c033b29c39275dfbf1e8bf4` (2025-11-03) | `div[role="region"][aria-label="Captions"]`, `.nMcdL`, `.NWpY1d`, `.ygicle` |

## Fixtures

| File | Shows |
| --- | --- |
| `single-speaker.html` | one block, trailing spacer and jump button |
| `multi-speaker.html` | four blocks, three speakers, French text, a name with an apostrophe and parentheses, multi-line text node |
| `self-you.html` | the local user as `You` |
| `french-ui.html` | French UI: region `Sous-titres`, `Vous`, CC on (`Désactiver les sous-titres`), `Quitter l'appel`, caption-settings button |
| `in-call-captions-off.html` | in-call page, CC off (`closed_caption_off`), no captions region, title element, leave button |
| `in-call-captions-on.html` | same with CC on (`closed_caption`) and a captions region |
| `pre-join.html` | green room: no leave button, title element shows the meeting code |
| `call-ended.html` | "You left the meeting" |
| `rotated-classes.html` | every class and jsname replaced and a UI language the adapter has no strings for (German): only role, tabindex, block shape and icon names remain |
| `revision/01…07-*.html` | one block refined, a word rewritten, a sentence appended, a `You` block, a third speaker, the oldest block removed |

Invented details: the classes and markup of the trailing spacer and jump-button wrapper,
the "Caption settings" button, the toolbar wrapper and its `Call controls` label, and all
names and speech. `data-fixture-block` in `revision/` is test metadata (it lets the
replay test edit matching blocks in place, as Meet does); Meet does not emit it.

## Capturing real fixtures

Run this in a **test call** (the output contains names and what was said). Turn captions
on, open DevTools on the Meet tab, paste the snippet into the Console, then talk for a
minute (switch speakers, pause, correct yourself). It downloads
`meet-captions-capture.json` with the call controls, title, regions, and every distinct
version of the caption panel.

```js
// Manet: record Google Meet's caption DOM for fixtures. Paste into DevTools on a live call.
(async () => {
  const SECONDS = 60;
  const AVATAR = 'https://lh3.googleusercontent.com/a/default-user=s192-c-mo';
  const start = performance.now();
  const scrub = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('img').forEach((img) => {
      img.setAttribute('src', AVATAR);
      img.removeAttribute('srcset');
    });
    copy.querySelectorAll('svg').forEach((svg) => svg.replaceChildren());
    return copy.outerHTML;
  };
  const describe = (el) =>
    el && {
      tag: el.tagName.toLowerCase(),
      jsname: el.getAttribute('jsname'),
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      tooltip: el.getAttribute('data-tooltip'),
      ariaPressed: el.getAttribute('aria-pressed'),
      classes: el.getAttribute('class'),
      icons: [...el.querySelectorAll('i, .google-symbols')].map((i) => i.textContent.trim()),
    };
  const panel = () =>
    document.querySelector('[jsname="dsyhDe"]') ??
    document.querySelector('[role="region"][tabindex="0"]')?.parentElement ??
    null;
  const clickables = [...document.querySelectorAll('button, [role="button"]')];
  const leave = clickables.find((b) => b.textContent.includes('call_end'));
  const capture = {
    capturedAt: new Date().toISOString(),
    lang: document.documentElement.lang,
    navigatorLanguage: navigator.language,
    documentTitle: document.title,
    titleElement: describe(document.querySelector('[jsname="NeC6gb"], .u6vdEc')),
    regions: [...document.querySelectorAll('[role="region"]')].map(describe),
    buttons: clickables.map(describe).filter((b) => b.ariaLabel || b.tooltip || b.jsname),
    toolbarHtml: leave ? scrub(leave.closest('[role="region"]') ?? leave.parentElement.parentElement) : null,
    snapshots: [],
  };
  let last = '';
  let queued = false;
  const snap = () => {
    queued = false;
    const p = panel();
    const html = p ? scrub(p) : '';
    if (html === last) return;
    last = html;
    capture.snapshots.push({ t: Math.round(performance.now() - start), html });
  };
  const observer = new MutationObserver(() => {
    if (!queued) {
      queued = true;
      setTimeout(snap, 100);
    }
  });
  snap();
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  console.log(`[manet] recording the caption DOM for ${SECONDS} s, start talking`);
  await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
  observer.disconnect();
  snap();
  window.__manetCapture = capture;
  const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: 'meet-captions-capture.json' }).click();
  console.log(`[manet] ${capture.snapshots.length} panel snapshots captured`, capture);
})();
```

To turn a capture into fixtures:

1. Check `buttons` for the CC toggle and the leave button: their `jsname`, `ariaLabel`
   and `icons` are what `captionAdapter.ts` matches. Record them in the table above.
2. Paste one snapshot's `html` into a fixture's `<body>` (with `toolbarHtml` for the
   in-call pages), then replace every real name and sentence.
3. For `revision/`, take consecutive snapshots, add the same `data-fixture-block="bN"`
   to the block that persists across them, and keep one file per step.
4. Run `pnpm vitest run --project browser tests/captions` and fix the adapter until the
   real fixtures pass.
