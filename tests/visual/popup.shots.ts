/**
 * Every state of the toolbar popup (direction-native.md › Surface: popup), light and dark,
 * at the popup's 360 px width, plus 150% text. Each shot is as tall as its content, like
 * the real popup, up to Chrome's 600 px cap (the body scrolls past it, the footer stays).
 * The `cap-*` shots are a fixed 360 × 600 window and assert that the footer stays in view
 * and nothing scrolls sideways.
 * The `fallback-*` shots are the toolbar — one of the three glass surfaces — under each
 * accessibility setting that drops or keeps the material, on a popup long enough to scroll
 * (and one that fits, for the mode the two take differently).
 */
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import {
  createPopupView,
  type PopupHandlers,
  type PopupModel,
  type PopupState,
} from '@lib/ui/popupView';
import popupHtml from '../../entrypoints/popup/index.html?raw';
import { FMT, gallery, type Media, never, ok, shell, type Shot } from './harness';
import { NOW, SESSIONS, session } from './scenarios';

const MIN = 60_000;
const STARTED = NOW - 23 * MIN - 14_000;
const ELAPSED = NOW - STARTED;

type Recording = Extract<PopupState, { kind: 'recording' }>;

const speaker = (name: string, firstAt: number, lastAt: number, self = false): SpeakerInfo => ({
  name,
  self,
  firstAt,
  lastAt,
  talkMs: lastAt - firstAt,
});

/** Marie, then Tom (speaking now), then you. */
const ROLL: SpeakerInfo[] = [
  speaker('Marie Curie', 12_000, ELAPSED - 40_000),
  speaker('Tom Martin', 30_000, ELAPSED - 2_000),
  speaker('You', 45_000, ELAPSED - 100_000, true),
];

const BIG_ROLL: SpeakerInfo[] = [
  speaker('Marie Curie', 12_000, ELAPSED - 40_000),
  speaker('Tom Martin', 30_000, ELAPSED - 60_000),
  speaker('You', 45_000, ELAPSED - 100_000, true),
  speaker('Jean-Baptiste Delacroix-Montmorency', 60_000, ELAPSED - 3_000),
  speaker('Sofia Oliveira', 90_000, ELAPSED - 200_000),
  speaker('Camille Martin', 120_000, ELAPSED - 300_000),
  speaker('Yasser', 150_000, ELAPSED - 500_000),
  speaker('Ilya K', 200_000, ELAPSED - 700_000),
  speaker('Priya Raman', 260_000, ELAPSED - 800_000),
];

function recording(patch: Partial<Recording> = {}): Recording {
  return {
    kind: 'recording',
    sessionId: 'rec',
    startedAt: STARTED,
    meetCode: 'qrs-tuvw-xyz',
    title: 'Weekly product sync',
    thisTab: true,
    tabId: 1,
    micIncluded: true,
    lastChunkAt: NOW - 2_000,
    captionCount: 214,
    speakers: ROLL,
    ...patch,
  };
}

const onCall: PopupState = { kind: 'idle', tabId: 1, meetCode: 'abc-defg-hij', title: 'Weekly product sync' };
const RECENT = SESSIONS.filter((s) => s.status !== 'recording');
const LONG_TITLE = 'Onboarding — Lumind × Nova: pricing, pilots and the Q4 roadmap review';

function model(state: PopupState, patch: Partial<PopupModel> = {}): PopupModel {
  return {
    state,
    mic: 'granted',
    includeMic: true,
    setup: [],
    geminiKeyMissing: false,
    recent: [],
    needsYou: 0,
    shortcut: 'Alt+Shift+R',
    ...patch,
  };
}

function handlers(patch: Partial<PopupHandlers> = {}): PopupHandlers {
  return {
    record: ok,
    stop: ok,
    goToCall: () => {},
    grantMic: () => {},
    openSettings: () => {},
    openDashboard: () => {},
    openNotion: () => {},
    ...patch,
  };
}

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

interface Options {
  now?: number;
  handlers?: Partial<PopupHandlers>;
  /** Runs after the first update: clicks, a second model… */
  then?: (root: HTMLElement, update: (m: PopupModel, now?: number) => void) => Promise<void> | void;
  /** Chrome's font-size setting at 150%. */
  largeText?: boolean;
}

