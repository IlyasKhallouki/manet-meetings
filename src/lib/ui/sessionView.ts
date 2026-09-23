/**
 * What the pages say about a meeting: its status (glyph tone + word + detail), its one
 * next step and ⋯ menu, and its formatted fields (time, length, byline). Pure, so the
 * rules are tested without a DOM. The vocabulary is the direction's copyVoice glossary:
 * "meeting", never session/job/route/duplicate/force.
 *
 * The action rules mirror what the background accepts (sessionManager.ts): Transcribe
 * from awaiting-route, ready, failed, processed, empty or duplicate; Save from processed,
 * failed or duplicate with a stored result; a destination change from awaiting-route,
 * ready, failed, processed, empty or duplicate. On a duplicate, "Save a second copy…"
 * skips the Notion check (force), which files a second page. A failed meeting's Try
 * again repeats what failed (failureKind).
 */
import { minutesText, recordingHealth, silenceText } from '../recordingHealth';
import type { JobStage, Route, SessionMeta, SessionStatus } from '../types';
import { formatBytes } from '../util/time';
import type { Tone } from './controls';

// ---------------------------------------------------------------------------------------
// Status

export interface StatusView {
  /** Glyph tone: ● live, ◐ working, ▲ caution, ✓ done, ○ neutral, — none. */
  tone: Tone;
  /** The status word (always shown, in --label). */
  label: string;
  /** What is happening inside the status: the pipeline stage, whose page it is. */
  detail?: string;
}

const TRANSCRIBABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);
const ROUTABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed', 'empty', 'duplicate']);
const BUSY = new Set<SessionStatus>(['processing', 'saving']);

/** Pipeline stages in order; the step number is the index + 1 (of 8). */
const STAGES: readonly JobStage[] = [
  'checking-duplicate',
  'loading-audio',
  'transcribing-timing',
  'transcribing-text',
  'aligning',
  'merging',
  'summarizing',
  'saving',
];

export const STEP_COUNT = STAGES.length;

/** The status word for each stage (copyVoice › STAGES). */
const STAGE_WORD: Record<JobStage, string> = {
  'checking-duplicate': 'Starting',
  'loading-audio': 'Starting',
  'transcribing-timing': 'Transcribing',
  'transcribing-text': 'Transcribing',
  aligning: 'Transcribing',
  merging: 'Transcribing',
  summarizing: 'Summarizing',
  saving: 'Saving to Notion',
};

/**
 * What the stage is doing, in words people use. Unique per stage, and never a count:
 * "Step n of 8" under the bar is the one progress number.
 */
const STAGE_DETAIL: Record<JobStage, string> = {
  'checking-duplicate': 'Checking whether a teammate saved it',
  'loading-audio': 'Reading the audio',
  'transcribing-timing': 'Listening to the recording',
  'transcribing-text': 'Writing out what was said',
  aligning: 'Lining up words and times',
  merging: 'Matching words to speakers',
  summarizing: 'Writing the summary',
  saving: 'Saving to Notion',
};

/** Newest recording first, ties by id descending (the order listSessions returns). */
export function compareSessions(a: SessionMeta, b: SessionMeta): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** The stage's detail ("Writing the summary"). */
export function stageLabel(stage: JobStage): string {
  return STAGE_DETAIL[stage];
}

/** Pipeline step 1–8 of a running job; 1 before the first stage is reported. */
export function stageStep(meta: Pick<SessionMeta, 'status' | 'stage'>): number {
  if (meta.stage) return STAGES.indexOf(meta.stage) + 1;
  return meta.status === 'saving' ? STEP_COUNT : 1;
}

/** Who saved a meeting that was already in Notion: "Marie", else "a teammate". */
function savedBy(meta: SessionMeta): string {
  return meta.notion?.recordedBy?.trim() || 'a teammate';
}

/** The record sessionManager stores when settings block saving (markMissingSettings). */
const MISSING_SETTINGS = /^Missing settings: (.+?)\. Add them in Settings, then try again\.?$/;
/** The same, stored as the sentence itself (copy.ts problems.missingSettings). */
const ADD_SAVE_SETTINGS = /^Add .*\b(your name|Notion token|database)\b.* in Settings, then try again\.$/i;

/** The words a transcription problem leaves on the meeting when it already says the transcript was kept. */
const SAYS_KEPT = /earlier transcript/i;

