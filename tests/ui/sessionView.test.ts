import { describe, expect, it } from 'vitest';
import { problems } from '@/entrypoints/background/copy';
import { SAVE_STOPPED } from '@lib/notion/errors';
import { STOPPED } from '@lib/pipeline/notes';
import { DEFAULT_SETTINGS, missingForSave } from '@lib/settingsSchema';
import {
  AUDIO_STALL_MS,
  CAPTIONS_QUIET_WARN_MS,
  minutesText,
  NO_CAPTIONS_AFTER_MS,
  recordingHealth,
  silenceText,
} from '@lib/recordingHealth';
import type { Profile, SessionMeta, SessionStatus, SpeakerInfo } from '@lib/types';
import { audioFact, popupState, speakersFact } from '@lib/ui/popupView';
import {
  acceptsTranscribe,
  byline,
  canChangeProfile,
  canChooseRoute,
  compareSessions,
  dayLabel,
  defaultRouteText,
  errorText,
  failureKind,
  formatLength,
  formatTime,
  liveClock,
  namesText,
  profileMissing,
  recordingCautions,
  routeChoice,
  rowActions,
  runningFor,
  sessionRow,
  settingsList,
  shortDay,
  speakerNames,
  stageLabel,
  stageStep,
  statusView,
  storageSummary,
  whenText,
  type RowAction,
} from '@lib/ui/sessionView';

const STARTED = Date.UTC(2026, 8, 19, 8, 15, 0);
const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const MB = 1024 * 1024;
/** DEFAULT_SETTINGS' profiles: Team and Personal, without databases. */
const [TEAM, PERSONAL] = DEFAULT_SETTINGS.profiles as [Profile, Profile];

function meta(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    startedAt: STARTED,
    status: 'ready',
    route: 'team',
    profileId: 'team',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 12, bytes: 3 * MB, micIncluded: true },
    captionCount: 40,
    ...patch,
  };
}

const ALL: SessionStatus[] = [
  'recording',
  'awaiting-route',
  'ready',
  'processing',
  'processed',
  'saving',
  'saved',
  'duplicate',
  'empty',
  'failed',
];

