import { describe, expect, it } from 'vitest';
import { clockTime, meetingLength, notes, problems, settingsPhrase } from '@/entrypoints/background/copy';
import { DEFAULT_SETTINGS, missingForSave, missingSettings } from '@lib/settingsSchema';
import type { SessionMeta, SessionStatus } from '@lib/types';
import { errorText } from '@lib/ui/sessionView';

const at = (day: number, hh: number, mm: number) => new Date(2026, 8, day, hh, mm).getTime();
const START = at(19, 14, 2);
const NOW = at(19, 14, 40);
const MINUTE = 60_000;

function meta(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    meetCode: 'abc-defg-hij',
    meetingTitle: 'Pricing call with Acme',
    startedAt: START,
    durationMs: 32 * MINUTE,
    status: 'saved',
    route: 'team',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

describe('clockTime', () => {
  it('uses a 24-hour clock where the locale does, and a 12-hour one where it does not', () => {
    expect(clockTime(START, 'en-GB')).toBe('14:02');
    expect(clockTime(START, 'fr-FR')).toBe('14:02');
    expect(clockTime(START, 'en-US')).toBe('2:02 PM');
  });
});

describe('meetingLength', () => {
  it('rounds to minutes and switches to hours past 59 min', () => {
    expect(meetingLength(32 * MINUTE + 20_000)).toBe('32 min');
    expect(meetingLength(20_000)).toBe('under 1 min');
    expect(meetingLength(60 * MINUTE)).toBe('1 h');
    expect(meetingLength(72 * MINUTE)).toBe('1 h 12 min');
  });
});

describe('notifications', () => {
  const titles = (list: { title: string }[]) => list.map((n) => n.title);

  it('say what happened with the time and length, never the meeting title or the app name', () => {
    const m = meta();
    const all = [
      notes.saved(m, NOW, 'en-GB'),
      notes.alreadyInNotion(m, 'Marie', NOW, 'en-GB'),
      notes.alreadySavedByYou(m, NOW, 'en-GB'),
      notes.nothingToSave(m, NOW, 'en-GB'),
      notes.retrying(m, at(19, 16, 37), NOW, 'en-GB'),
      notes.couldNotTranscribe(m, 'Gemini quota exceeded', NOW, 'en-GB'),
      notes.couldNotSave(m, 'Notion returned 502', NOW, 'en-GB'),
      notes.captionsOnly(),
      notes.couldNotStart('This tab is not a Google Meet call.'),
    ];
    for (const n of all) {
      expect(`${n.title} ${n.message}`).not.toMatch(/Pricing|Acme|abc-defg-hij/);
      expect(n.title).not.toMatch(/Manet/);
      expect(n.title).not.toMatch(/[.!]$/);
      expect(n.message).toMatch(/[.!?]$/);
    }
  });

  it("use the direction's strings", () => {
    const m = meta();
    expect(notes.saved(m, NOW, 'en-GB')).toEqual({
      title: 'Saved to Notion',
      message: 'Your 14:02 meeting (32 min) is in Team.',
    });
    expect(notes.saved(meta({ route: 'personal' }), NOW, 'en-GB').message).toBe('Your 14:02 meeting (32 min) is in Personal.');
    expect(notes.alreadyInNotion(m, 'Marie', NOW, 'en-GB')).toEqual({
      title: 'Already in Notion',
      message: "Marie saved the 14:02 meeting, so yours wasn’t added.",
    });
    expect(notes.alreadyInNotion(m, '', NOW, 'en-GB').message).toBe(
      "A teammate saved the 14:02 meeting, so yours wasn’t added.",
    );
    expect(notes.nothingToSave(m, NOW, 'en-GB')).toEqual({
      title: 'Nothing to save',
      message: 'No speech or captions were captured in the 14:02 meeting.',
    });
    expect(notes.retrying(m, at(19, 16, 37), NOW, 'en-GB')).toEqual({
      title: "Couldn’t transcribe the 14:02 meeting",
      message: 'Gemini is unavailable right now. Trying again at 16:37.',
    });
    expect(notes.couldNotSave(m, 'Notion rejected the token. Copy it again in Settings.', NOW, 'en-GB')).toEqual({
      title: "Couldn’t save the 14:02 meeting",
      message: 'Notion rejected the token. Copy it again in Settings.',
    });
    expect(notes.captionsOnly()).toEqual({
      title: 'Recording captions only',
      message: "Call audio couldn’t be captured. Speakers and what they say are still being saved.",
    });
    expect(notes.couldNotStart('Already recording another meeting. Stop it first.')).toEqual({
      title: "Couldn’t start recording",
      message: 'Already recording another meeting. Stop it first.',
    });
  });

  it("tell your own earlier recording apart from a teammate's", () => {
    expect(notes.alreadySavedByYou(meta(), NOW, 'en-GB')).toEqual({
      title: 'Already in Notion',
      message: 'Part of the 14:02 meeting is already in Notion from your earlier recording. This one is kept in Meetings.',
    });
  });

  it('end raw error reasons as sentences', () => {
    expect(notes.couldNotTranscribe(meta(), 'gemini quota exceeded', NOW, 'en-GB').message).toBe('Gemini quota exceeded.');
    expect(notes.couldNotSave(meta(), '  Notion returned 502  ', NOW, 'en-GB').message).toBe('Notion returned 502.');
    expect(notes.couldNotStart('').message).toBe('Recording didn’t start. Try again.');
    expect(notes.couldNotTranscribe(meta(), ' ', NOW, 'en-GB').message).toBe('Transcribing didn’t finish. Try again in Meetings.');
  });

  it('leave the length out when it is unknown', () => {
    expect(notes.saved(meta({ durationMs: undefined }), NOW, 'en-GB').message).toBe('Your 14:02 meeting is in Team.');
    expect(notes.saved(meta({ durationMs: 0 }), NOW, 'en-GB').message).toBe('Your 14:02 meeting is in Team.');
  });

  it('add the day when the meeting was not today', () => {
    const yesterday = meta({ startedAt: at(18, 9, 15) });
    expect(notes.saved(yesterday, NOW, 'en-GB').message).toBe('Your 09:15 meeting yesterday (32 min) is in Team.');
    const older = meta({ startedAt: at(12, 9, 15) });
    expect(titles([notes.couldNotTranscribe(older, 'x', NOW, 'en-GB')])).toEqual([
      "Couldn’t transcribe the 09:15 meeting on 12 September",
    ]);
  });
});

describe('problems', () => {
  const STATUSES: SessionStatus[] = [
    'recording',
    'awaiting-route',
    'ready',
    'processing',
    'saving',
    'processed',
    'saved',
    'duplicate',
    'empty',
    'failed',
  ];
  const RETRY_AT = at(19, 16, 37);
  const OVERLOADED = 'Gemini API error 503 UNAVAILABLE: The model is overloaded. Please try again later.';

  /** Everything the background can put in front of people besides notifications. */
  function everyProblem(): string[] {
    return [
      problems.captionsMissing,
      problems.audioStopped(),
      problems.audioStopped('Recorder error: NotSupportedError.'),
      problems.tabAudioEnded,
      problems.geminiRetrying(OVERLOADED, RETRY_AT, 'en-GB'),
      problems.geminiRetrying('Could not reach Gemini (Failed to fetch)', RETRY_AT, 'en-US'),
      problems.geminiGaveUp(OVERLOADED, 3),
      problems.didNotStart('process'),
      problems.didNotStart('save'),
      problems.earlierTranscriptKept,
      problems.transcribingStopped,
      problems.missingSettings(['Notion integration token', 'Notion team database id', 'Your name']),
      problems.missingSettings(missingForSave(DEFAULT_SETTINGS, 'personal')),
      problems.missingSettings(missingSettings(DEFAULT_SETTINGS, 'team')),
      problems.deleted,
      problems.couldNotStop,
      problems.noResponse,
      ...STATUSES.flatMap((s) => [problems.cannotRoute(s), problems.cannotTranscribe(s), problems.cannotSave(s)]),
    ];
  }

  it('use the glossary: meetings and Settings, never sessions, jobs, stages, routes or options', () => {
    for (const text of everyProblem()) {
      expect(text, text).not.toMatch(/\b(session|route|job|stage|pipeline|opfs|offscreen|duplicate|force|options)\b/i);
      expect(text, text).not.toMatch(/Processing failed|unreachable|Manet(?! Meetings)/);
      // Typographic apostrophes, as in the popup and Settings; full sentences.
      expect(text, text).not.toMatch(/'/);
      expect(text, text).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('keep Gemini’s status code and nothing else of its error', () => {
    expect(problems.geminiRetrying(OVERLOADED, RETRY_AT, 'en-GB')).toBe(
      'Gemini is unavailable right now (503). Retrying automatically at 16:37.',
    );
    // Both passes failed: the first code is enough.
    const passes = 'word-timing pass: Gemini API error 429 RESOURCE_EXHAUSTED: quota; vocabulary pass: Gemini API error 503: x';
    expect(problems.geminiRetrying(passes, RETRY_AT, 'en-US')).toBe(
      'Gemini is unavailable right now (429). Retrying automatically at 4:37 PM.',
    );
    // No response at all: no code to give.
    expect(problems.geminiRetrying('Gemini request timed out after 300 s', RETRY_AT, 'en-GB')).toBe(
      'Gemini is unavailable right now. Retrying automatically at 16:37.',
    );
    expect(problems.geminiGaveUp(OVERLOADED, 3)).toBe('Gemini is still unavailable (503) after 3 tries. Try again later.');
  });

  it('read on Meetings without the retry time, which has its own line there', () => {
    expect(errorText(problems.geminiRetrying(OVERLOADED, RETRY_AT, 'en-GB'))).toBe('Gemini is unavailable right now (503).');
    expect(errorText(problems.geminiRetrying(OVERLOADED, RETRY_AT, 'en-US'))).toBe('Gemini is unavailable right now (503).');
  });

  it('name Notion only for a save, which is how the popup tells the two failures apart', () => {
    expect(problems.didNotStart('save')).toMatch(/Notion/);
    for (const text of [
      problems.didNotStart('process'),
      problems.geminiRetrying(OVERLOADED, RETRY_AT),
      problems.geminiGaveUp(OVERLOADED, 3),
      problems.earlierTranscriptKept,
      problems.transcribingStopped,
    ]) {
      expect(text).not.toMatch(/notion/i);
    }
  });

  it('name missing settings in words, in the order Settings asks for them', () => {
    expect(missingForSave(DEFAULT_SETTINGS, 'team')).toEqual(['your name', 'a Notion token', 'the Team database']);
    expect(problems.missingSettings(missingForSave(DEFAULT_SETTINGS, 'team'))).toBe(
      'Add your name, a Notion token and the Team database in Settings, then try again.',
    );
    const named = { ...DEFAULT_SETTINGS, displayName: 'Ilya', notionTeamDbId: 'db' };
    expect(problems.missingSettings(missingForSave(named, 'personal'))).toBe(
      'Add a Notion token and the Personal database in Settings, then try again.',
    );
    expect(problems.missingSettings(missingSettings({ ...named, notionToken: 't' }, 'team'))).toBe(
      'Add a Gemini key in Settings, then try again.',
    );
    expect(settingsPhrase(['a Notion token', 'your name'])).toBe('your name and a Notion token');
  });

  it('still read the names older records stored', () => {
    expect(settingsPhrase(['Notion integration token', 'Notion team database id', 'Your name'])).toBe(
      'your name, a Notion token and the Team database',
    );
    expect(settingsPhrase(['Notion personal database id'])).toBe('the Personal database');
    expect(settingsPhrase(['Gemini API key', 'Your name'])).toBe('your name and a Gemini key');
    expect(problems.missingSettings(['Notion integration token'])).toBe('Add a Notion token in Settings, then try again.');
  });

  it('treat blank settings as missing, as the popup and Settings do', () => {
    const blank = { ...DEFAULT_SETTINGS, displayName: '  ', notionToken: ' ', notionTeamDbId: '\t' };
    expect(missingForSave(blank, 'team')).toEqual(['your name', 'a Notion token', 'the Team database']);
    expect(missingForSave({ ...DEFAULT_SETTINGS, displayName: 'Ilya', notionToken: 't', notionTeamDbId: 'd' }, 'team')).toEqual(
      [],
    );
  });

  it('say why a request can’t be done in the state the meeting is in', () => {
    expect(problems.cannotRoute('recording')).toBe('Stop recording first, then choose Team or Personal.');
    expect(problems.cannotRoute('saved')).toBe('This meeting is already in Notion.');
    expect(problems.cannotTranscribe('processing')).toBe('This meeting is being transcribed. Try again when it’s done.');
    expect(problems.cannotSave('saving')).toBe('This meeting is being saved to Notion. Try again when it’s done.');
    expect(problems.cannotSave('ready')).toBe('Transcribe this meeting first, then save it.');
    expect(problems.cannotSave('empty')).toBe('No speech or captions were captured, so there’s nothing to save.');
  });
});
