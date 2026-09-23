/**
 * The toolbar popup. No header: the state is the headline, with one button per state.
 *
 *   Recording      ● Recording 12:48 / title · code / Speakers (the roll) + Audio / Profile / Stop recording
 *   On a call      title / Meet call code / Speakers + Audio / Profile / Record this call
 *   Not on a call  No call in this tab / what to do
 *   Not recording  + one setup block (▲ callout when saving is blocked, else the ⓘ Gemini note)
 *   Not on a call  + Recent (the last 3 meetings)
 *   Always         footer: Meetings (· N needs you) and Settings
 *
 * The signature is the roll: the names Meet's captions produced so far, in order of first
 * speech, the latest speaker marked by colour and a 2 px underline (never a weight swap,
 * so the line never re-flows when the speaker changes).
 *
 * The pure functions (popupState, speakersFact, audioFact, rollEntries, recentRow…) turn state
 * into words and are tested without a DOM. What counts as a recording problem is not decided
 * here: speakersFact and audioFact word what recordingHealth finds, the rules the Meetings
 * row and the toolbar's "!" follow too. Dates, times and lengths are sessionView's, so the
 * popup and Meetings write them alike. createPopupView keeps four things
 * persistent so they are patched, not rebuilt: the hero button (Record → Stop cross-fades
 * in place, and a click on it is never lost to a re-render), the Profile row (its button
 * keeps focus and anchors the profile menu), the roll (only new names fade in) and the clock.
 *
 * The Profile row (with more than one profile): before recording, the popup's own pick,
 * which Record passes on (the default profile until one is picked; the page remembers it
 * for the browser session and hands it back in the model); while recording, the
 * recording's profile, changed in the background.
 */
import { meetCodeFromUrl } from '../meet/meetCode';
import { defaultProfile } from '../profiles';
import { minutesText, recordingHealth, silenceText, type RecordingHealth } from '../recordingHealth';
import type { ActiveRecording } from '../storage/sessionStore';
import type { Profile, SessionMeta, Settings, SpeakerInfo } from '../types';
import {
  button,
  callout,
  factList,
  isInert,
  kbd,
  note,
  setBusy,
  setDisabled,
  toneGlyph,
  visuallyHidden,
  type Fact,
  type Tone,
} from './controls';
import { h, keepFocus, mount, type Child } from './dom';
import { svg } from './icons';
import { createMenu, menuButtonAttrs, menuButtonKeys, type MenuItem } from './menu';
import type { MicPermission } from './mic';
import { failureKind, formatLength, formatTime, stageStep, statusView, whenText, type FormatOptions } from './sessionView';
import type { FieldName } from './settingsForm';

export type { FormatOptions } from './sessionView';

// ---------------------------------------------------------------------------------------
// State

export type PopupState =
  /** `onMeet`: on meet.google.com but not in a call (home page, landing page). */
  | { kind: 'not-meet'; onMeet: boolean }
  /** On a call that isn't being recorded. `title` comes from the tab title, when Meet puts one there. */
  | { kind: 'idle'; tabId: number; meetCode: string; title?: string }
  | {
      kind: 'recording';
      sessionId: string;
      startedAt: number;
      meetCode: string;
      title?: string;
      /** The recording belongs to the active tab. */
      thisTab: boolean;
      /** The tab being recorded ("Go to call"). */
      tabId: number;
      /** Set when audio could not be captured: captions only. */
      audioError?: string;
      /** The recorder mixed in the microphone. */
      micIncluded: boolean;
      /** Last time an audio chunk was stored (epoch ms). */
      lastChunkAt?: number;
      /** Caption batches received so far. */
      captionCount: number;
      /** Why captions are not reaching the extension, when the background knows. */
      captionsError?: string;
      /** The roll, from the session meta (ordered by first speech). */
      speakers?: SpeakerInfo[];
      /** The recording's profile (a Settings.profiles id); absent: the default one. */
      profileId?: string;
    };

export interface PopupInput {
  tab: { id?: number; url?: string; title?: string } | null;
  active: ActiveRecording | null;
  /** The session the active-recording pointer names, if any. */
  session: SessionMeta | null;
}

const TAB_TITLE_PREFIX = /^(google\s+)?meet\s*[-–—:]\s*/i;
const TAB_TITLE_SUFFIX = /\s*[-–—:]\s*(google\s+)?meet$/i;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;