const NOTION = { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Marie' };

/** "primary | menu items" for a status, as labels. */
function summary(status: SessionStatus, hasResult = false, patch: Partial<SessionMeta> = {}) {
  const a = rowActions(meta({ status, notion: NOTION, ...patch }), { hasResult });
  return { primary: a.primary?.label ?? null, menu: a.menu.map((m) => m.label) };
}

describe('rowActions: one next step and the ⋯ menu', () => {
  it('gives each status the next step and menu from the direction', () => {
    expect(summary('recording')).toEqual({ primary: 'Stop recording', menu: ['Change profile…', 'Delete…'] });
    expect(summary('awaiting-route')).toEqual({ primary: 'Choose profile', menu: ['Delete…'] });
    expect(summary('ready')).toEqual({ primary: 'Transcribe', menu: ['Change profile…', 'Delete…'] });
    expect(summary('processing')).toEqual({ primary: null, menu: ['Delete…'] });
    expect(summary('saving', true)).toEqual({ primary: null, menu: ['Delete…'] });
    expect(summary('processed', true)).toEqual({
      primary: 'Save to Notion',
      menu: ['Transcribe again', 'Change profile…', 'Delete…'],
    });
    expect(summary('saved', true)).toEqual({ primary: 'Open in Notion', menu: ['Delete…'] });
    expect(summary('duplicate')).toEqual({
      primary: 'Open in Notion',
      menu: ['Save a second copy…', 'Change profile…', 'Delete…'],
    });
    expect(summary('empty')).toEqual({ primary: null, menu: ['Transcribe again', 'Delete…'] });
    expect(summary('failed')).toEqual({ primary: 'Try again', menu: ['Change profile…', 'Delete…'] });
    expect(summary('failed', false, { retryAt: STARTED + 600_000 })).toEqual({
      primary: 'Try now',
      menu: ['Change profile…', 'Delete…'],
    });
    // Saving failed: Try again saves the stored transcript.
    const rejected = { error: 'Notion rejected the token. Copy it again in Settings.' };
    expect(summary('failed', true, rejected)).toEqual({
      primary: 'Try again',
      menu: ['Transcribe again', 'Change profile…', 'Delete…'],
    });
    // Transcribing again failed: Try again transcribes; the kept transcript can still be saved.
    expect(summary('failed', true, { error: STOPPED.process })).toEqual({
      primary: 'Try again',
      menu: ['Save to Notion', 'Change profile…', 'Delete…'],
    });
    expect(summary('failed', true, { error: 'x', retryAt: STARTED + 600_000 })).toEqual({
      primary: 'Try now',
      menu: ['Save to Notion', 'Change profile…', 'Delete…'],
    });
  });

  it('retries what failed: the save, or the transcription', () => {
    const kinds = (patch: Partial<SessionMeta>, hasResult: boolean) => {
      const a = rowActions(meta({ status: 'failed', ...patch }), { hasResult });
      return [a.primary?.kind, ...a.menu.map((m) => m.kind)];
    };
    expect(kinds({ error: SAVE_STOPPED }, true)).toEqual(['save', 'transcribe', 'change-profile', 'delete']);
    expect(kinds({ error: problems.didNotStart('save') }, true)).toEqual(['save', 'transcribe', 'change-profile', 'delete']);
    expect(kinds({ error: problems.earlierTranscriptKept }, true)).toEqual(['transcribe', 'save', 'change-profile', 'delete']);
    expect(kinds({ error: problems.transcribingStopped }, false)).toEqual(['transcribe', 'change-profile', 'delete']);
    // The meeting's profile was deleted: choosing another is the next step.
    expect(kinds({ error: problems.profileDeleted }, true)).toEqual(['choose-profile', 'delete']);
  });

  it('only asks for what the background accepts', () => {
    for (const status of ALL) {
      for (const hasResult of [false, true]) {
        const m = meta({ status, notion: NOTION });
        const a = rowActions(m, { hasResult });
        for (const action of [a.primary, ...a.menu].filter((x): x is RowAction => x !== null && x.enabled)) {
          const carries = ['change-profile', 'choose-profile', 'second-copy'].includes(action.kind);
          const request = carries ? action.then : action.kind;
          if (request === 'transcribe') expect(acceptsTranscribe(m), `${status}/${action.label}`).toBe(true);
          if (request === 'save') {
            expect(hasResult, `${status}/${action.label}`).toBe(true);
            expect(['processed', 'failed', 'duplicate']).toContain(status);
          }
          if (action.kind === 'change-profile' || action.kind === 'choose-profile') {
            expect(canChangeProfile(m), `${status}/${action.label}`).toBe(true);
          }
          if (action.kind === 'stop') expect(status).toBe('recording');
        }
      }
    }
  });

  it('never offers Save without a stored transcript; a duplicate is transcribed again instead', () => {
    const dup = rowActions(meta({ status: 'duplicate', notion: NOTION }), { hasResult: false });
    const second = dup.menu.find((m) => m.kind === 'second-copy')!;
    expect(second).toMatchObject({ force: true, confirm: true, then: 'transcribe' });
    const withResult = rowActions(meta({ status: 'duplicate', notion: NOTION }), { hasResult: true });
    expect(withResult.menu.find((m) => m.kind === 'second-copy')).toMatchObject({ force: true, then: 'save' });
  });

  it('skips the Notion check only for a second copy', () => {
    for (const status of ALL) {
      for (const hasResult of [false, true]) {
        const a = rowActions(meta({ status, notion: NOTION }), { hasResult });
        for (const action of [a.primary, ...a.menu]) {
          if (action?.force) expect(action.kind).toBe('second-copy');
        }
      }
    }
  });

  it('keeps Delete… last and asks first; while a job runs it says why it is unavailable', () => {
    for (const status of ALL) {
      const a = rowActions(meta({ status }), { hasResult: true });
      const last = a.menu[a.menu.length - 1]!;
      expect(last).toMatchObject({ kind: 'delete', label: 'Delete…', confirm: true });
    }
    expect(rowActions(meta({ status: 'processing' }), { hasResult: false }).menu[0]).toMatchObject({
      enabled: false,
      note: 'Wait for it to finish',
    });
  });

  it('links a saved meeting to its page', () => {
    expect(rowActions(meta({ status: 'saved', notion: NOTION }), { hasResult: true }).primary).toMatchObject({
      kind: 'open',
      url: 'https://www.notion.so/p1',
    });
    expect(rowActions(meta({ status: 'saved' }), { hasResult: true }).primary).toBeNull();
  });

  it('disables everything while a request for the meeting is pending', () => {
    for (const status of ALL) {
      const a = rowActions(meta({ status, notion: NOTION }), { hasResult: true, pending: true });
      expect([a.primary, ...a.menu].some((x) => x?.enabled)).toBe(false);
    }
  });
});

describe('profiles on a row', () => {
  const names = new Map([['team', 'Team'], ['client', 'Client meeting']]);

  it('shows the profile name', () => {
    expect(sessionRow(meta({ status: 'saved', profileId: 'client' }), { now: STARTED, profileNames: names }).profileName).toBe('Client meeting');
    expect(sessionRow(meta({ status: 'saved', profileId: 'gone' }), { now: STARTED, profileNames: names }).profileName).toBeUndefined();
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

  it('asks a meeting waiting for a destination to choose a profile, which transcribes it', () => {
    expect(rowActions(meta({ status: 'awaiting-route' }), { hasResult: false }).primary).toMatchObject({
      kind: 'choose-profile',
      label: 'Choose profile',
      then: 'transcribe',
    });
  });

  it('knows a deleted profile by the background’s words', () => {
    expect(profileMissing({ status: 'failed', error: problems.profileDeleted })).toBe(true);
    expect(profileMissing({ status: 'failed', error: problems.transcribingStopped })).toBe(false);
    expect(profileMissing({ status: 'processed', error: problems.profileDeleted })).toBe(false);
  });

  it('allows a profile change only where the background accepts it', () => {
    expect(ALL.filter((status) => canChangeProfile(meta({ status })))).toEqual([
      'recording',
      'awaiting-route',
      'ready',
      'processed',
      'duplicate',
      'empty',
      'failed',
    ]);
  });
});

describe('routeChoice', () => {
  it('asks for a destination only while the meeting waits for one', () => {
    expect(ALL.map((status) => [status, routeChoice(meta({ status }))])).toEqual([
      ['recording', null],
      ['awaiting-route', 'required'],
      ['ready', null],
      ['processing', null],
      ['processed', null],
      ['saving', null],
      ['saved', null],
      ['duplicate', null],
      ['empty', null],
      ['failed', null],
    ]);
  });

  it('allows a destination change only where the background accepts it', () => {
    expect(ALL.filter((status) => canChooseRoute(meta({ status })))).toEqual([
      'awaiting-route',
      'ready',
      'processed',
      'duplicate',
      'empty',
      'failed',
    ]);
  });
});

describe('statusView', () => {
  it('gives each status a glyph tone and the glossary word', () => {
    const view = (status: SessionStatus, patch: Partial<SessionMeta> = {}) => {
      const v = statusView(meta({ status, notion: NOTION, ...patch }));
      return `${v.tone}: ${v.label}`;
    };
    expect(ALL.map((s) => view(s))).toEqual([
      'live: Recording',
      'caution: Choose a profile',
      'neutral: Not transcribed',
      'working: Starting',
      'caution: Transcribed, not saved yet',
      'working: Saving to Notion',
      'done: Saved to Notion',
      'done: Saved by Marie',
      'none: Nothing to save',
      'caution: Couldn’t transcribe',
    ]);
    expect(statusView(meta({ status: 'failed', error: SAVE_STOPPED }), { hasResult: true }).label).toBe(
      'Couldn’t save to Notion',
    );
    expect(statusView(meta({ status: 'duplicate', notion: { pageId: 'p', url: 'u' } })).label).toBe(
      'Saved by a teammate',
    );
  });

  it('tells a failed save from a transcription that failed again and kept the earlier transcript', () => {
    const failed = (error: string, hasResult: boolean, patch: Partial<SessionMeta> = {}) => {
      const v = statusView(meta({ status: 'failed', error, ...patch }), { hasResult });
      return v.detail ? `${v.label} · ${v.detail}` : v.label;
    };
    const RETRY = problems.geminiRetrying('Gemini API error 503', STARTED + 600_000, 'en-GB');
    // A save (the stored result is what it was saving).
    expect(failed('Notion rejected the token. Copy it again in Settings.', true)).toBe('Couldn’t save to Notion');
    expect(failed(SAVE_STOPPED, true)).toBe('Couldn’t save to Notion');
    expect(failed(problems.didNotStart('save'), true)).toBe('Couldn’t save to Notion');
    expect(failed('Saving to Notion failed: rate limited', true)).toBe('Couldn’t save to Notion');
    // Transcribing again, with the earlier transcript kept.
    expect(failed(problems.transcribingStopped, true)).toBe('Couldn’t transcribe again · Kept the earlier transcript');
    expect(failed(problems.didNotStart('process'), true)).toBe('Couldn’t transcribe again · Kept the earlier transcript');
    expect(failed(RETRY, true, { retryAt: STARTED + 600_000 })).toBe(
      'Couldn’t transcribe again · Kept the earlier transcript',
    );
    expect(failed(problems.geminiGaveUp('Gemini API error 503', 3), true)).toBe(
      'Couldn’t transcribe again · Kept the earlier transcript',
    );
    // The error says so already.
    expect(failed(problems.earlierTranscriptKept, true)).toBe('Couldn’t transcribe again');
    // Transcribing for the first time.
    expect(failed(problems.transcribingStopped, false)).toBe('Couldn’t transcribe');
    expect(failed(RETRY, false, { retryAt: STARTED + 600_000 })).toBe('Couldn’t transcribe');
    expect(failureKind(meta({ status: 'failed', error: STOPPED.process }), false)).toBe('transcribe');
    expect(failureKind(meta({ status: 'failed', error: STOPPED.process }), true)).toBe('transcribe-again');
    expect(failureKind(meta({ status: 'failed', error: STOPPED.save }), true)).toBe('save');
  });

  it('never uses red or the accent outside recording: working is grey, problems amber', () => {
    for (const s of ALL) {
      const tone = statusView(meta({ status: s })).tone;
      if (s !== 'recording') expect(tone).not.toBe('live');
    }
  });

  it('names the stage in words, with the step it is on (the one number)', () => {
    const at = (stage: SessionMeta['stage']) => statusView(meta({ status: 'processing', stage }));
    expect(at('checking-duplicate')).toMatchObject({ label: 'Starting', detail: 'Checking whether a teammate saved it' });
    expect(at('loading-audio')).toMatchObject({ label: 'Starting', detail: 'Reading the audio' });
    expect(at('transcribing-timing')).toMatchObject({ label: 'Transcribing', detail: 'Listening to the recording' });
    expect(at('transcribing-text')).toMatchObject({ label: 'Transcribing', detail: 'Writing out what was said' });
    expect(at('aligning')).toMatchObject({ label: 'Transcribing', detail: 'Lining up words and times' });
    expect(at('merging')).toMatchObject({ label: 'Transcribing', detail: 'Matching words to speakers' });
    expect(at('summarizing')).toMatchObject({ label: 'Summarizing', detail: 'Writing the summary' });
    expect(at('saving').label).toBe('Saving to Notion');
    expect(stageStep({ status: 'processing', stage: 'transcribing-text' })).toBe(4);
    expect(stageStep({ status: 'processing' })).toBe(1);
    expect(stageStep({ status: 'saving' })).toBe(8);
    const stages = ['checking-duplicate', 'loading-audio', 'transcribing-timing', 'transcribing-text', 'aligning', 'merging', 'summarizing', 'saving'] as const;
    expect(new Set(stages.map(stageLabel)).size).toBe(stages.length);
    // "Step 4 of 8" under the bar is the only counter.
    for (const stage of stages) expect(stageLabel(stage)).not.toMatch(/\d/);
  });

  it('reads missing settings as a failed save, and says what to add', () => {
    const error = 'Missing settings: Notion integration token, Notion team database id. Add them in Settings, then try again.';
    expect(statusView(meta({ status: 'failed', error })).label).toBe('Couldn’t save to Notion');
    expect(statusView(meta({ status: 'failed', error }), { hasResult: true }).label).toBe('Couldn’t save to Notion');
    expect(errorText(error)).toBe('Add a Notion token and the Team database in Settings, then try again.');
  });

  it('reads the record the background stores from missingForSave', () => {
    // sessionManager markMissingSettings: `Missing settings: ${missing.join(', ')}. Add them in Settings, then try again.`
    const record = (missing: string[]) => `Missing settings: ${missing.join(', ')}. Add them in Settings, then try again.`;
    const all = record(missingForSave(DEFAULT_SETTINGS, TEAM));
    expect(errorText(all)).toBe('Add your name, a Notion token and the Team profile’s database in Settings, then try again.');
    const name = record(missingForSave({ ...DEFAULT_SETTINGS, notionToken: 't' }, { name: 'Personal', databaseId: 'd' }));
    expect(errorText(name)).toBe('Add your name in Settings, then try again.');
    expect(statusView(meta({ status: 'failed', error: name })).label).toBe('Couldn’t save to Notion');
    // Stored as the sentence itself (copy.ts problems.missingSettings), it reads the same.
    const sentence = problems.missingSettings(['your name']);
    expect(statusView(meta({ status: 'failed', error: sentence })).label).toBe('Couldn’t save to Notion');
    expect(statusView(meta({ status: 'failed', error: problems.missingSettings(['the Team database']) })).label).toBe(
      'Couldn’t save to Notion',
    );
    expect(errorText(sentence)).toBe('Add your name in Settings, then try again.');
  });

  it('sets stored errors with typographic apostrophes, as the rest of the UI', () => {
    expect(errorText("This database isn't shared with your token.")).toBe('This database isn’t shared with your token.');
    expect(errorText("Notion said 'no'.")).toBe("Notion said 'no'.");
  });

  it('uses curly apostrophes in every word it writes', () => {
    const words = ALL.flatMap((status) =>
      [false, true].flatMap((hasResult) => {
        const v = statusView(meta({ status, notion: NOTION, error: STOPPED.process }), { hasResult });
        return [v.label, v.detail ?? ''];
      }),
    );
    words.push(storageSummary([meta()], null, 7).text, defaultRouteText('Team', undefined));
    for (const w of words) expect(w).not.toMatch(/'/);
  });
});

describe('dates and times', () => {
  const NOW = Date.UTC(2026, 8, 19, 15, 42, 0);

  it('uses a 24-hour clock where the locale does, in English words', () => {
    expect(formatTime(STARTED, FMT)).toBe('08:15');
    expect(formatTime(STARTED, { locale: 'fr-FR', timeZone: 'UTC' })).toBe('08:15');
    expect(formatTime(Date.UTC(2026, 8, 19, 15, 40), { locale: 'en-US', timeZone: 'UTC' })).toMatch(/^3:40\sPM$/);
  });

  it('names days: Today, Yesterday, then the weekday and date, with the year only when it differs', () => {
    expect(dayLabel(NOW - 3_600_000, NOW, FMT)).toBe('Today');
    expect(dayLabel(NOW - 26 * 3_600_000, NOW, FMT)).toBe('Yesterday');
    expect(dayLabel(NOW - 2 * 86_400_000, NOW, FMT)).toBe('Thursday 17 September');
    // Day before month whatever the locale: the words are English, and one order everywhere.
    expect(dayLabel(NOW - 2 * 86_400_000, NOW, { locale: 'de-DE', timeZone: 'UTC' })).toBe('Thursday 17 September');
    expect(dayLabel(NOW - 2 * 86_400_000, NOW, { locale: 'en-US', timeZone: 'UTC' })).toBe('Thursday 17 September');
    expect(dayLabel(Date.UTC(2025, 11, 30, 12), NOW, FMT)).toBe('Tuesday 30 December 2025');
    // Calendar days in the page's zone, not 24-hour spans.
    const lateYesterday = Date.UTC(2026, 8, 18, 23, 30);
    expect(dayLabel(lateYesterday, Date.UTC(2026, 8, 19, 0, 30), FMT)).toBe('Yesterday');
    expect(dayLabel(lateYesterday, Date.UTC(2026, 8, 19, 0, 30), { ...FMT, timeZone: 'Europe/Paris' })).toBe('Today');
  });

  it('writes a day in a line as the popup and routing do: "Wed 16 Sep", never "Sept"', () => {
    expect(shortDay(NOW - 3_600_000, NOW, FMT)).toBe('Today');
    expect(shortDay(NOW - 26 * 3_600_000, NOW, FMT)).toBe('Yesterday');
    expect(shortDay(NOW - 3 * 86_400_000, NOW, FMT)).toBe('Wed 16 Sep');
    expect(shortDay(Date.UTC(2026, 5, 4, 12), NOW, FMT)).toBe('Thu 4 Jun');
    expect(shortDay(Date.UTC(2025, 11, 30, 12), NOW, FMT)).toBe('Tue 30 Dec 2025');
    // Every month in three letters.
    const months = Array.from({ length: 12 }, (_, m) => shortDay(Date.UTC(2026, m, 1, 12), NOW, FMT).split(' ')[2]);
    expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('puts the day before the time, kept on one line', () => {
    const nbsp = '\u00a0';
    expect(whenText(NOW - 3_600_000, NOW, FMT)).toBe(`Today${nbsp}14:42`);
    expect(whenText(NOW - 26 * 3_600_000, NOW, FMT)).toBe(`Yesterday${nbsp}13:42`);
    expect(whenText(NOW - 3 * 86_400_000, NOW, FMT)).toBe(['Wed', '16', 'Sep', '15:42'].join(nbsp));
  });

  it('writes lengths the way people say them', () => {
    expect(formatLength(40_000)).toBe('40 s');
    expect(formatLength(32 * 60_000 + 10_000)).toBe('32 min');
    expect(formatLength(60 * 60_000)).toBe('1 h');
    expect(formatLength(65 * 60_000)).toBe('1 h 5 min');
    expect(liveClock(12 * 60_000 + 48_000)).toBe('12:48');
    expect(liveClock(3_723_000)).toBe('1:02:03');
    expect(runningFor(20_000)).toBe('just started');
    expect(runningFor(3 * 60_000)).toBe('running for 3 min');
  });
});

describe('bylines (the roll, reused)', () => {
  const speakers = (names: [string, boolean][]) =>
    names.map(([name, self], i) => ({ name, self, firstAt: i * 1000, lastAt: i * 1000 + 500, talkMs: 500 }));

  it('lists speakers in order of first speech, the local user as "you"', () => {
    const m = meta({ speakers: speakers([['Marie Curie', false], ['Vous', true], ['Tom Martin', false]]) });
    expect(speakerNames(m)).toEqual(['Marie Curie', 'you', 'Tom Martin']);
    expect(namesText(speakerNames(m))).toBe('Marie Curie, you, Tom Martin');
    expect(namesText(['you', 'Julien'])).toBe('You, Julien');
  });

  it('falls back to the transcript attendees, then says there were no speakers', () => {
    expect(speakerNames(meta(), ['Ilya', 'Sofia'])).toEqual(['Ilya', 'Sofia']);
    expect(byline(meta()).names).toBe('No speakers');
    expect(byline(meta({ status: 'recording' })).names).toBe('No speakers yet');
  });

  it('shortens long rolls', () => {
    expect(namesText(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C, D, E');
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A, B, C, D and 3 more');
  });

  it('adds the audio on this computer, or the meet code while recording', () => {
    expect(byline(meta(), { audioBytes: 38.2 * MB })).toMatchObject({ audio: '38.2 MB audio', recovered: false });
    expect(byline(meta({ audio: { ...meta().audio, deletedAt: 1 } })).audio).toBe('Audio deleted');
    expect(byline(meta({ audio: { ...meta().audio, bytes: 0, error: 'Tab capture failed' } })).audio).toBe('No call audio');
    const rec = byline(meta({ status: 'recording', meetingTitle: 'Pricing call' }));
    expect(rec).toMatchObject({ code: 'abc-defg-hij' });
    expect(rec.audio).toBeUndefined();
    // The code is the title already.
    expect(byline(meta({ status: 'recording' })).code).toBeUndefined();
    expect(byline(meta({ recovered: true })).recovered).toBe(true);
  });
});

describe('sessionRow', () => {
  it('formats a saved meeting', () => {
    const row = sessionRow(meta({ status: 'saved', meetingTitle: 'Weekly sync', durationMs: 3_723_000, notion: NOTION }), {
      now: STARTED + 4_000_000,
      profileNames: new Map([['team', 'Team']]),
      ...FMT,
    });
    expect(row).toMatchObject({
      title: 'Weekly sync',
      meetCode: 'abc-defg-hij',
      time: '08:15',
      length: '1 h 2 min',
      profileName: 'Team',
      status: { tone: 'done', label: 'Saved to Notion' },
      byline: { names: 'No speakers', audio: '3.0 MB audio' },
    });
    expect(row.error).toBeUndefined();
  });

  it('uses the meet code as the title when Meet gave none', () => {
    expect(sessionRow(meta(), { now: STARTED, ...FMT }).title).toBe('abc-defg-hij');
  });

  it('shows a live clock while recording, else the length or a dash', () => {
    expect(sessionRow(meta({ status: 'recording' }), { now: STARTED + 125_000, ...FMT }).length).toBe('2:05');
    expect(sessionRow(meta({ endedAt: STARTED + 60_000 }), { now: STARTED, ...FMT }).length).toBe('1 min');
    expect(sessionRow(meta(), { now: STARTED, ...FMT }).length).toBe('—');
  });

  it('shows the step and how long the job has run', () => {
    const row = sessionRow(
      meta({ status: 'processing', stage: 'transcribing-text', job: { id: 'j', kind: 'process', startedAt: STARTED } }),
      { now: STARTED + 3 * 60_000, ...FMT },
    );
    expect(row.progress).toEqual({ step: 4, running: 'running for 3 min' });
    expect(sessionRow(meta({ status: 'processing' }), { now: STARTED, ...FMT }).progress).toEqual({ step: 1 });
    expect(sessionRow(meta({ status: 'ready' }), { now: STARTED, ...FMT }).progress).toBeUndefined();
  });

  it('says when a failed transcription is tried again, once, in the page clock', () => {
    const retryAt = Date.UTC(2026, 8, 19, 9, 25, 0);
    const current = sessionRow(
      meta({ status: 'failed', retryAt, error: problems.geminiRetrying('Gemini API error 503', retryAt, 'en-US') }),
      { now: STARTED, ...FMT },
    );
    expect(current).toMatchObject({ error: 'Gemini is unavailable right now (503).', retry: 'Trying again at 09:25' });
    const row = sessionRow(
      meta({ status: 'failed', retryAt, error: 'Gemini unreachable: HTTP 503. Retrying automatically at 11:25.' }),
      { now: STARTED, ...FMT },
    );
    expect(row.retry).toBe('Trying again at 09:25');
    expect(row.error).toBe('Gemini unreachable: HTTP 503.');
    expect(sessionRow(meta({ status: 'failed', error: 'x' }), { now: STARTED, ...FMT }).retry).toBeUndefined();
    expect(sessionRow(meta({ status: 'processing', retryAt }), { now: STARTED, ...FMT }).retry).toBeUndefined();
  });

  it('carries recording problems', () => {
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    const row = sessionRow(meta({ status: 'recording', captionsError: why, audio: { ...meta().audio, error: 'x' } }), {
      now: STARTED,
      ...FMT,
    });
    expect(row.cautions).toEqual([
      { key: 'audio', text: 'No call audio — saving captions only' },
      { key: 'captions', text: 'Captions aren’t coming through', detail: why },
    ]);
    expect(sessionRow(meta(), { now: STARTED, ...FMT }).cautions).toEqual([]);
  });

  it('tells a Meet code standing in for the title apart', () => {
    expect(sessionRow(meta(), { now: STARTED, ...FMT })).toMatchObject({ title: 'abc-defg-hij', isCode: true });
    expect(sessionRow(meta({ meetingTitle: ' Sync ' }), { now: STARTED, ...FMT })).toMatchObject({ title: 'Sync', isCode: false });
  });

  it('drops an old error once the meeting is saved or on its way', () => {
    expect(sessionRow(meta({ status: 'saved', error: 'old' }), { now: STARTED, ...FMT }).error).toBeUndefined();
    expect(sessionRow(meta({ status: 'processing', error: 'old' }), { now: STARTED, ...FMT }).error).toBeUndefined();
    expect(sessionRow(meta({ status: 'processed', error: 'Notion said no' }), { now: STARTED, ...FMT }).error).toBe(
      'Notion said no',
    );
  });
});

describe('settingsList', () => {
  it('names missing settings the way people know them, in setup order', () => {
    expect(settingsList(missingForSave(DEFAULT_SETTINGS, TEAM))).toBe('your name, a Notion token and the Team profile’s database');
    expect(settingsList(missingForSave({ ...DEFAULT_SETTINGS, displayName: 'Ilya' }, PERSONAL))).toBe(
      'a Notion token and the Personal profile’s database',
    );
    expect(settingsList(['the Client meeting profile’s database', 'your name'])).toBe(
      'your name and the Client meeting profile’s database',
    );
    expect(settingsList(['a Gemini key', 'your name'])).toBe('your name and a Gemini key');
    expect(settingsList([])).toBe('');
  });

  it('still reads the names older records stored', () => {
    expect(settingsList(['Notion integration token', 'Notion team database id', 'Your name'])).toBe(
      'your name, a Notion token and the Team database',
    );
    expect(settingsList(['Notion personal database id'])).toBe('the Personal database');
  });
});

describe('storageSummary', () => {
  it('sums the audio on this computer and says when it goes', () => {
    const sessions = [meta({ id: 'a' }), meta({ id: 'b', audio: { ...meta().audio, bytes: 1024 } })];
    const s = storageSummary(sessions, new Map([['a', 2048]]), 7);
    expect(s.audioBytes).toBe(2048 + 1024);
    expect(s.text).toBe('Audio on this computer: 3.0 KB for 2 meetings. It’s deleted 7 days after a meeting is saved to Notion.');
    expect(storageSummary([meta({ id: 'a' })], null, 1).text).toMatch(/for 1 meeting\. It’s deleted 1 day after/);
    expect(storageSummary([meta({ id: 'a' })], null, 0).text).toMatch(/It’s deleted once a meeting is saved/);
  });

  it('counts only meetings that still have audio', () => {
    const gone = meta({ id: 'c', audio: { ...meta().audio, deletedAt: 1 } });
    expect(storageSummary([gone, meta({ id: 'd' })], new Map([['d', 1024]]), 7).meetings).toBe(1);
    expect(storageSummary([gone], null, 7).text).toBe('No meeting audio is stored on this computer.');
  });
});

describe('compareSessions', () => {
  it('orders newest first, then by id descending, like listSessions', () => {
    const a = meta({ id: 'a', startedAt: 1 });
    const b = meta({ id: 'b', startedAt: 2 });
    const c = meta({ id: 'c', startedAt: 2 });
    expect([a, b, c].sort(compareSessions).map((m) => m.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('a recording’s problems (recordingHealth → recordingCautions)', () => {
  const MIN = 60_000;
  const speaker = (name: string, lastAt: number): SpeakerInfo => ({ name, self: false, firstAt: 0, lastAt, talkMs: 1000 });
  const recording = (patch: Partial<SessionMeta> = {}) =>
    meta({
      status: 'recording',
      route: undefined,
      captionCount: 40,
      speakers: [speaker('Marie Curie', 9 * MIN)],
      audio: { ...meta().audio, lastChunkAt: STARTED + 10 * MIN - 2000 },
      ...patch,
    });
  const at = STARTED + 10 * MIN;

  it('is quiet while audio and captions flow', () => {
    expect(recordingHealth(recording(), at)).toEqual({ audio: null, captions: null });
    expect(recordingCautions(recording(), at)).toEqual([]);
    // Only a recording has any.
    expect(recordingCautions(meta({ status: 'ready', captionCount: 0 }), at)).toEqual([]);
  });

  it('calls audio stalled after 15 s without a chunk, in 5 s steps, then minutes', () => {
    const last = at - AUDIO_STALL_MS;
    expect(recordingHealth(recording({ audio: { ...meta().audio, lastChunkAt: last } }), at).audio).toBeNull();
    const stalled = recording({ audio: { ...meta().audio, lastChunkAt: at - 22_000 } });
    expect(recordingCautions(stalled, at)[0]).toMatchObject({ key: 'audio', text: 'No audio for 20 s' });
    // Never a chunk: counted from the start.
    const never = recording({ audio: { ...meta().audio, lastChunkAt: undefined } });
    expect(recordingCautions(never, at)[0]!.text).toBe('No audio for 10 min');
    expect(silenceText(19_999)).toBe('15 s');
    expect(silenceText(61_000)).toBe('1 min');
    expect(minutesText(72 * MIN)).toBe('1 h 12 min');
  });

  it('asks for captions 20 s in with none, and warns after 5 quiet minutes', () => {
    const none = recording({ captionCount: 0, speakers: [], startedAt: at - NO_CAPTIONS_AFTER_MS });
    expect(recordingCautions(none, at)).toEqual([{ key: 'captions', text: 'No captions yet — turn on captions (CC) in Meet' }]);
    expect(recordingCautions({ ...none, startedAt: at - NO_CAPTIONS_AFTER_MS + 1 }, at)).toEqual([]);
    // Captions but no names yet: not a problem.
    expect(recordingCautions(recording({ speakers: [] }), at)).toEqual([]);
    const lastAt = 10 * MIN - CAPTIONS_QUIET_WARN_MS - 60_000;
    expect(recordingCautions(recording({ speakers: [speaker('Tom', lastAt)] }), at)).toEqual([
      { key: 'captions', text: 'No captions for 6 min', detail: 'If people are talking, check that captions (CC) are on in Meet.' },
    ]);
    expect(recordingCautions(recording({ speakers: [speaker('Tom', 10 * MIN - CAPTIONS_QUIET_WARN_MS)] }), at)).toEqual([]);
  });

  it('shows audio and captions problems together, audio first', () => {
    const both = recording({ audio: { ...meta().audio, error: 'x' }, captionCount: 0, speakers: [] });
    expect(recordingCautions(both, at).map((c) => c.key)).toEqual(['audio', 'captions']);
  });

  it('warns exactly when the popup warns, in the popup’s words', () => {
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    const cases: SessionMeta[] = [
      recording(),
      recording({ audio: { ...meta().audio, error: 'Tab audio capture failed' } }),
      recording({ audio: { ...meta().audio, lastChunkAt: at - 20_000 } }),
      recording({ audio: { ...meta().audio, lastChunkAt: at - 3 * MIN } }),
      recording({ captionsError: why }),
      recording({ captionCount: 0, speakers: [] }),
      recording({ captionCount: 0, speakers: [], startedAt: at - 10_000, audio: { ...meta().audio, lastChunkAt: at - 1000 } }),
      recording({ speakers: [speaker('Tom', 2 * MIN)] }),
      recording({ speakers: [speaker('Tom', 7 * MIN)] }),
    ];
    for (const session of cases) {
      const state = popupState({
        tab: { id: 1, url: `https://meet.google.com/${session.meetCode}` },
        active: { sessionId: session.id, tabId: 1, meetCode: session.meetCode },
        session,
      });
      if (state.kind !== 'recording') throw new Error('not recording');
      const popupAudio = audioFact(state, 'granted', true, at);
      const popupSpeakers = speakersFact(state, at);
      const rows = recordingCautions(session, at);
      const audio = rows.find((c) => c.key === 'audio');
      const captions = rows.find((c) => c.key === 'captions');

      expect(!!audio, 'audio').toBe(popupAudio.tone === 'caution');
      if (audio) {
        expect(audio.text).toBe(popupAudio.value);
        if (audio.detail) expect(audio.detail).toBe(popupAudio.detail);
      }
      const popupWarns = popupSpeakers.tone === 'caution' || popupSpeakers.warning !== undefined;
      expect(!!captions, 'captions').toBe(popupWarns);
      if (captions) {
        const popupWords = popupSpeakers.warning ?? (popupSpeakers.value as string);
        // "None yet — …" leans on the popup's "Speakers" label; the row says "No captions yet — …".
        expect(captions.text.replace(/^No captions yet/, 'None yet')).toBe(popupWords);
        if (captions.detail) expect(captions.detail).toBe(popupSpeakers.detail);
      }
    }
  });
});

describe('defaultRouteText', () => {
  it('says where a meeting goes if nobody chooses, and when when it is known', () => {
    expect(defaultRouteText('Team', Date.UTC(2026, 8, 19, 15, 34), FMT)).toBe('If you don’t choose, it goes to Team at 15:34.');
    expect(defaultRouteText('Client meeting', undefined, FMT)).toBe('If you don’t choose, it goes to Client meeting.');
  });
});