/**
 * What a failed meeting was doing when it failed. The background names Notion only in a
 * save's problems (copy.ts, notion/errors.ts, pipeline STOPPED.save), and missing
 * settings are what saving needs; an automatic retry is always a transcription.
 * Otherwise it was transcribing: `transcribe-again` when a transcript is stored, which
 * the background keeps when a new one fails or comes out worse.
 */
export type FailureKind = 'transcribe' | 'transcribe-again' | 'save';

export function failureKind(meta: Pick<SessionMeta, 'error' | 'retryAt'>, hasResult: boolean): FailureKind {
  const error = meta.error ?? '';
  const settings = MISSING_SETTINGS.test(error) || ADD_SAVE_SETTINGS.test(error);
  if (meta.retryAt === undefined && (settings || /\bNotion\b/i.test(error))) return 'save';
  return hasResult ? 'transcribe-again' : 'transcribe';
}

/**
 * `hasResult`: a transcript is stored, so the failure was either its save or a new
 * transcription that didn't replace it (failureKind). Without the context a failed
 * meeting reads "Couldn’t transcribe" unless its error names Notion.
 */
export function statusView(meta: SessionMeta, ctx: { hasResult?: boolean } = {}): StatusView {
  switch (meta.status) {
    case 'recording':
      return { tone: 'live', label: 'Recording' };
    case 'awaiting-route':
      return { tone: 'caution', label: 'Choose Team or Personal' };
    case 'ready':
      return { tone: 'neutral', label: 'Not transcribed' };
    case 'processing': {
      const out: StatusView = { tone: 'working', label: meta.stage ? STAGE_WORD[meta.stage] : 'Starting' };
      if (meta.stage && meta.stage !== 'saving') out.detail = STAGE_DETAIL[meta.stage];
      return out;
    }
    case 'saving':
      return { tone: 'working', label: 'Saving to Notion' };
    case 'processed':
      return { tone: 'caution', label: 'Transcribed, not saved yet' };
    case 'saved':
      return { tone: 'done', label: 'Saved to Notion' };
    case 'duplicate':
      return { tone: 'done', label: `Saved by ${savedBy(meta)}`, detail: 'Your copy wasn’t added' };
    case 'empty':
      return { tone: 'none', label: 'Nothing to save', detail: 'No speech or captions were captured.' };
    case 'failed':
      switch (failureKind(meta, ctx.hasResult === true)) {
        case 'save':
          return { tone: 'caution', label: 'Couldn’t save to Notion' };
        case 'transcribe':
          return { tone: 'caution', label: 'Couldn’t transcribe' };
        case 'transcribe-again': {
          const out: StatusView = { tone: 'caution', label: 'Couldn’t transcribe again' };
          if (!SAYS_KEPT.test(meta.error ?? '')) out.detail = 'Kept the earlier transcript';
          return out;
        }
      }
  }
}

/** A destination can be chosen or changed (what the background accepts). */
export function canChooseRoute(meta: SessionMeta): boolean {
  return ROUTABLE.has(meta.status);
}

/**
 * Where the row shows the Team | Personal control: `required` while the meeting waits
 * for a destination (nothing pressed), `optional` before it is transcribed (the chosen
 * one pressed), null once it is on its way (the destination is then plain text, and the
 * ⋯ menu offers "Save to … instead").
 */
export function routeChoice(meta: SessionMeta): 'required' | 'optional' | null {
  if (meta.status === 'awaiting-route') return 'required';
  if (meta.status === 'ready') return 'optional';
  return null;
}

export function routeLabel(route: Route | undefined): string {
  if (route === 'team') return 'Team';
  if (route === 'personal') return 'Personal';
  return 'Not chosen';
}

// ---------------------------------------------------------------------------------------
// Actions: one next step + the ⋯ menu

export type RowActionKind = 'stop' | 'transcribe' | 'save' | 'open' | 'second-copy' | 'reroute' | 'delete';

export interface RowAction {
  kind: RowActionKind;
  /** Sentence case; a trailing ellipsis when it asks before doing anything. */
  label: string;
  enabled: boolean;
  /** Why it is unavailable, shown under a disabled menu item. */
  note?: string;
  /** Skip the Notion duplicate check (files a second page). */
  force?: boolean;
  /** Ask inline first (Delete…, Save a second copy…). */
  confirm?: boolean;
  /** reroute: the other destination; the save (or transcription) follows. */
  route?: Route;
  /** reroute / second-copy: which request carries the meeting on. */
  then?: 'save' | 'transcribe';
  /** open: the Notion page. */
  url?: string;
}