function popup(name: string, m: PopupModel | null, o: Options = {}): Shot {
  return {
    name: `popup-${name}`,
    width: 360,
    height: 120,
    full: true,
    async render() {
      document.documentElement.style.fontSize = o.largeText ? '150%' : '';
      const root = shell(popupHtml);
      document.body.scrollTop = 0; // the body element outlives each shot; a capped one may have scrolled it
      const view = createPopupView(root, handlers(o.handlers), { format: FMT });
      const update = (next: PopupModel, at = o.now ?? NOW) => view.update(next, at);
      if (m) update(m);
      else await settle(350);
      await o.then?.(root, update);
    },
  };
}

/** Chrome's popup window at its cap: 360 × 600. Fails the shot if the footer leaves the
 * window or anything scrolls sideways. */
function capped(name: string, m: PopupModel, o: Options & { scrollToEnd?: boolean } = {}): Shot {
  const base = popup(name, m, o);
  return {
    ...base,
    height: 600,
    full: false,
    async render() {
      await base.render();
      await settle(50);
      const body = document.body;
      if (o.scrollToEnd) body.scrollTop = body.scrollHeight;
      const foot = document.querySelector('.popup-foot')!.getBoundingClientRect();
      const html = document.documentElement;
      const problems = [
        foot.bottom > window.innerHeight + 0.5 && `footer ends at ${foot.bottom} px, below the ${window.innerHeight} px window`,
        foot.top < 0 && `footer starts at ${foot.top} px`,
        body.scrollWidth > body.clientWidth && `body scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`,
        html.scrollWidth > html.clientWidth && `window scrolls sideways (${html.scrollWidth} > ${html.clientWidth})`,
        html.scrollHeight > html.clientHeight && `window scrolls (${html.scrollHeight} > ${html.clientHeight}); only the body should`,
      ].filter(Boolean);
      if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
    },
  };
}

/** Recording, then Stop from here: the idle state with the "Stopped" note. */
const stopThen = (next: PopupModel): Options['then'] => async (root, update) => {
  hero(root).click();
  await settle();
  update(next);
  await settle(250);
};

const hero = (root: HTMLElement) => root.querySelector<HTMLButtonElement>('[data-role="hero"] button')!;

const recentFor = (...ids: string[]): SessionMeta[] => ids.map((id) => RECENT.find((s) => s.id === id)!);

/** Every block the on-a-call popup can show at once. */
const TALLEST = model(
  { kind: 'idle', tabId: 1, meetCode: 'abc-defg-hij', title: LONG_TITLE },
  { mic: 'denied', setup: ['name', 'token', 'team-database'], recent: recentFor('route', 'proc', 'saved'), needsYou: 3 },
);

/* Playwright has no prefers-reduced-transparency knob, so that fallback is shown by
 * injecting exactly what the media query sets in styles.css: the tokens, and the
 * toolbar's own rules (the opaque fill and the hairline that replaces the material). */
const REDUCED_TRANSPARENCY_CSS =
  ':root{--glass-blur:0px;--glass-blur-edge:0px;--glass-sat:1;--glass-bar:var(--glass-opaque);' +
  '--glass-menu:var(--surface);--glass-spec:transparent;--glass-rim:var(--border);--tint-glass:var(--tint);}' +
  '.popup-foot,.popup-foot.is-flat{animation-name:none;background:var(--glass-opaque);' +
  'box-shadow:0 -1px 0 var(--glass-rim);}.popup-foot::before{display:none;}';

/**
 * Each accessibility fallback, photographed on the one popup whose toolbar is really
 * glass: the tallest on-a-call state, past Chrome's cap, so the body scrolls, the
 * timeline is live and content passes under the bar. The flat and the glass toolbars
 * take different paths through styles.css, and only this one takes the glass path — so
 * this is where the material going opaque has to hand its boundary back.
 * `short` photographs a popup that fits instead: its toolbar is the flat opaque bar in
 * every mode but reduced motion, which has no way to ask whether the popup scrolls and
 * takes the material anyway.
 */