/** "Meet - Weekly product sync" → "Weekly product sync"; nothing when Meet only shows the code. */
export function meetTitleFromTab(tabTitle: string | undefined, meetCode: string): string | undefined {
  const title = (tabTitle ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(TAB_TITLE_PREFIX, '')
    .replace(TAB_TITLE_SUFFIX, '')
    .trim();
  if (!title || title.toLowerCase() === meetCode.toLowerCase() || MEET_CODE.test(title)) return undefined;
  if (/^(google\s+)?meet$/i.test(title)) return undefined;
  return title;
}

export function popupState({ tab, active, session }: PopupInput): PopupState {
  if (active && session && session.id === active.sessionId && session.status === 'recording') {
    const state: Extract<PopupState, { kind: 'recording' }> = {
      kind: 'recording',
      sessionId: session.id,
      startedAt: session.startedAt,
      meetCode: session.meetCode,
      thisTab: tab?.id === active.tabId,
      tabId: active.tabId,
      micIncluded: session.audio.micIncluded,
      captionCount: session.captionCount,
    };
    const title = session.meetingTitle?.trim();
    if (title) state.title = title;
    if (session.audio.error) state.audioError = session.audio.error;
    if (session.audio.lastChunkAt !== undefined) state.lastChunkAt = session.audio.lastChunkAt;
    if (session.captionsError) state.captionsError = session.captionsError;
    if (session.speakers) state.speakers = session.speakers;
    if (session.profileId) state.profileId = session.profileId;
    return state;
  }
  const url = tab?.url ?? '';
  const tabId = tab?.id;
  const meetCode = meetCodeFromUrl(url);
  if (meetCode && tabId !== undefined) {
    const idle: Extract<PopupState, { kind: 'idle' }> = { kind: 'idle', tabId, meetCode };
    const title = meetTitleFromTab(tab?.title, meetCode);
    if (title) idle.title = title;
    return idle;
  }
  let onMeet = false;
  try {
    onMeet = new URL(url).hostname === 'meet.google.com';
  } catch {
    onMeet = false;
  }
  return { kind: 'not-meet', onMeet };
}

// ---------------------------------------------------------------------------------------
// The roll and the facts

/** Whoever's caption changed this recently is "speaking" (the roll's mark, not a health rule). */
export const SPEAKING_WITHIN_MS = 8_000;
/**
 * Longer names are cut with an ellipsis: one name (about 175 px) then still shares a line
 * with "· +5 more" in the 244 px value column, and can't push the roll out of the popup.
 */
const MAX_NAME_CHARS = 24;

export interface RollEntry {
  /** Stable per person: the key the view patches by. */
  key: string;
  name: string;
  speaking: boolean;
}

function shortName(name: string): string {
  return name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1).trimEnd()}…` : name;
}

/** The roll: everyone named so far, "You" for the local user, the latest speaker marked. */
export function rollEntries(speakers: readonly SpeakerInfo[], elapsedMs: number): RollEntry[] {
  let latest = -1;
  speakers.forEach((s, i) => {
    if (latest < 0 || s.lastAt > speakers[latest]!.lastAt) latest = i;
  });
  const speaking = latest >= 0 && elapsedMs - speakers[latest]!.lastAt <= SPEAKING_WITHIN_MS ? latest : -1;
  return speakers.map((s, i) => ({
    key: s.self ? 'self' : `name:${s.name.toLocaleLowerCase()}`,
    name: s.self ? 'You' : shortName(s.name),
    speaking: i === speaking,
  }));
}

export interface FactView {
  label: 'Speakers' | 'Audio';
  /** Text, or the live roll. */
  value: string | { roll: RollEntry[] };
  /** ▲ + caution colour on the value line. */
  tone?: 'caution';
  /** A ▲ line under the value that leaves the value (the roll) readable. */
  warning?: string;
  /** --label-2 explanation. */
  detail?: string;
  /** An inline link after the detail. */
  action?: { key: 'grant-mic'; label: string };
}

type RecordingState = Extract<PopupState, { kind: 'recording' }>;

/** The recording's health by the shared rules, from what the popup state carries of the meta. */
function healthOf(state: RecordingState, now: number): RecordingHealth {
  return recordingHealth(
    {
      startedAt: state.startedAt,
      audio: { error: state.audioError, lastChunkAt: state.lastChunkAt },
      captionCount: state.captionCount,
      speakers: state.speakers,
      captionsError: state.captionsError,
    },
    now,
  );
}

/** Speakers while recording: the roll, or what stands in the way of it. */
export function speakersFact(state: RecordingState, now: number): FactView {
  const { captions, captionsNote } = healthOf(state, now);
  if (captions?.kind === 'blocked') {
    return { label: 'Speakers', tone: 'caution', value: 'Captions aren’t coming through', detail: captions.reason };
  }
  const speakers = state.speakers ?? [];
  if (speakers.length > 0) {
    const roll = { roll: rollEntries(speakers, now - state.startedAt) };
    if (captions?.kind === 'quiet') {
      return {
        label: 'Speakers',
        value: roll,
        warning: `No captions for ${minutesText(captions.quietMs)}`,
        detail: 'If people are talking, check that captions (CC) are on in Meet.',
      };
    }
    if (captionsNote) return { label: 'Speakers', value: roll, detail: `Last caption ${minutesText(captionsNote.quietMs)} ago` };
    return { label: 'Speakers', value: roll };
  }
  if (captions?.kind === 'none-yet') {
    return {
      label: 'Speakers',
      tone: 'caution',
      value: 'None yet — turn on captions (CC) in Meet',
      detail: 'Without captions, the transcript can’t name who spoke.',
    };
  }
  if (state.captionCount > 0) {
    return { label: 'Speakers', value: 'No names yet', detail: 'Captions are coming in, but Meet hasn’t named a speaker.' };
  }
  return { label: 'Speakers', value: 'None yet', detail: 'Names appear here as Meet’s captions show them.' };
}

const MIC_OFF_IN_SETTINGS = 'Call only (mic off in Settings)';

/**
 * Audio: while recording, what the recorder actually captures; on a call, what it would
 * capture, with the way to fix the mic when Chrome hasn't allowed it.
 */
export function audioFact(state: PopupState, mic: MicPermission, includeMic: boolean, now: number): FactView {
  if (state.kind === 'recording') {
    const { audio } = healthOf(state, now);
    if (audio?.kind === 'lost') {
      return { label: 'Audio', tone: 'caution', value: 'No call audio — saving captions only', detail: audio.reason };
    }
    if (audio?.kind === 'stalled') {
      return {
        label: 'Audio',
        tone: 'caution',
        value: `No audio for ${silenceText(audio.silentMs)}`,
        detail: 'Captions are still being saved. If audio doesn’t resume, the transcript will come from captions.',
      };
    }
    if (state.micIncluded) return { label: 'Audio', value: 'Call and your mic' };
    if (!includeMic) return { label: 'Audio', value: MIC_OFF_IN_SETTINGS };
    return {
      label: 'Audio',
      value: 'Call only',
      detail: 'Chrome didn’t allow your mic when this recording started, so your voice isn’t in it.',
    };
  }
  if (!includeMic) return { label: 'Audio', value: MIC_OFF_IN_SETTINGS };
  switch (mic) {
    case 'granted':
      return { label: 'Audio', value: 'Call and your mic' };
    case 'denied':
      return {
        label: 'Audio',
        value: 'Call only',
        detail: 'Chrome blocks your mic for Manet Meetings, so your voice won’t be in the recording.',
        action: { key: 'grant-mic', label: 'Fix in Chrome…' },
      };
    case 'prompt':
    case 'unknown':
      return {
        label: 'Audio',
        value: 'Call only',
        detail: 'Your mic isn’t allowed yet, so your voice won’t be in the recording.',
        action: { key: 'grant-mic', label: 'Allow microphone…' },
      };
  }
}

/** Speakers before recording: where the names will come from. */
export const IDLE_SPEAKERS: FactView = {
  label: 'Speakers',
  value: 'From Meet’s captions',
  detail: 'Captions turn on when you record.',
};

// ---------------------------------------------------------------------------------------
// Setup

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

function profileName(m: Pick<PopupModel, 'profiles'>, id: string | undefined): string {
  return m.profiles.find((p) => p.id === id)?.name ?? m.profiles[0]?.name ?? '';
}

// ---------------------------------------------------------------------------------------
// Time and Recent

/** 12:48 under an hour, 1:02:05 after. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  const mmss = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export interface RecentRowView {
  id: string;
  tone: Tone;
  /** Meet's title, or the Meet code (`isCode`, set in mono). */
  title: string;
  isCode: boolean;
  /** The glossary's status word, first on the second line of every row. */
  status: string;
  /** Saved: "Open in Notion" trails the title. */
  notionUrl?: string;
  /**
   * What follows the status on the same line, most useful first: the step or the retry,
   * when, how long, where. The line keeps one line: whatever doesn't fit drops out whole,
   * from the end.
   */
  details: string[];
}

/**
 * One Recent row: glyph + title (+ Open in Notion) / status · when · how long · where.
 * "Today 14:02", "Wed 16 Sep 14:02" and "32 min" as Meetings writes them.
 * Where is the meeting's profile, named from `profileNames` (every profile's name by id);
 * nothing when that profile was deleted since.
 */
export function recentRow(
  meta: SessionMeta,
  now: number,
  opts: FormatOptions = {},
  profileNames?: ReadonlyMap<string, string>,
): RecentRowView {
  const title = meta.meetingTitle?.trim();
  const when = whenText(meta.startedAt, now, opts);
  const durationMs = meta.durationMs ?? (meta.endedAt !== undefined ? meta.endedAt - meta.startedAt : undefined);
  const length = durationMs === undefined ? null : formatLength(durationMs);
  const where = (meta.profileId && profileNames?.get(meta.profileId)) || null;
  const list = (...parts: (string | null)[]) => parts.filter((p): p is string => Boolean(p));
  const row = { id: meta.id, title: title || meta.meetCode, isCode: !title };
  const saved = (status: string, details: string[]): RecentRowView =>
    meta.notion ? { ...row, tone: 'done', status, notionUrl: meta.notion.url, details } : { ...row, tone: 'done', status, details };

  switch (meta.status) {
    case 'recording':
      return { ...row, tone: 'live', status: 'Recording', details: [when] };
    case 'ready':
      return { ...row, tone: 'neutral', status: 'Not transcribed', details: list(when, length, where) };
    case 'processing':
    case 'saving':
      // The Meetings row's word and step (sessionView), so both surfaces count the same.
      return { ...row, tone: 'working', status: statusView(meta).label, details: [`Step ${stageStep(meta)} of 8`, when] };
    case 'processed':
      return { ...row, tone: 'caution', status: 'Transcribed, not saved yet', details: list(when, length, where) };
    case 'saved':
      return saved('Saved to Notion', list(when, length, where));
    case 'duplicate':
      return saved(`Saved by ${meta.notion?.recordedBy?.trim() || 'a teammate'}`, list(when, length));
    case 'empty':
      return { ...row, tone: 'none', status: 'Nothing to save', details: list(when, length) };
    case 'failed': {
      // The same rule Meetings uses (a stored transcript can't be known here, hence false).
      const status = failureKind(meta, false) === 'save' ? 'Couldn’t save to Notion' : 'Couldn’t transcribe';
      const details = meta.retryAt === undefined ? list(when, length, where) : [`Trying again at ${formatTime(meta.retryAt, opts)}`, when];
      return { ...row, tone: 'caution', status, details };
    }
  }
}

/** "Meetings", "Meetings · 1 needs you", "Meetings · 3 need you". */
export function meetingsLabel(needsYou: number): string {
  if (needsYou <= 0) return 'Meetings';
  return `Meetings · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`;
}

// ---------------------------------------------------------------------------------------
// View

export interface PopupModel {
  state: PopupState;
  mic: MicPermission;
  /** Settings › Include my microphone. */
  includeMic: boolean;
  /** What blocks saving to Notion (empty: nothing). */
  setup: readonly SetupGap[];
  /** Every profile, in Settings order: the Profile row's choices. */
  profiles: readonly Pick<Profile, 'id' | 'name'>[];
  defaultProfileId: string;
  /**
   * The profile last picked in the popup this browser session (rememberProfile); it may
   * name a profile deleted since, and then the default applies.
   */
  pickedProfileId?: string;
  /** No Gemini key: meetings are still saved, with a captions-only transcript. */
  geminiKeyMissing: boolean;
  /** Settings › auto-transcribe: a meeting is transcribed when its call ends. */
  autoTranscribe: boolean;
  /** Latest meetings, newest first; the popup shows 3 when not on a call. */
  recent: readonly SessionMeta[];
  /** Meetings that wait on the person (sessionStore.needsYou). */
  needsYou: number;
  /** The record shortcut from commands.getAll(), or null when unset. */
  shortcut: string | null;
}

export interface PopupHandlers {
  /** Records `tabId` for `profileId`; rejects with a user-facing reason when it could not start. */
  record(tabId: number, profileId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** Changes the recording's profile; rejects with a user-facing reason. */
  setProfile(sessionId: string, profileId: string): Promise<void>;
  /** Keeps the profile picked before recording for the next time the popup opens. */
  rememberProfile(profileId: string): void;
  /** Focuses the tab being recorded. */
  goToCall(tabId: number): void;
  grantMic(): void;
  /** Opens Settings, on `field` when a specific setting is missing. */
  openSettings(field?: FieldName): void;
  openDashboard(): void;
  openNotion(url: string): void;
}

export interface PopupView {
  update(model: PopupModel, now: number): void;
}

export interface PopupViewOptions {
  format?: FormatOptions;
  /** Monotonic ms clock for the hero guard; performance.now() by default. */
  clock?: () => number;
}

/** After the hero button changes action in place (Record ⇄ Stop), clicks are ignored this long. */
export const HERO_GUARD_MS = 800;
/** "Checking this tab…" only appears if the first state takes longer than this. */
export const LOADING_DELAY_MS = 300;
export const RECENT_COUNT = 3;

type HeroAction = 'record' | 'stop';
/** A request the popup sends: the hero's, or a change of the recording's profile. */
type Request = HeroAction | 'profile';

const FAILED: Record<Request, string> = {
  record: 'Couldn’t start recording',
  stop: 'Couldn’t stop recording',
  profile: 'Couldn’t change the profile',
};

interface RollItem {
  el: HTMLSpanElement;
  name: HTMLSpanElement;
  speaking: HTMLSpanElement;
  sep: HTMLSpanElement;
}

export function createPopupView(root: HTMLElement, handlers: PopupHandlers, options: PopupViewOptions = {}): PopupView {
  const fmt = options.format ?? {};
  const clock = options.clock ?? (() => performance.now());
  let model: PopupModel | null = null;
  let now = 0;
  /** The hero's request, while it runs. */
  let busy: HeroAction | null = null;
  /** A change of the recording's profile is on its way. */
  let profileBusy = false;
  /** Picked in this popup; until then the model's remembered pick (else the default) applies. */
  let pickedProfileId: string | null = null;
  let error: string | undefined;
  let heroAction: HeroAction | null = null;
  let heroArmedAt = Number.NEGATIVE_INFINITY;
  let shownKind: PopupState['kind'] | null = null;
  const sigs = new Map<string, string>();

  const slot = (tag: 'div' | 'section', attrs: Record<string, string> = {}) => h(tag, { ...attrs, hidden: true });
  const headSlot = h('div', { class: 'state-head-block' });
  const factsSlot = h('div', { class: 'state-facts', hidden: true });
  // An inset grouped card (styles.css › .popup-card): the state is the popup's content layer.
  const stateEl = h('section', { class: 'state popup-card', 'data-role': 'state' }, headSlot, factsSlot);
  const setupSlot = slot('div');
  const recentSlot = slot('div');
  const announcer = h('p', { class: 'visually-hidden', role: 'status', 'data-role': 'announce' });

  // The hero: one element for the life of the popup, patched between Record and Stop.
  const heroButton = button('Record this call', {
    kind: 'prominent',
    hero: true,
    class: 'hero-btn',
    attrs: { 'data-key': 'record' },
    onClick: () => onHero(),
  });
  const heroError = h('p', { class: 'hero-error', role: 'alert', 'data-role': 'error' });
  const heroHint = h('p', { class: 'hero-hint' });
  const heroBlock = h('div', { class: 'hero-block', 'data-role': 'hero', hidden: true }, heroButton, heroError, heroHint);

  // The roll: one span per person, keyed, so a new name fades in and nothing else moves.
  const roll = h('span', { class: 'roll', 'aria-live': 'off', 'data-role': 'roll' });
  const rollMore = h('span', { class: 'roll-more', 'aria-hidden': 'true', hidden: true });
  const rollItems = new Map<string, RollItem>();
  let rollKeys: string[] = [];
  /** Names already there when the popup opens don't fade in; later arrivals do. */
  let rendered = false;

  const meetingsButton = button('Meetings', {
    kind: 'plain',
    attrs: { 'data-key': 'dashboard' },
    onClick: () => handlers.openDashboard(),
  });
  const footer = h(
    'nav',
    { class: 'popup-foot', 'aria-label': 'Manet Meetings' },
    meetingsButton,
    button('Settings', { kind: 'plain', attrs: { 'data-key': 'settings' }, onClick: () => handlers.openSettings() }),
  );

  mount(root, stateEl, heroBlock, setupSlot, recentSlot, announcer, footer);
  // The one menu (the profiles), outside every patched block.
  const menu = createMenu(root);

  // The Profile row: one element for the life of the popup, put above the hero while it
  // applies. Its button keeps focus through updates and anchors the menu.
  const profileNameEl = h('span', { class: 'popup-profile-name' });
  const profileButton = button([profileNameEl, svg('chevron')], {
    kind: 'plain',
    class: 'popup-profile-btn',
    attrs: { ...menuButtonAttrs(menu), 'data-key': 'profile' },
    onClick: (event) => {
      if (menu.anchor === profileButton) menu.close({ restoreFocus: true });
      else openProfiles(event.detail === 0 ? 'first' : 'menu');
    },
  });
  profileButton.addEventListener(
    'keydown',
    menuButtonKeys((focus) => {
      if (!isInert(profileButton)) openProfiles(focus);
    }),
  );
  const profileRow = h(
    'div',
    { class: 'popup-profile', 'data-role': 'profile' },
    h('dl', { class: 'facts' }, h('dt', null, 'Profile'), h('dd', { 'data-fact': 'profile' }, profileButton)),
  );

  // Paint the footer now; say what is happening only if it takes a noticeable while.
  const loadingTimer = setTimeout(() => {
    if (!model) mount(headSlot, h('p', { class: 'state-loading t-callout' }, 'Checking this tab…'));
  }, LOADING_DELAY_MS);

  /** Re-mounts `el` with `build()` only when `sig` changed. */
  function patch(key: string, el: HTMLElement, sig: string, build: () => Child | Child[]): boolean {
    if (sigs.get(key) === sig) return false;
    sigs.set(key, sig);
    const content = build();
    mount(el, content);
    el.hidden = el.childNodes.length === 0;
    return true;
  }

  function onHero(): void {
    const m = model;
    const s = m?.state;
    if (!m || !s || busy || clock() < heroArmedAt) return;
    if (heroAction === 'record' && s.kind === 'idle') run('record', () => handlers.record(s.tabId, pickedProfile(m)));
    else if (heroAction === 'stop' && s.kind === 'recording') run('stop', () => handlers.stop(s.sessionId));
  }

  /** The hero's requests and profile changes; a failure shows in the hero's error line. */
  function run(action: Request, request: () => Promise<void>): void {
    if (action === 'profile') profileBusy = true;
    else busy = action;
    error = undefined;
    let promise: Promise<void>;
    try {
      promise = request();
    } catch (err) {
      promise = Promise.reject(err);
    }
    render();
    promise.catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      error = `${FAILED[action]}: ${reason}`;
    }).finally(() => {
      if (action === 'profile') profileBusy = false;
      else busy = null;
      render();
    });
  }

  // ---- Head --------------------------------------------------------------------------

  function headContent(s: PopupState): Child[] {
    switch (s.kind) {
      case 'recording': {
        const name = s.title ?? null;
        const where: Child[] = name ? [name, ' · ', h('span', { class: 'mono' }, s.meetCode)] : [h('span', { class: 'mono' }, s.meetCode)];
        return [
          h(
            'div',
            { class: 'state-head' },
            h('h1', { class: 'headline t-title3 is-live' }, toneGlyph('live'), 'Recording'),
            h('span', { class: 'clock num', role: 'timer', 'aria-live': 'off', 'data-role': 'clock' }),
          ),
          h(
            'p',
            { class: 'state-sub' },
            s.thisTab
              ? h('span', { class: 'state-sub-text' }, ...where)
              : h(
                  'span',
                  { class: 'state-sub-text is-elsewhere' },
                  // The title gives way first; "in another tab" is the point of the line.
                  h('span', { class: 'state-sub-name' }, name ?? h('span', { class: 'mono' }, s.meetCode)),
                  h('span', { class: 'state-sub-where' }, ' · in another tab'),
                ),
            s.thisTab
              ? null
              : button('Go to call', {
                  kind: 'plain',
                  class: 'go-to-call',
                  attrs: { 'data-key': 'go-to-call' },
                  onClick: () => handlers.goToCall(s.tabId),
                }),
          ),
        ];
      }
      case 'idle':
        return [
          h('div', { class: 'state-head' }, h('h1', { class: 'headline t-title3 is-clamped' }, s.title ?? 'Meet call')),
          h(
            'p',
            { class: 'state-sub' },
            h('span', { class: 'state-sub-text' }, s.title ? 'Meet call ' : null, h('span', { class: 'mono' }, s.meetCode)),
          ),
        ];
      case 'not-meet':
        return [
          h('div', { class: 'state-head' }, h('h1', { class: 'headline t-title3' }, 'No call in this tab')),
          h(
            'p',
            { class: 'state-sub is-wrapping' },
            s.onMeet ? 'Join the call to record it.' : 'Open a Google Meet call to record it.',
          ),
        ];
    }
  }

  function headSig(s: PopupState): string {
    if (s.kind === 'recording') return JSON.stringify([s.kind, s.title, s.meetCode, s.thisTab, s.tabId]);
    return JSON.stringify(s);
  }

  // ---- Facts -------------------------------------------------------------------------

  function factOf(view: FactView): Fact {
    const value: Child = typeof view.value === 'string' ? view.value : roll;
    const detail: Child[] = [];
    if (view.warning) {
      // A caution value in its own right (14/20, like the others), its explanation under the words.
      detail.push(
        h('span', { class: 'fact-warning' }, svg('caution', { class: 'tone-caution' }), h('span', null, view.warning)),
        view.detail ? h('span', { class: 'fact-warning-detail' }, view.detail) : null,
      );
    } else if (view.detail) {
      detail.push(view.detail);
    }
    if (view.action) {
      // On its own line: the focus ring then never crosses the sentence above.
      const { key, label } = view.action;
      detail.push(' ', button(label, { kind: 'link', class: 'fact-action', attrs: { 'data-key': key }, onClick: () => handlers.grantMic() }));
    }
    const fact: Fact = { label: view.label, value, attrs: { 'data-fact': view.label.toLowerCase() } };
    if (detail.length) fact.detail = detail;
    if (view.tone) fact.tone = view.tone;
    return fact;
  }

  function factSig(view: FactView): unknown {
    return typeof view.value === 'string' ? view : { ...view, value: 'roll' };
  }

  function renderFacts(m: PopupModel, s: PopupState): void {
    if (s.kind === 'not-meet') {
      patch('facts', factsSlot, 'none', () => null);
      return;
    }
    const views = s.kind === 'recording' ? [speakersFact(s, now), audioFact(s, m.mic, m.includeMic, now)] : [IDLE_SPEAKERS, audioFact(s, m.mic, m.includeMic, now)];
    const speakers = views[0]!;
    const rebuilt = patch('facts', factsSlot, JSON.stringify(views.map(factSig)), () => factList(views.map(factOf)));
    if (typeof speakers.value !== 'string') patchRoll(speakers.value.roll, rebuilt);
  }

  // ---- The roll ----------------------------------------------------------------------

  function rollItem(entry: RollEntry, fadeIn: boolean): RollItem {
    const name = h('span', { class: 'roll-name' });
    const speaking = visuallyHidden(' (speaking)');
    const sep = h('span', { class: 'roll-sep', 'aria-hidden': 'true' }, ' ·');
    const el = h('span', { class: fadeIn ? 'roll-item is-new' : 'roll-item', 'data-key': entry.key }, name, speaking, sep);
    if (fadeIn) {
      const settle = () => el.classList.remove('is-new');
      el.addEventListener('animationend', settle, { once: true });
      setTimeout(settle, 400);
    }
    return { el, name, speaking, sep };
  }

  function patchRoll(entries: RollEntry[], attached: boolean): void {
    const keys = entries.map((e) => e.key);
    const reordered = keys.join('\n') !== rollKeys.join('\n');
    for (const entry of entries) {
      let item = rollItems.get(entry.key);
      if (!item) {
        item = rollItem(entry, rendered);
        rollItems.set(entry.key, item);
      }
      if (item.name.textContent !== entry.name) item.name.textContent = entry.name;
      item.name.classList.toggle('is-speaking', entry.speaking);
      item.speaking.hidden = !entry.speaking;
    }
    if (reordered) {
      for (const key of rollItems.keys()) if (!keys.includes(key)) rollItems.delete(key);
      const nodes: Node[] = [];
      for (const key of keys) nodes.push(rollItems.get(key)!.el, document.createTextNode(' '));
      roll.replaceChildren(...nodes, rollMore);
      rollKeys = keys;
    }
    if (reordered || attached) fitRoll();
  }

  /** Two lines of names at most, then "+N more"; the hidden names stay for screen readers. */
  function fitRoll(): void {
    const items = rollKeys.map((k) => rollItems.get(k)!);
    items.forEach((item, i) => {
      item.el.classList.remove('visually-hidden');
      item.sep.hidden = i === items.length - 1;
    });
    rollMore.hidden = true;
    if (!roll.isConnected || items.length < 2) return;
    const lineHeight = parseFloat(getComputedStyle(roll).lineHeight) || 20;
    const fits = () => roll.getBoundingClientRect().height <= lineHeight * 2 + 1;
    if (fits()) return;
    rollMore.hidden = false;
    for (let shown = items.length - 1; shown >= 1; shown--) {
      items[shown]!.el.classList.add('visually-hidden');
      items[shown - 1]!.sep.hidden = false;
      rollMore.textContent = `+${items.length - shown} more`;
      if (fits()) return;
    }
  }

  // ---- Profile -----------------------------------------------------------------------

  const knownProfile = (m: PopupModel, id: string | null | undefined): id is string =>
    typeof id === 'string' && m.profiles.some((p) => p.id === id);

  /** The default profile, or the first one when the default id is stale (profiles.defaultProfile). */
  function defaultProfileId(m: PopupModel): string {
    return knownProfile(m, m.defaultProfileId) ? m.defaultProfileId : (m.profiles[0]?.id ?? m.defaultProfileId);
  }

  /** What Record passes on: the popup's pick, or the default when none (or it was deleted since). */
  function pickedProfile(m: PopupModel): string {
    const id = pickedProfileId ?? m.pickedProfileId;
    return knownProfile(m, id) ? id : defaultProfileId(m);
  }

  /** The profile the row shows: the recording's own while recording (null: deleted since), else the pick. */
  function shownProfile(m: PopupModel, s: PopupState): string | null {
    if (s.kind !== 'recording') return pickedProfile(m);
    if (s.profileId === undefined) return defaultProfileId(m);
    return knownProfile(m, s.profileId) ? s.profileId : null;
  }

  /** What an open profile menu was built from; a different one now means its items went stale. */
  function profileSignature(m: PopupModel, s: PopupState): string {
    const session = s.kind === 'recording' ? s.sessionId : '';
    const profiles = m.profiles.map((p) => [p.id, p.name]);
    return JSON.stringify([s.kind, session, profiles, shownProfile(m, s), profileFrozen()]);
  }

  /** No choice while a request runs: Record has taken the pick, or a change is on its way. */
  function profileFrozen(): boolean {
    return busy !== null || profileBusy;
  }

  function openProfiles(focus: 'first' | 'last' | 'menu'): void {
    const m = model;
    if (!m || !profileRow.isConnected || profileFrozen()) return;
    const s = m.state;
    const current = shownProfile(m, s);
    const items: MenuItem[] = m.profiles.map((p) => ({
      label: p.name,
      checked: p.id === current,
      attrs: { 'data-key': `profile-${p.id}` },
      onSelect: () => pickProfile(p.id),
    }));
    menu.open(profileButton, items, {
      focus,
      signature: profileSignature(m, s),
      label: 'Profile',
      // The outside pointerdown that closes the menu is often the pointerdown half of a click
      // meant only to dismiss it; don't let the click half act on the hero underneath.
      onClose: (reason) => {
        if (reason === 'outside') heroArmedAt = clock() + HERO_GUARD_MS;
      },
    });
  }

  /** Before recording, the pick is the popup's own; while recording, the recording's profile changes. */
  function pickProfile(id: string): void {
    const s = model?.state;
    if (s?.kind === 'recording') {
      if (id === s.profileId) return;
      const sessionId = s.sessionId;
      run('profile', () => handlers.setProfile(sessionId, id));
    } else if (s?.kind === 'idle') {
      // Shown now; the model brings the remembered pick back once it is stored.
      pickedProfileId = id;
      render();
      handlers.rememberProfile(id);
    }
  }

  function renderProfile(m: PopupModel, s: PopupState): void {
    const show = (s.kind === 'idle' || s.kind === 'recording') && m.profiles.length > 1;
    // An open menu whose choices went stale closes (focus goes back to the button) before
    // the row can leave.
    if (menu.anchor === profileButton && (!show || menu.signature !== profileSignature(m, s))) menu.close();
    if (!show) {
      profileRow.remove();
      return;
    }
    if (!profileRow.isConnected) heroBlock.before(profileRow);
    const current = shownProfile(m, s);
    const name = current === null ? 'Choose profile' : profileName(m, current);
    if (profileNameEl.textContent !== name) {
      profileNameEl.textContent = name;
      profileButton.setAttribute('aria-label', current === null ? name : `Profile: ${name}`);
    }
    setBusy(profileButton, profileBusy);
    if (!profileBusy) setDisabled(profileButton, busy !== null);
  }

  // ---- Hero --------------------------------------------------------------------------

  function renderHero(m: PopupModel, s: PopupState): void {
    const action: HeroAction | null = s.kind === 'recording' ? 'stop' : s.kind === 'idle' ? 'record' : null;
    if (action !== heroAction) {
      // Record became Stop (or back) under the pointer: an impatient second click must not end the call.
      if (heroAction !== null && action !== null) heroArmedAt = clock() + HERO_GUARD_MS;
      heroAction = action;
    }
    heroBlock.hidden = action === null;
    if (!action) return;
    const pending = busy === action;
    const label = action === 'record' ? (pending ? 'Starting…' : 'Record this call') : pending ? 'Stopping…' : 'Stop recording';
    if (heroButton.textContent !== label) heroButton.textContent = label;
    heroButton.classList.toggle('prominent', action === 'record');
    heroButton.classList.toggle('live', action === 'stop');
    heroButton.dataset.key = action;
    if (busy) heroButton.setAttribute('aria-disabled', 'true');
    else heroButton.removeAttribute('aria-disabled');
    if (m.shortcut && /^[\w+]+$/.test(m.shortcut)) heroButton.setAttribute('aria-keyshortcuts', m.shortcut);
    else heroButton.removeAttribute('aria-keyshortcuts');

    patch('error', heroError, JSON.stringify(error ?? null), () =>
      error ? [svg('caution', { class: 'tone-caution' }), h('span', null, error)] : null,
    );
    heroError.hidden = false; // keep the alert region in the tree; :empty hides it
    const hint =
      action === 'record'
        ? 'Let everyone know you’re recording.'
        : m.autoTranscribe
          ? 'It’s transcribed when the call ends.'
          : 'You’ll find it in Meetings.';
    patch('hint', heroHint, JSON.stringify([hint, m.shortcut]), () => [
      h('span', null, hint),
      m.shortcut ? h('span', { class: 'hero-shortcut' }, visuallyHidden('Shortcut: '), kbd(m.shortcut)) : null,
    ]);
  }

  // ---- Setup, Recent, footer ---------------------------------------------------------

  function renderSetup(m: PopupModel, s: PopupState): void {
    const show = s.kind === 'recording' ? 'none' : m.setup.length ? 'missing' : m.geminiKeyMissing ? 'no-gemini' : 'none';
    const name = profileName(m, m.defaultProfileId);
    patch('setup', setupSlot, JSON.stringify([show, m.setup, name]), () => {
      if (show === 'missing') {
        return callout({
          title: 'Meetings can’t be saved to Notion yet',
          body: setupSentence(m.setup, name),
          actions: button('Open settings', {
            attrs: { 'data-key': 'missing-settings' },
            onClick: () => handlers.openSettings(m.setup[0] && GAP_FIELD[m.setup[0]]),
          }),
          attrs: { 'data-role': 'missing' },
        });
      }
      if (show === 'no-gemini') {
        return note({
          body: 'No Gemini key: transcripts will come from Meet’s captions only.',
          actions: button('Add key', { attrs: { 'data-key': 'no-gemini-settings' }, onClick: () => handlers.openSettings('geminiApiKey') }),
          attrs: { 'data-role': 'no-gemini' },
        });
      }
      return null;
    });
  }

  /** Two lines, every row alike: glyph + title (+ Open in Notion) / status · details. */
  function recentItem(row: RecentRowView): HTMLLIElement {
    const url = row.notionUrl;
    return h(
      'li',
      { class: 'recent-row', 'data-id': row.id },
      h(
        'div',
        { class: 'recent-body' },
        h(
          'div',
          { class: 'recent-line' },
          // The glyph hangs at the start of the title line; the status line below runs the
          // full width of the row, so a detail is never squeezed out by an indent.
          toneGlyph(row.tone),
          h('span', { class: row.isCode ? 'recent-title mono' : 'recent-title', title: row.title }, row.title),
          url
            ? button('Open in Notion', {
                kind: 'link',
                class: 'recent-action',
                attrs: { 'data-key': `notion:${row.id}` },
                onClick: () => handlers.openNotion(url),
              })
            : null,
        ),
        h(
          'p',
          { class: 'recent-meta num' },
          h('span', { class: 'recent-status' }, row.status),
          row.details.map((detail) => h('span', { class: 'recent-detail' }, ` · ${detail}`)),
        ),
      ),
    );
  }

  /**
   * Only when not on a call (wireframe D): on a call the popup is about recording it, and
   * Recent under the facts, the hero and a setup callout would outgrow Chrome's 600 px.
   */
  function renderRecent(m: PopupModel, s: PopupState): void {
    const names = new Map(m.profiles.map((p) => [p.id, p.name]));
    const rows = s.kind === 'not-meet' ? m.recent.slice(0, RECENT_COUNT).map((meta) => recentRow(meta, now, fmt, names)) : [];
    patch('recent', recentSlot, JSON.stringify(rows), () =>
      rows.length
        ? h(
            'section',
            { class: 'recent', 'data-role': 'recent', 'aria-labelledby': 'recent-title' },
            h('h2', { class: 'section-header', id: 'recent-title' }, 'Recent'),
            h('ul', { class: 'recent-list', role: 'list' }, rows.map(recentItem)),
          )
        : null,
    );
  }

  // ---- Render ------------------------------------------------------------------------

  function announce(s: PopupState): void {
    const was = shownKind;
    shownKind = s.kind;
    if (was === null || was === s.kind) return;
    let text = '';
    if (s.kind === 'recording') text = 'Recording';
    else if (was === 'recording') text = 'Recording stopped';
    if (text) announcer.textContent = text;
    // The one orchestrated moment: the state block cross-fades between idle and recording.
    if (was === 'recording' || s.kind === 'recording') {
      stateEl.classList.remove('is-entering');
      void stateEl.offsetWidth;
      stateEl.classList.add('is-entering');
    }
  }

  function render(): void {
    const m = model;
    if (!m) return;
    const s = m.state;
    keepFocus(root, () => {
      if (patch('head', headSlot, headSig(s), () => headContent(s))) headSlot.hidden = false;
      const clockEl = headSlot.querySelector('[data-role="clock"]');
      if (clockEl && s.kind === 'recording') {
        const text = formatElapsed(now - s.startedAt);
        if (clockEl.textContent !== text) clockEl.textContent = text;
      }
      renderFacts(m, s);
      renderProfile(m, s);
      renderHero(m, s);
      renderSetup(m, s);
      renderRecent(m, s);
      const label = meetingsLabel(m.needsYou);
      if (meetingsButton.textContent !== label) meetingsButton.textContent = label;
    });
    announce(s);
    // The roll or the notes above may have moved the Profile button.
    if (menu.anchor) menu.position();
    rendered = true;
  }

  return {
    update(next, at) {
      if (!model) clearTimeout(loadingTimer);
      model = next;
      now = at;
      render();
    },
  };
}
