/**
 * Words the background puts in front of people: notifications, the problems it stores on
 * a meeting or answers a request with, and the time formats the toolbar tooltip shares
 * with them.
 *
 * Notifications never carry the meeting title, the Meet code or anyone's words: they can
 * pop up while the next call is being screen-shared. The meeting's start time and
 * length identify it instead. Titles never repeat the app name, which Chrome already
 * shows (HIG notifications.md › Content: "Avoid including your app name or icon").
 *
 * Problems are shown as they are on Meetings and in the popup, so they use the
 * direction's glossary: a meeting, never a session; Settings, never the options; no job,
 * stage or route. Each names the next step, fix first (HIG writing.md › Best practices:
 * "Write clear error messages… be clear about what someone can do to fix it"). Raw
 * reasons from Chrome or Gemini stay in the console; a status code is the one detail kept.
 */
import type { SessionMeta, SessionStatus } from '@lib/types';

const MINUTE_MS = 60_000;

export interface Note {
  title: string;
  message: string;
}

/**
 * "14:02", or "2:02 PM" where the locale uses a 12-hour clock. The words stay English
 * (the UI's language); only the hour cycle follows the browser. `locale` is for tests.
 */
export function clockTime(epochMs: number, locale?: string): string {
  const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  const twelve = cycle === 'h11' || cycle === 'h12';
  return new Intl.DateTimeFormat(twelve ? 'en-US' : 'en-GB', {
    hour: twelve ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12: twelve,
  }).format(epochMs);
}