function fallback(mode: string, o: { media?: Media; reducedTransparency?: boolean; short?: boolean } = {}): Shot {
  const base = o.short
    ? popup(`fallback-${mode}`, model(onCall, { mic: 'prompt', recent: recentFor('route', 'proc', 'saved'), needsYou: 2 }))
    : capped(`fallback-${mode}`, model(recording()), { then: stopThen(TALLEST) });
  return {
    ...base,
    media: o.media,
    async render() {
      await base.render();
      // shell() replaces the body's children, so this style never reaches the next shot.
      if (o.reducedTransparency) {
        const css = document.createElement('style');
        css.textContent = REDUCED_TRANSPARENCY_CSS;
        document.body.append(css);
      }
    },
  };
}

gallery('popup', [
  // A · Recording, healthy: the roll, the latest speaker underlined.
  popup('recording', model(recording())),
  popup('recording-just-started', model(recording({ startedAt: NOW - 9_000, captionCount: 0, speakers: [], lastChunkAt: NOW - 4_000 }))),
  // B · Recording with problems.
  popup(
    'recording-no-captions-no-audio',
    model(
      recording({
        title: undefined,
        meetCode: 'hhh-iiii-jjj',
        startedAt: NOW - 47_000,
        captionCount: 0,
        speakers: [],
        audioError: 'Tab audio capture failed.',
      }),
    ),
  ),
  popup('recording-audio-stalled', model(recording({ lastChunkAt: NOW - 22_000 }))),
  popup('recording-captions-quiet', model(recording({ speakers: ROLL.map((s) => ({ ...s, lastAt: s.lastAt - 3 * MIN })) }))),
  popup(
    'recording-captions-off',
    model(recording({ speakers: ROLL.map((s) => ({ ...s, lastAt: s.lastAt - 6 * MIN })), micIncluded: false }), {
      includeMic: false,
    }),
  ),
  popup(
    'recording-captions-error',
    model(
      recording({
        speakers: [],
        captionCount: 0,
        captionsError: 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.',
      }),
    ),
  ),
  popup('recording-many-speakers', model(recording({ speakers: BIG_ROLL, title: 'Client call — Halstead audit pilot, Q4 scoping' }))),
  popup('recording-other-tab', model(recording({ thisTab: false }), { needsYou: 1 })),
  // C · On a call, ready.
  popup('on-call', model(onCall, { mic: 'prompt', recent: recentFor('route', 'proc', 'saved'), needsYou: 2 })),
  popup('on-call-mic-blocked', model({ kind: 'idle', tabId: 1, meetCode: 'abc-defg-hij' }, { mic: 'denied' })),
  popup(
    'on-call-long-title-setup',
    model(
      { kind: 'idle', tabId: 1, meetCode: 'abc-defg-hij', title: LONG_TITLE },
      { mic: 'granted', includeMic: false, setup: ['token', 'team-database'] },
    ),
  ),
  // Starting…, then the start failed.
  popup('on-call-starting', model(onCall), {
    handlers: { record: never },
    then: (root) => hero(root).click(),
  }),
  popup('on-call-start-failed', model(onCall), {
    handlers: { record: () => Promise.reject(new Error('Another tab is already recording.')) },
    then: async (root) => {
      hero(root).click();
      await settle();
    },
  }),
  // Record → Recording: the one orchestrated moment (shot after the 200 ms cross-fade).
  popup('record-to-stop', model(onCall), {
    then: async (root, update) => {
      hero(root).click();
      await settle();
      update(model(recording({ startedAt: NOW - 1_000, captionCount: 0, speakers: [], lastChunkAt: NOW })));
      await settle(250);
    },
  }),
  // Stopped from here: the idle state says where the choice happens.
  popup('stopped', model(recording()), { then: stopThen(model(onCall, { recent: recentFor('route', 'proc', 'saved'), needsYou: 3 })) }),
  // D · Not on a call, setup missing, Recent.
  popup(
    'not-meet-setup-recent',
    model({ kind: 'not-meet', onMeet: false }, { setup: ['name', 'token', 'team-database'], recent: recentFor('route', 'proc', 'saved'), needsYou: 1 }),
  ),
  popup(
    'on-meet-no-gemini-recent',
    model({ kind: 'not-meet', onMeet: true }, { geminiKeyMissing: true, recent: recentFor('saved', 'dup', 'failed'), needsYou: 0 }),
  ),
  popup(
    'not-meet-recent-needs-you',
    model(
      { kind: 'not-meet', onMeet: false },
      {
        recent: [
          session('p1', { status: 'processed', meetingTitle: 'Sales pipeline review', startedAt: NOW - 50 * MIN, durationMs: 36 * MIN }),
          session('e1', { status: 'empty', meetCode: 'efg-hijk-lmn', startedAt: NOW - 26 * 60 * MIN, durationMs: 40_000 }),
          session('r1', { status: 'ready', meetingTitle: 'Board prep', startedAt: NOW - 3 * 24 * 60 * MIN, durationMs: 19 * MIN }),
        ],
        needsYou: 1,
        shortcut: null,
      },
    ),
  ),
  popup('not-meet-empty', model({ kind: 'not-meet', onMeet: false })),
  popup('loading', null),
  // Keyboard focus on the hero and in the footer.
  popup('focus-hero', model(recording()), { then: (root) => hero(root).focus() }),
  popup('focus-link', model(onCall, { mic: 'prompt' }), {
    then: (root) => root.querySelector<HTMLElement>('[data-key="grant-mic"]')!.focus(),
  }),
  // 150% text: the fact list stacks (container query at 18em), nothing clips.
  popup('large-text-recording', model(recording()), { largeText: true }),
  popup('large-text-on-call', model(onCall, { mic: 'prompt', recent: recentFor('route', 'proc', 'saved'), needsYou: 2 }), {
    largeText: true,
  }),
  popup('large-text-not-meet-recent', model({ kind: 'not-meet', onMeet: false }, { recent: recentFor('route', 'proc', 'failed'), needsYou: 1 }), {
    largeText: true,
  }),
  // Chrome's cap: the tallest on-a-call popup (long title, mic prompt, Stopped note, setup
  // callout; Recent stays off on a call), at 100% and 150% text, and scrolled to the end.
  capped('cap-on-call-everything', model(recording()), { then: stopThen(TALLEST) }),
  capped('cap-large-text-on-call-everything', model(recording()), { largeText: true, then: stopThen(TALLEST) }),
  capped('cap-large-text-on-call-everything-scrolled', model(recording()), {
    largeText: true,
    scrollToEnd: true,
    then: stopThen(TALLEST),
  }),
  capped(
    'cap-large-text-not-meet-setup-recent',
    model({ kind: 'not-meet', onMeet: false }, { setup: ['name', 'token', 'team-database'], recent: recentFor('route', 'proc', 'saved'), needsYou: 1 }),
    { largeText: true },
  ),
  // Keyboard focus on the toolbar's own link while the bar is material: the ring has to
  // read on glass, not only on the flat bar (popup-focus-link).
  capped('focus-foot-link-on-glass', model(recording()), {
    then: async (root, update) => {
      await stopThen(TALLEST)!(root, update);
      root.querySelector<HTMLElement>('[data-key="dashboard"]')!.focus({ preventScroll: true });
    },
  }),
  // Each accessibility fallback on the glass toolbar. Reduced transparency and more
  // contrast drop the material and must put a hairline back; forced colours replaces it
  // with a single CanvasText rule (one, not one per layer); reduced motion keeps the
  // material for good, because the material is legibility rather than motion.
  fallback('reduced-motion', { media: { reducedMotion: true } }),
  fallback('contrast-more', { media: { moreContrast: true } }),
  fallback('forced-colors', { media: { forcedColors: true } }),
  fallback('reduced-transparency', { reducedTransparency: true }),
  // The one fallback a popup that fits takes differently: reduced motion cannot ask
  // whether the popup scrolls, so the toolbar keeps the material over a page that never
  // moves under it — where the blur has nothing to blur and only a boundary separates
  // the bar from the page.
  fallback('reduced-motion-short', { media: { reducedMotion: true }, short: true }),
]);