export interface RowActions {
  /** The one bordered button in the row, if there is an obvious next step. */
  primary: RowAction | null;
  /** The ⋯ menu, in order. Delete… is always last. */
  menu: RowAction[];
}

/**
 * `hasResult`: a transcript is stored (Save needs one).
 * `pending`: this page is waiting on a request for the meeting, so nothing else may start.
 */
export function rowActions(meta: SessionMeta, ctx: { hasResult: boolean; pending?: boolean }): RowActions {
  const { status } = meta;
  const pending = ctx.pending === true;
  const act = (kind: RowActionKind, label: string, extra: Partial<RowAction> = {}): RowAction => ({
    kind,
    label,
    enabled: !pending,
    ...extra,
  });
  const other: Route = meta.route === 'personal' ? 'team' : 'personal';
  const next = ctx.hasResult ? 'save' : 'transcribe';
  const reroute = () => act('reroute', `Save to ${routeLabel(other)} instead`, { route: other, then: next });
  const transcribeAgain = () => act('transcribe', 'Transcribe again');

  let primary: RowAction | null = null;
  const menu: RowAction[] = [];

  switch (status) {
    case 'recording':
      primary = act('stop', 'Stop recording');
      break;
    case 'awaiting-route':
      // The Team | Personal control in the status is the next step.
      break;
    case 'ready':
      primary = act('transcribe', 'Transcribe');
      break;
    case 'processing':
    case 'saving':
      break;
    case 'processed':
      if (ctx.hasResult) {
        primary = act('save', 'Save to Notion');
        menu.push(transcribeAgain(), reroute());
      } else {
        primary = transcribeAgain();
      }
      break;
    case 'saved':
      if (meta.notion?.url) primary = act('open', 'Open in Notion', { url: meta.notion.url });
      break;
    case 'duplicate':
      if (meta.notion?.url) primary = act('open', 'Open in Notion', { url: meta.notion.url });
      menu.push(act('second-copy', 'Save a second copy…', { force: true, confirm: true, then: next }), reroute());
      break;
    case 'empty':
      menu.push(transcribeAgain());
      break;
    case 'failed': {
      // Try again repeats what failed; a transcript kept from before can still be saved.
      const retry = () => act('transcribe', meta.retryAt === undefined ? 'Try again' : 'Try now');
      const kind = failureKind(meta, ctx.hasResult);
      if (ctx.hasResult && kind === 'save') {
        primary = act('save', 'Try again');
        menu.push(transcribeAgain(), reroute());
      } else if (ctx.hasResult) {
        primary = retry();
        menu.push(act('save', 'Save to Notion'), reroute());
      } else {
        primary = retry();
        menu.push(reroute());
      }
      break;
    }
  }

  const busy = BUSY.has(status);
  menu.push(
    busy
      ? { kind: 'delete', label: 'Delete…', enabled: false, confirm: true, note: 'Wait for it to finish' }
      : act('delete', 'Delete…', { confirm: true }),
  );
  return { primary, menu };
}

/** The request a transcribe/save would be accepted for (used by tests and the menu). */
export function acceptsTranscribe(meta: SessionMeta): boolean {
  return TRANSCRIBABLE.has(meta.status);
}

// ---------------------------------------------------------------------------------------
// Dates and times: English words, the browser's clock convention
//
// One vocabulary for every surface (the popup's Recent and the routing prompt should
// write the same): headers "Today" / "Yesterday" / "Wednesday 16 September"; inline "Today 14:02",
// "Yesterday 14:02", "Wed 16 Sep 14:02". Day before month whatever the locale (the words
// are English); the clock is 24 h unless the locale uses 12 h. The year only when it
// isn't this one.

export interface FormatOptions {
  /** The locale whose clock (12/24 h) to follow. Defaults to the browser's. */
  locale?: string;
  /** Defaults to the local zone. */
  timeZone?: string;
}