/** "32 min", "1 h 12 min", "under 1 min". */
export function meetingLength(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes < 1) return 'under 1 min';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function localDay(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "14:02 meeting", "14:02 meeting yesterday", "14:02 meeting on 12 September". */
function meetingName(startedAt: number, now: number, locale?: string): string {
  const name = `${clockTime(startedAt, locale)} meeting`;
  if (localDay(startedAt) === localDay(now)) return name;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (localDay(startedAt) === localDay(yesterday.getTime())) return `${name} yesterday`;
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(startedAt);
  return `${name} on ${day}`;
}

/** Raw reasons (Gemini, Notion, Chrome) become one sentence: capitalised, with an end. */
function sentence(reason: string, fallback: string): string {
  const text = reason.trim() || fallback;
  const capitalised = text.charAt(0).toLocaleUpperCase() + text.slice(1);
  return /[.!?…]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

type Meeting = Pick<SessionMeta, 'startedAt' | 'durationMs' | 'route'>;

export const notes = {
  /** `where`: the profile the meeting was saved for ("Team"), or "Notion" when it is gone. */
  saved(meta: Meeting, where: string, now: number, locale?: string): Note {
    const length = meta.durationMs ? ` (${meetingLength(meta.durationMs)})` : '';
    return {
      title: 'Saved to Notion',
      message: `Your ${meetingName(meta.startedAt, now, locale)}${length} is in ${where}.`,
    };
  },

  /** A teammate's page for the same meeting was found, so none was created. */
  alreadyInNotion(meta: Meeting, recordedBy: string, now: number, locale?: string): Note {
    const who = recordedBy.trim() || 'A teammate';
    return {
      title: 'Already in Notion',
      message: `${who} saved the ${meetingName(meta.startedAt, now, locale)}, so yours wasn’t added.`,
    };
  },

  /** Your own earlier page (a rejoin, a reload): this recording is kept for you to decide. */
  alreadySavedByYou(meta: Meeting, now: number, locale?: string): Note {
    return {
      title: 'Already in Notion',
      message: `Part of the ${meetingName(meta.startedAt, now, locale)} is already in Notion from your earlier recording. This one is kept in Meetings.`,
    };
  },

  nothingToSave(meta: Meeting, now: number, locale?: string): Note {
    return {
      title: 'Nothing to save',
      message: `No speech or captions were captured in the ${meetingName(meta.startedAt, now, locale)}.`,
    };
  },

  /** Gemini was unreachable and an automatic retry is scheduled. */
  retrying(meta: Meeting, retryAt: number, now: number, locale?: string): Note {
    return {
      title: `Couldn’t transcribe the ${meetingName(meta.startedAt, now, locale)}`,
      message: `Gemini is unavailable right now. Trying again at ${clockTime(retryAt, locale)}.`,
    };
  },

  couldNotTranscribe(meta: Meeting, reason: string, now: number, locale?: string): Note {
    return {
      title: `Couldn’t transcribe the ${meetingName(meta.startedAt, now, locale)}`,
      message: sentence(reason, 'Transcribing didn’t finish. Try again in Meetings'),
    };
  },

  couldNotSave(meta: Meeting, reason: string, now: number, locale?: string): Note {
    return {
      title: `Couldn’t save the ${meetingName(meta.startedAt, now, locale)}`,
      message: sentence(reason, 'Saving to Notion didn’t finish. Try again in Meetings'),
    };
  },

  /** The call audio died mid-call; the recording goes on with captions. */
  captionsOnly(): Note {
    return {
      title: 'Recording captions only',
      message: 'Call audio couldn’t be captured. Speakers and what they say are still being saved.',
    };
  },

  /** The keyboard shortcut could not start a recording (the popup shows its own error). */
  couldNotStart(reason: string): Note {
    return { title: 'Couldn’t start recording', message: sentence(reason, 'Recording didn’t start. Try again') };
  },
};

// ---------------------------------------------------------------------------------------
// Problems

/** The HTTP status in a raw Gemini error ("Gemini API error 503 UNAVAILABLE: …"), if any. */
function httpStatus(raw: string): string | null {
  return raw.match(/\b([45]\d\d)\b/)?.[1] ?? null;
}

/** " (503)", or nothing when the error carries no status (no connection, a timeout). */
function statusSuffix(raw: string): string {
  const status = httpStatus(raw);
  return status ? ` (${status})` : '';
}

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

/** Why a meeting in `status` can't take a request, when that is the reason; otherwise null. */
function occupied(status: SessionStatus, then: string): string | null {
  switch (status) {
    case 'recording':
      return `Stop recording first, then ${then}.`;
    case 'processing':
      return 'This meeting is being transcribed. Try again when it’s done.';
    case 'saving':
      return 'This meeting is being saved to Notion. Try again when it’s done.';
    case 'saved':
      return 'This meeting is already in Notion.';
    default:
      return null;
  }
}

/**
 * How `problems.geminiRetrying` ends. Meetings drops this part and shows the retry time
 * on its own line, in the page's clock (sessionView errorText).
 */
const RETRY_SUFFIX = ' Retrying automatically at ';

export const problems = {
  /** The Meet tab has no content script, so no captions arrive: stored as captionsError. */
  captionsMissing: 'Manet Meetings can’t read this tab’s captions. Reload the Meet tab to capture who said what.',

  /**
   * Why the call audio stopped while the recording goes on with captions: the popup's
   * detail under "No call audio". Never "Recording stopped", which the red "Recording"
   * above it contradicts. The recorder's own error, when there is one, is kept.
   */
  audioStopped(recorderError?: string): string {
    const why = recorderError?.trim().replace(/\.$/, '');
    return why ? `Chrome stopped the audio recording (${why}).` : 'Chrome stopped the audio recording.';
  },

  /** The Meet tab's audio track ended while the tab stayed in the call. */
  tabAudioEnded: 'The Meet tab’s audio ended.',

  /** Gemini couldn't take the transcription and another attempt is due at `retryAt`. */
  geminiRetrying(cause: string, retryAt: number, locale?: string): string {
    return `Gemini is unavailable right now${statusSuffix(cause)}.${RETRY_SUFFIX}${clockTime(retryAt, locale)}.`;
  },

  /** Gemini was still away on the last automatic attempt. */
  geminiGaveUp(cause: string, attempts: number): string {
    return `Gemini is still unavailable${statusSuffix(cause)} after ${attempts} tries. Try again later.`;
  },

  /** Chrome didn't start the work in the background page. Keeps "Notion" for a save. */
  didNotStart(kind: 'process' | 'save'): string {
    return kind === 'save' ? 'Saving to Notion didn’t start. Try again.' : 'Transcribing didn’t start. Try again.';
  },

  /** The transcription ran into something unexpected (a bug); its words go to the console. */
  transcribingStopped: 'Transcribing stopped before it finished. Try again.',

  /** A new transcription came out worse than the stored one, which is kept. */
  earlierTranscriptKept: 'Transcribing again didn’t work, so the earlier transcript was kept. Save it, or try again later.',

  /** What a notification says when settings block saving; Meetings says the same from the record. */
  missingSettings(missing: readonly string[]): string {
    return `Add ${settingsPhrase(missing)} in Settings, then try again.`;
  },

  /** A request named a meeting that is gone. */
  deleted: 'This meeting was deleted.',

  /** The meeting's profile no longer exists; Meetings offers the others. */
  profileDeleted: 'This meeting’s profile was deleted. Choose another profile.',

  /** A page asked for a profile that is gone (deleted in another tab). */
  unknownProfile: 'That profile no longer exists. Reload the page and choose another.',

  cannotChangeProfile(status: SessionStatus): string {
    return occupied(status, 'change its profile') ?? 'The profile can’t be changed now. Reload Meetings.';
  },

  cannotRoute(status: SessionStatus): string {
    return occupied(status, 'choose Team or Personal') ?? 'Team or Personal can’t be changed now. Reload Meetings.';
  },

  cannotTranscribe(status: SessionStatus): string {
    return occupied(status, 'transcribe it') ?? 'This meeting can’t be transcribed now. Reload Meetings.';
  },

  cannotSave(status: SessionStatus): string {
    if (status === 'empty') return 'No speech or captions were captured, so there’s nothing to save.';
    return occupied(status, 'transcribe it') ?? 'Transcribe this meeting first, then save it.';
  },

  /** Delete left a recording running rather than half delete it. */
  couldNotStop: 'Couldn’t stop the recording, so it wasn’t deleted. Try again.',

  /**
   * A request failed inside Chrome (storage, the background page) for no reason anyone
   * can act on but trying again. Reads alone next to the button that was used, and after
   * the popup's "Couldn’t stop recording: ".
   */
  noResponse: 'Chrome didn’t respond. Try again.',
};

/**
 * A problem worded for people, thrown to the page that asked. Anything else a request
 * throws is logged and replaced with `problems.noResponse`.
 */
export class MeetingProblem extends Error {
  override name = 'MeetingProblem';
}