const NBSP = ' ';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${key}|${locale ?? ''}|${options.timeZone ?? ''}`;
  let f = formatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(id, f);
  }
  return f;
}

function uses12h(locale: string | undefined): boolean {
  const cycle = formatter('cycle', locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return cycle === 'h12' || cycle === 'h11';
}

/** 14:40, or 2:40 PM where the browser's locale uses a 12-hour clock. */
export function formatTime(epochMs: number, opts: FormatOptions = {}): string {
  const h12 = uses12h(opts.locale);
  return formatter(`time${h12 ? 12 : 24}`, h12 ? 'en-US' : 'en-GB', {
    hour: h12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: h12,
    timeZone: opts.timeZone,
  }).format(epochMs);
}

/** Days since 1970 of the calendar day `epochMs` falls on, in the zone. */
export function dayNumber(epochMs: number, opts: FormatOptions = {}): number {
  const parts = formatter('day', 'en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: opts.timeZone,
  }).formatToParts(epochMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.round(Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000);
}

interface DateWords {
  weekday: string;
  day: string;
  month: string;
  year: string;
}

/** "Wednesday", "16", "September", "2026" — built from parts, so no locale's "Sept." leaks in. */
function dateWords(epochMs: number, opts: FormatOptions): DateWords {
  const parts = formatter('words', 'en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: opts.timeZone,
  }).formatToParts(epochMs);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { weekday: get('weekday'), day: get('day'), month: get('month'), year: get('year') };
}

function relativeDay(epochMs: number, now: number, opts: FormatOptions): 'Today' | 'Yesterday' | null {
  const diff = dayNumber(now, opts) - dayNumber(epochMs, opts);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return null;
}

function otherYear(epochMs: number, now: number, opts: FormatOptions): string | null {
  const year = dateWords(epochMs, opts).year;
  return year === dateWords(now, opts).year ? null : year;
}

/** Day group header: "Today", "Yesterday", "Friday 18 September" (+ the year if not this one). */
export function dayLabel(epochMs: number, now: number, opts: FormatOptions = {}): string {
  const relative = relativeDay(epochMs, now, opts);
  if (relative) return relative;
  const w = dateWords(epochMs, opts);
  return [w.weekday, w.day, w.month, otherYear(epochMs, now, opts)].filter(Boolean).join(' ');
}

/** The day in a line of text: "Today", "Yesterday", "Wed 16 Sep" (+ the year if not this one). */
export function shortDay(epochMs: number, now: number, opts: FormatOptions = {}): string {
  const relative = relativeDay(epochMs, now, opts);
  if (relative) return relative;
  const w = dateWords(epochMs, opts);
  return [w.weekday.slice(0, 3), w.day, w.month.slice(0, 3), otherYear(epochMs, now, opts)].filter(Boolean).join(' ');
}

/** "Today 14:02", "Yesterday 14:02", "Wed 16 Sep 14:02": never broken across lines. */
export function whenText(epochMs: number, now: number, opts: FormatOptions = {}): string {
  return `${shortDay(epochMs, now, opts)} ${formatTime(epochMs, opts)}`.replace(/ /g, NBSP);
}

/** A meeting's length: "40 s", "32 min", "1 h 5 min". */
export function formatLength(ms: number): string {
  if (ms < 59_500) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The live clock of a recording: "12:48", "1:02:03". */
export function liveClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** How long a job has been running: "just started", "running for 3 min". */
export function runningFor(ms: number): string {
  return ms < 60_000 ? 'just started' : `running for ${formatLength(ms)}`;
}

// ---------------------------------------------------------------------------------------
// Bylines: the roll, reused

const MAX_NAMES = 5;

/**
 * Who was there, in order of first speech: Meet's caption names (SessionMeta.speakers,
 * the local user as "you"), else the stored transcript's attendees (older meetings).
 */
export function speakerNames(meta: Pick<SessionMeta, 'speakers'>, attendees?: readonly string[]): string[] {
  if (meta.speakers?.length) return meta.speakers.map((s) => (s.self ? 'you' : s.name.trim())).filter(Boolean);
  return (attendees ?? []).map((n) => n.trim()).filter(Boolean);
}

/** "Marie Curie, Tom Martin, you"; "You" at the start; "…, Julien and 3 more" past five. */
export function namesText(names: readonly string[]): string {
  if (names.length === 0) return '';
  const shown = names.length > MAX_NAMES ? names.slice(0, MAX_NAMES - 1) : [...names];
  if (shown[0] === 'you') shown[0] = 'You';
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

export interface Byline {
  /** The roll, or "No speakers" / "No speakers yet". */
  names: string;
  /** Meet code, when it isn't already the title (recording rows). */
  code?: string;
  /** "38.2 MB audio", "Audio deleted", "No call audio". */
  audio?: string;
  recovered: boolean;
}

/** Audio bytes of a session: what is on disk when known, else the recorder's count. 0 once purged. */
export function audioBytesOf(meta: SessionMeta, onDisk?: number): number {
  if (meta.audio.deletedAt !== undefined) return 0;
  return onDisk ?? meta.audio.bytes;
}

export function byline(meta: SessionMeta, opts: { audioBytes?: number; attendees?: readonly string[] } = {}): Byline {
  const names = namesText(speakerNames(meta, opts.attendees));
  const out: Byline = {
    names: names || (meta.status === 'recording' ? 'No speakers yet' : 'No speakers'),
    recovered: meta.recovered === true,
  };
  const title = meta.meetingTitle?.trim();
  if (meta.status === 'recording') {
    // The size grows every chunk and says nothing mid-call; the code says which call.
    if (title && title !== meta.meetCode) out.code = meta.meetCode;
    return out;
  }
  const bytes = audioBytesOf(meta, opts.audioBytes);
  if (meta.audio.deletedAt !== undefined) out.audio = 'Audio deleted';
  else if (bytes > 0) out.audio = `${formatBytes(bytes)} audio`;
  else if (meta.audio.error) out.audio = 'No call audio';
  return out;
}

// ---------------------------------------------------------------------------------------
// Settings problems, in words

/**
 * missingForSave's words, in the order Settings asks for them. Older records stored
 * other names ("Notion integration token", "Notion team database id"): both read.
 */
const SETTING_NAMES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^your name$/i, () => 'your name'],
  [/notion (integration )?token/i, () => 'a Notion token'],
  [/profile’s database$/i, (m) => m.input ?? m[0]],
  [/(team|personal) database/i, (m) => `the ${routeLabel(m[1]!.toLowerCase() as Route)} database`],
  [/gemini/i, () => 'a Gemini key'],
];

/** missingForSave's items as a phrase: "your name, a Notion token and the Team profile’s database". */
export function settingsList(missing: readonly string[]): string {
  const named = missing
    .map((item) => {
      for (const [i, [pattern, name]] of SETTING_NAMES.entries()) {
        const m = item.match(pattern);
        if (m) return { order: i, text: name(m) };
      }
      return { order: SETTING_NAMES.length, text: item };
    })
    .sort((a, b) => a.order - b.order)
    .map((n) => n.text);
  if (named.length <= 1) return named.join('');
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/** Typographic apostrophes, as everywhere else in the UI ("isn't" → "isn’t"). */
function curly(text: string): string {
  return text.replace(/(\p{L})'(\p{L})/gu, '$1’$2');
}

/** The stored error, in the page's words: missing settings name what to add, and where. */
export function errorText(error: string): string {
  const missing = error.match(MISSING_SETTINGS);
  if (missing) return `Add ${settingsList(missing[1]!.split(', '))} in Settings, then try again.`;
  // The retry time is on its own line, in the page's clock.
  return curly(error.replace(/\s*Retrying automatically at [^.]*\.$/, ''));
}

// ---------------------------------------------------------------------------------------
// A recording's problems, in the popup's words

export interface Caution {
  /** Which half of the recording: audio or captions (who spoke). */
  key: 'audio' | 'captions';
  /** The ▲ line. */
  text: string;
  /** What it means or what to do, under it. */
  detail?: string;
}

/**
 * What the popup's Speakers and Audio facts warn about (and the toolbar's "!"), for a
 * recording row: same rules (recordingHealth), same words. "None yet — …" becomes "No
 * captions yet — …" because the row has no "Speakers" label to lean on.
 */
export function recordingCautions(meta: SessionMeta, now: number): Caution[] {
  if (meta.status !== 'recording') return [];
  const health = recordingHealth(meta, now);
  const out: Caution[] = [];
  const { audio, captions } = health;
  if (audio?.kind === 'lost') out.push({ key: 'audio', text: 'No call audio — saving captions only' });
  if (audio?.kind === 'stalled') {
    out.push({
      key: 'audio',
      text: `No audio for ${silenceText(audio.silentMs)}`,
      detail: 'Captions are still being saved. If audio doesn’t resume, the transcript will come from captions.',
    });
  }
  if (captions?.kind === 'blocked') {
    out.push({ key: 'captions', text: 'Captions aren’t coming through', detail: curly(captions.reason) });
  }
  if (captions?.kind === 'none-yet') out.push({ key: 'captions', text: 'No captions yet — turn on captions (CC) in Meet' });
  if (captions?.kind === 'quiet') {
    out.push({
      key: 'captions',
      text: `No captions for ${minutesText(captions.quietMs)}`,
      detail: 'If people are talking, check that captions (CC) are on in Meet.',
    });
  }
  return out;
}

/** Under the Team | Personal control: what happens if nobody chooses, and when. */
export function defaultRouteText(route: Route, at: number | undefined, opts: FormatOptions = {}): string {
  const when = at === undefined ? '' : ` at ${formatTime(at, opts)}`;
  return `If you don’t choose, it goes to ${routeLabel(route)}${when}.`;
}

// ---------------------------------------------------------------------------------------
// A row

export interface SessionRowView {
  id: string;
  /** Meet's title, or the meet code (`isCode`: set in mono). */
  title: string;
  isCode: boolean;
  meetCode: string;
  /** Start time, "15:40". */
  time: string;
  /** "32 min", the live clock while recording, or "—". */
  length: string;
  status: StatusView;
  /** "Team" / "Personal", once chosen. */
  routeName?: string;
  byline: Byline;
  /** Why the last attempt failed, in the page's words. */
  error?: string;
  /** "Trying again at 16:37", while an automatic retry is scheduled. */
  retry?: string;
  /** A recording's problems: ▲ lines, audio first. */
  cautions: Caution[];
  /** The running job: step n of 8 and how long it has run. */
  progress?: { step: number; running?: string };
}

function lengthOf(meta: SessionMeta, now: number): number | undefined {
  if (meta.status === 'recording') return now - meta.startedAt;
  if (meta.durationMs !== undefined) return meta.durationMs;
  if (meta.endedAt !== undefined) return meta.endedAt - meta.startedAt;
  return undefined;
}

export function sessionRow(
  meta: SessionMeta,
  opts: FormatOptions & { now: number; audioBytes?: number; hasResult?: boolean; attendees?: readonly string[] },
): SessionRowView {
  const ms = lengthOf(meta, opts.now);
  const title = meta.meetingTitle?.trim();
  const row: SessionRowView = {
    id: meta.id,
    title: title || meta.meetCode,
    isCode: !title,
    meetCode: meta.meetCode,
    time: formatTime(meta.startedAt, opts),
    length: ms === undefined ? '—' : meta.status === 'recording' ? liveClock(ms) : formatLength(ms),
    status: statusView(meta, { hasResult: opts.hasResult }),
    byline: byline(meta, { audioBytes: opts.audioBytes, attendees: opts.attendees }),
    cautions: recordingCautions(meta, opts.now),
  };
  if (meta.route) row.routeName = routeLabel(meta.route);
  // An error from an earlier attempt is history once the meeting is in Notion or on its way.
  const settled = meta.status === 'saved' || meta.status === 'duplicate' || BUSY.has(meta.status);
  if (meta.error && !settled) row.error = errorText(meta.error);
  if (meta.status === 'failed' && meta.retryAt !== undefined) {
    row.retry = `Trying again at ${formatTime(meta.retryAt, opts)}`;
  }
  if (BUSY.has(meta.status)) {
    row.progress = { step: stageStep(meta) };
    if (meta.job) row.progress.running = runningFor(opts.now - meta.job.startedAt);
  }
  return row;
}

// ---------------------------------------------------------------------------------------
// Storage footnote

export interface StorageSummary {
  audioBytes: number;
  /** Meetings that still have audio on this computer. */
  meetings: number;
  /** "Audio on this computer: 65.9 MB for 5 meetings. It’s deleted 7 days after …" */
  text: string;
}

export function storageSummary(
  sessions: readonly SessionMeta[],
  onDisk: ReadonlyMap<string, number> | null,
  retentionDays: number,
): StorageSummary {
  let total = 0;
  let count = 0;
  for (const meta of sessions) {
    const bytes = audioBytesOf(meta, onDisk?.get(meta.id));
    if (bytes <= 0) continue;
    total += bytes;
    count++;
  }
  if (count === 0) return { audioBytes: 0, meetings: 0, text: 'No meeting audio is stored on this computer.' };
  const when =
    retentionDays <= 0
      ? 'It’s deleted once a meeting is saved to Notion.'
      : `It’s deleted ${retentionDays} day${retentionDays === 1 ? '' : 's'} after a meeting is saved to Notion.`;
  return {
    audioBytes: total,
    meetings: count,
    text: `Audio on this computer: ${formatBytes(total)} for ${count} meeting${count === 1 ? '' : 's'}. ${when}`,
  };
}
