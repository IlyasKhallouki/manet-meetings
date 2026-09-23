import { describe, expect, it } from 'vitest';
import {
  AUDIO_STALL_MS,
  CAPTIONS_QUIET_NOTE_MS,
  CAPTIONS_QUIET_WARN_MS,
  NO_CAPTIONS_AFTER_MS,
  recordingHealth,
} from '@lib/recordingHealth';
import { starterProfiles } from '@lib/profiles';
import { DEFAULT_SETTINGS } from '@lib/settingsSchema';
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import * as popupView from '@lib/ui/popupView';
import {
  SPEAKING_WITHIN_MS,
  audioFact,
  formatElapsed,
  meetingsLabel,
  meetTitleFromTab,
  popupState,
  recentRow,
  rollEntries,
  setupGaps,
  setupSentence,
  speakersFact,
  type PopupState,
} from '@lib/ui/popupView';
import { formatLength, formatTime, whenText } from '@lib/ui/sessionView';

const CALL = 'https://meet.google.com/abc-defg-hij?authuser=0';
const STARTED = Date.UTC(2026, 8, 19, 8, 15, 0);
const FMT = { locale: 'en-GB', timeZone: 'UTC' };

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    startedAt: STARTED,
    status: 'recording',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 1, bytes: 100, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

const active = { sessionId: 'abc-defg-hij_20260919T081500Z', tabId: 7, meetCode: 'abc-defg-hij' };

const speaker = (name: string, firstAt: number, lastAt: number, self = false): SpeakerInfo => ({
  name,
  self,
  firstAt,
  lastAt,
  talkMs: lastAt - firstAt,
});

type Recording = Extract<PopupState, { kind: 'recording' }>;

function recording(patch: Partial<SessionMeta> = {}): Recording {
  const state = popupState({ tab: { id: 7, url: CALL }, active, session: session(patch) });
  if (state.kind !== 'recording') throw new Error('not recording');
  return state;
}

describe('popupState', () => {
  it('asks for a Meet call when the tab is something else', () => {
    expect(popupState({ tab: { id: 3, url: 'https://example.com/' }, active: null, session: null })).toEqual({
      kind: 'not-meet',
      onMeet: false,
    });
    expect(popupState({ tab: null, active: null, session: null })).toEqual({ kind: 'not-meet', onMeet: false });
  });

  it('asks to join a call on the Meet home page', () => {
    expect(popupState({ tab: { id: 3, url: 'https://meet.google.com/' }, active: null, session: null })).toEqual({
      kind: 'not-meet',
      onMeet: true,
    });
  });

  it('offers Record on a call tab, titled from the tab when Meet names the meeting', () => {
    expect(popupState({ tab: { id: 7, url: CALL }, active: null, session: null })).toEqual({
      kind: 'idle',
      tabId: 7,
      meetCode: 'abc-defg-hij',
    });
    expect(
      popupState({ tab: { id: 7, url: CALL, title: 'Meet - Weekly product sync' }, active: null, session: null }),
    ).toEqual({ kind: 'idle', tabId: 7, meetCode: 'abc-defg-hij', title: 'Weekly product sync' });
  });

  it('cannot record a tab without an id', () => {
    expect(popupState({ tab: { url: CALL }, active: null, session: null }).kind).toBe('not-meet');
  });

  it('shows the recording of this tab, with what the popup needs from the meta', () => {
    const speakers = [speaker('Marie Curie', 1000, 5000)];
    const s = session({
      meetingTitle: 'Weekly sync',
      speakers,
      captionCount: 3,
      audio: { ...session().audio, lastChunkAt: STARTED + 5000, micIncluded: false },
    });
    expect(popupState({ tab: { id: 7, url: CALL }, active, session: s })).toEqual({
      kind: 'recording',
      sessionId: s.id,
      startedAt: STARTED,
      meetCode: 'abc-defg-hij',
      title: 'Weekly sync',
      thisTab: true,
      tabId: 7,
      micIncluded: false,
      lastChunkAt: STARTED + 5000,
      captionCount: 3,
      speakers,
    });
  });

  it('shows a recording running in another tab, whatever this tab is, and which tab it is', () => {
    const state = popupState({ tab: { id: 9, url: 'https://example.com/' }, active, session: session() });
    expect(state).toMatchObject({ kind: 'recording', thisTab: false, tabId: 7 });
  });

  it('reports why audio or captions are missing', () => {
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    const s = session({ audio: { ...session().audio, error: 'Tab capture failed' }, captionsError: why });
    expect(popupState({ tab: { id: 7, url: CALL }, active, session: s })).toMatchObject({
      audioError: 'Tab capture failed',
      captionsError: why,
    });
  });

  it('ignores a stale pointer whose session is gone or finished', () => {
    const tab = { id: 7, url: CALL };
    expect(popupState({ tab, active, session: null }).kind).toBe('idle');
    expect(popupState({ tab, active, session: session({ status: 'awaiting-route' }) }).kind).toBe('idle');
  });
});

describe('meetTitleFromTab', () => {
  it('keeps the meeting name and drops Meet around it', () => {
    expect(meetTitleFromTab('Meet – Weekly product sync', 'abc-defg-hij')).toBe('Weekly product sync');
    expect(meetTitleFromTab('Weekly product sync - Google Meet', 'abc-defg-hij')).toBe('Weekly product sync');
  });

  it('has no title when Meet only shows the code or its own name', () => {
    expect(meetTitleFromTab('Meet - abc-defg-hij', 'abc-defg-hij')).toBeUndefined();
    expect(meetTitleFromTab('Google Meet', 'abc-defg-hij')).toBeUndefined();
    expect(meetTitleFromTab('', 'abc-defg-hij')).toBeUndefined();
    expect(meetTitleFromTab(undefined, 'abc-defg-hij')).toBeUndefined();
  });
});

describe('the roll', () => {
  const roll = [speaker('Marie Curie', 1000, 50_000), speaker('Tom Martin', 3000, 58_000), speaker('Vous', 4000, 20_000, true)];

  it('lists everyone in order of first speech, with "You" for the local user', () => {
    expect(rollEntries(roll, 60_000).map((e) => e.name)).toEqual(['Marie Curie', 'Tom Martin', 'You']);
  });

  it('marks the latest speaker while their caption is under 8 s old', () => {
    expect(SPEAKING_WITHIN_MS).toBe(8000);
    expect(rollEntries(roll, 60_000).map((e) => e.speaking)).toEqual([false, true, false]);
    expect(rollEntries(roll, 58_000 + 8000).some((e) => e.speaking)).toBe(true);
    expect(rollEntries(roll, 58_000 + 8001).some((e) => e.speaking)).toBe(false);
  });

  it('keys people stably, whatever their spelling or label', () => {
    const keys = rollEntries(roll, 60_000).map((e) => e.key);
    expect(keys).toEqual(['name:marie curie', 'name:tom martin', 'self']);
    expect(new Set(keys).size).toBe(3);
  });

  it('cuts a name too long for one line', () => {
    const [entry] = rollEntries([speaker('Jean-Baptiste Delacroix-Montmorency de la Tour', 0, 1)], 2);
    expect(entry!.name).toBe('Jean-Baptiste Delacroix…');
    expect(entry!.name.length).toBeLessThanOrEqual(24);
  });
});

describe('speakersFact', () => {
  const roll = [speaker('Marie Curie', 1000, 50_000), speaker('Tom Martin', 3000, 58_000)];

  it('shows the roll', () => {
    const fact = speakersFact(recording({ speakers: roll, captionCount: 9 }), STARTED + 60_000);
    expect(fact.label).toBe('Speakers');
    expect(fact.value).toEqual({ roll: rollEntries(roll, 60_000) });
    expect(fact.tone).toBeUndefined();
    expect(fact.detail).toBeUndefined();
  });

  it('waits quietly for the first name, then asks for captions after 20 s', () => {
    expect(NO_CAPTIONS_AFTER_MS).toBe(20_000);
    const early = speakersFact(recording(), STARTED + 19_000);
    expect(early.value).toBe('None yet');
    expect(early.tone).toBeUndefined();
    expect(speakersFact(recording(), STARTED + 20_000)).toEqual({
      label: 'Speakers',
      tone: 'caution',
      value: 'None yet — turn on captions (CC) in Meet',
      detail: 'Without captions, the transcript can’t name who spoke.',
    });
  });

  it('does not ask for captions when they arrive without names', () => {
    const fact = speakersFact(recording({ captionCount: 4 }), STARTED + 60_000);
    expect(fact.tone).toBeUndefined();
    expect(fact.value).toBe('No names yet');
  });

  it('says when captions go quiet, and warns after 5 min', () => {
    const last = 58_000;
    const at = (quiet: number) => speakersFact(recording({ speakers: roll, captionCount: 9 }), STARTED + last + quiet);
    expect(at(CAPTIONS_QUIET_NOTE_MS).detail).toBeUndefined();
    const noted = at(CAPTIONS_QUIET_NOTE_MS + 1000);
    expect(noted.detail).toBe('Last caption 2 min ago');
    expect(noted.warning).toBeUndefined();
    const warned = at(CAPTIONS_QUIET_WARN_MS + 60_000);
    expect(warned.warning).toBe('No captions for 6 min');
    expect(warned.detail).toBe('If people are talking, check that captions (CC) are on in Meet.');
    // The roll stays readable above the warning.
    expect(warned.value).toHaveProperty('roll');
  });

  it('gives the reason when the background knows why captions are missing', () => {
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    expect(speakersFact(recording({ captionsError: why }), STARTED + 1000)).toMatchObject({
      tone: 'caution',
      value: 'Captions aren’t coming through',
      detail: why,
    });
  });
});

describe('audioFact', () => {
  const idle: PopupState = { kind: 'idle', tabId: 7, meetCode: 'abc-defg-hij' };

  it('says what a recording would capture, by mic permission', () => {
    expect(audioFact(idle, 'granted', true, 0)).toEqual({ label: 'Audio', value: 'Call and your mic' });
    expect(audioFact(idle, 'prompt', true, 0)).toMatchObject({
      value: 'Call only',
      detail: 'Your mic isn’t allowed yet, so your voice won’t be in the recording.',
      action: { key: 'grant-mic', label: 'Allow microphone…' },
    });
    expect(audioFact(idle, 'unknown', true, 0).action?.label).toBe('Allow microphone…');
    expect(audioFact(idle, 'denied', true, 0)).toMatchObject({
      value: 'Call only',
      action: { key: 'grant-mic', label: 'Fix in Chrome…' },
    });
  });

  it('stays quiet when the mic is turned off in Settings', () => {
    for (const mic of ['granted', 'prompt', 'denied', 'unknown'] as const) {
      expect(audioFact(idle, mic, false, 0)).toEqual({ label: 'Audio', value: 'Call only (mic off in Settings)' });
    }
  });

  it('while recording, says what the recorder captures', () => {
    const now = STARTED + 30_000;
    const flowing = { lastChunkAt: now - 2000 };
    expect(audioFact(recording({ audio: { ...session().audio, ...flowing } }), 'granted', true, now).value).toBe(
      'Call and your mic',
    );
    const noMic = recording({ audio: { ...session().audio, ...flowing, micIncluded: false } });
    expect(audioFact(noMic, 'granted', false, now).value).toBe('Call only (mic off in Settings)');
    const blocked = audioFact(noMic, 'granted', true, now);
    expect(blocked.value).toBe('Call only');
    expect(blocked.action).toBeUndefined(); // too late for this recording
  });

  it('warns when the call audio is lost or stops arriving, without promising a reconnect', () => {
    const lost = recording({ audio: { ...session().audio, error: 'Tab capture failed' } });
    expect(audioFact(lost, 'granted', true, STARTED + 1000)).toEqual({
      label: 'Audio',
      tone: 'caution',
      value: 'No call audio — saving captions only',
      detail: 'Tab capture failed',
    });
    const last = STARTED + 60_000;
    const stalled = recording({ audio: { ...session().audio, lastChunkAt: last } });
    expect(audioFact(stalled, 'granted', true, last + AUDIO_STALL_MS).tone).toBeUndefined();
    const fact = audioFact(stalled, 'granted', true, last + 22_000);
    expect(fact).toMatchObject({ tone: 'caution', value: 'No audio for 20 s' });
    expect(fact.detail).not.toMatch(/reconnect/i);
    expect(audioFact(stalled, 'granted', true, last + 125_000).value).toBe('No audio for 2 min');
  });
});

describe('recordingHealth: the one set of rules', () => {
  const roll = [speaker('Marie Curie', 1000, 60_000)];
  const fresh = (now: number) => ({ audio: { ...session().audio, lastChunkAt: now - 1000 } });

  it('notes captions quiet for over 2 min, and calls it a problem only after 5', () => {
    const at = (quiet: number) => {
      const now = STARTED + 60_000 + quiet;
      return recordingHealth(session({ captionCount: 9, speakers: roll, ...fresh(now) }), now);
    };
    expect(at(CAPTIONS_QUIET_NOTE_MS)).toEqual({ audio: null, captions: null });
    expect(at(CAPTIONS_QUIET_NOTE_MS + 1)).toEqual({ audio: null, captions: null, captionsNote: { quietMs: CAPTIONS_QUIET_NOTE_MS + 1 } });
    expect(at(CAPTIONS_QUIET_WARN_MS).captionsNote).toEqual({ quietMs: CAPTIONS_QUIET_WARN_MS });
    // A problem replaces the note.
    expect(at(CAPTIONS_QUIET_WARN_MS + 1)).toEqual({
      audio: null,
      captions: { kind: 'quiet', quietMs: CAPTIONS_QUIET_WARN_MS + 1 },
    });
  });

  it('is what the popup’s facts follow: the popup keeps no thresholds of its own', () => {
    for (const name of ['NO_CAPTIONS_AFTER_MS', 'CAPTIONS_QUIET_NOTE_MS', 'CAPTIONS_QUIET_WARN_MS', 'AUDIO_STALL_MS', 'minutesText']) {
      expect(popupView, name).not.toHaveProperty(name);
    }
    const why = 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.';
    const now = STARTED + 10 * 60_000;
    const cases: Partial<SessionMeta>[] = [
      { captionCount: 9, speakers: roll, ...fresh(now) },
      { captionCount: 9, speakers: [speaker('Tom', 0, 10 * 60_000 - 3 * 60_000)], ...fresh(now) },
      { captionCount: 9, speakers: [speaker('Tom', 0, 10 * 60_000 - 6 * 60_000)], ...fresh(now) },
      { captionCount: 0, ...fresh(now) },
      { captionCount: 4, ...fresh(now) },
      { captionsError: why, ...fresh(now) },
      { captionCount: 9, speakers: roll, audio: { ...session().audio, error: 'Tab audio capture failed' } },
      { captionCount: 9, speakers: roll, audio: { ...session().audio, lastChunkAt: now - 16_000 } },
      { captionCount: 9, speakers: roll, audio: { ...session().audio, lastChunkAt: now - AUDIO_STALL_MS } },
    ];
    for (const patch of cases) {
      const health = recordingHealth(session(patch), now);
      const audio = audioFact(recording(patch), 'granted', true, now);
      const speakers = speakersFact(recording(patch), now);
      const label = JSON.stringify(patch);
      expect(audio.tone === 'caution', label).toBe(health.audio !== null);
      expect(speakers.tone === 'caution' || speakers.warning !== undefined, label).toBe(health.captions !== null);
      expect(/^Last caption/.test(speakers.detail ?? ''), label).toBe(health.captionsNote !== undefined);
    }
  });
});

describe('setup', () => {
  it('names what blocks saving, in plain words', () => {
    expect(setupGaps(DEFAULT_SETTINGS)).toEqual(['name', 'token', 'database']);
    expect(setupSentence(setupGaps(DEFAULT_SETTINGS), 'Team')).toBe(
      'Add your name, a Notion token and the Team profile’s database.',
    );
    expect(setupSentence(['token', 'database'], 'Client meeting')).toBe(
      'Add a Notion token and the Client meeting profile’s database.',
    );
    expect(setupSentence(['name'], 'Team')).toBe('Add your name.');
  });

  it('checks the database of the default profile', () => {
    const settings = { ...DEFAULT_SETTINGS, displayName: 'Ilya', notionToken: 'ntn_x', profiles: starterProfiles('db') };
    expect(setupGaps(settings)).toEqual([]);
    expect(setupGaps({ ...settings, defaultProfileId: 'personal' })).toEqual(['database']);
  });
});

describe('times', () => {
  it('shows elapsed time as mm:ss, then h:mm:ss', () => {
    expect(formatElapsed(47_000)).toBe('00:47');
    expect(formatElapsed(12 * 60_000 + 48_000)).toBe('12:48');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-5)).toBe('00:00');
  });

  it('writes dates, times and lengths exactly as Meetings and the routing window do (sessionView)', () => {
    const now = Date.UTC(2026, 8, 19, 15, 0);
    const row = (startedAt: number, opts: { locale: string; timeZone: string } = FMT) =>
      recentRow(session({ status: 'saved', startedAt, durationMs: 32 * 60_000, route: 'team' }), now, opts).details[0];
    const cases: [number, { locale: string; timeZone: string }][] = [
      [Date.UTC(2026, 8, 19, 0, 5), FMT],
      [Date.UTC(2026, 8, 18, 23, 55), FMT],
      [Date.UTC(2026, 8, 16, 14, 2), FMT],
      [Date.UTC(2025, 11, 29, 9, 0), FMT],
      [Date.UTC(2026, 8, 18, 23, 30), { locale: 'en-GB', timeZone: 'Europe/Paris' }],
      [Date.UTC(2026, 8, 16, 21, 5), { locale: 'en-US', timeZone: 'UTC' }],
      [Date.UTC(2026, 8, 16, 21, 5), { locale: 'fr-FR', timeZone: 'UTC' }],
    ];
    for (const [at, opts] of cases) expect(row(at, opts)).toBe(whenText(at, now, opts));
    // The glossary's shapes: "Today 14:02", "Yesterday 16:10", "Wed 16 Sep 14:02", never broken.
    const nbsp = (...words: string[]) => words.join('\u00a0');
    expect(row(Date.UTC(2026, 8, 19, 14, 2))).toBe(nbsp('Today', '14:02'));
    expect(row(Date.UTC(2026, 8, 18, 16, 10))).toBe(nbsp('Yesterday', '16:10'));
    expect(row(Date.UTC(2026, 8, 16, 14, 2))).toBe(nbsp('Wed', '16', 'Sep', '14:02'));
    expect(row(Date.UTC(2025, 11, 29, 9, 0))).toBe(nbsp('Mon', '29', 'Dec', '2025', '09:00'));
    // Day first in every locale, like the Meetings page; the clock follows the locale.
    expect(row(Date.UTC(2026, 8, 16, 21, 5), { locale: 'en-US', timeZone: 'UTC' })).toMatch(/^Wed\u00a016\u00a0Sep\u00a09:05\sPM$/);
    // The length and the retry time too.
    const failed = recentRow(session({ status: 'failed', startedAt: now - 3_600_000, retryAt: Date.UTC(2026, 8, 19, 16, 37) }), now, FMT);
    expect(failed.details[0]).toBe(`Trying again at ${formatTime(Date.UTC(2026, 8, 19, 16, 37), FMT)}`);
    for (const ms of [20_000, 59_600, 32 * 60_000, 72 * 60_000]) {
      const r = recentRow(session({ status: 'ready', startedAt: now - 3_600_000, durationMs: ms, route: undefined }), now, FMT);
      expect(r.details[1]).toBe(formatLength(ms));
    }
  });
});

describe('recentRow', () => {
  const NOW = Date.UTC(2026, 8, 19, 15, 0);
  const TODAY = 'Today\u00a014:02';
  const at = Date.UTC(2026, 8, 19, 14, 2);
  const done = (patch: Partial<SessionMeta>) =>
    recentRow(session({ startedAt: at, durationMs: 32 * 60_000, route: 'team', ...patch }), NOW, FMT);

  it('answers "did it reach Notion?" with a way to open it', () => {
    expect(done({ status: 'saved', meetingTitle: 'Weekly product sync', notion: { pageId: 'p', url: 'https://n/p' } })).toEqual({
      id: session().id,
      tone: 'done',
      title: 'Weekly product sync',
      isCode: false,
      status: 'Saved to Notion',
      notionUrl: 'https://n/p',
      details: [TODAY, '32 min', 'Team'],
    });
    expect(done({ status: 'duplicate', notion: { pageId: 'p', url: 'https://n/p', recordedBy: 'Marie' } })).toEqual({
      id: session().id,
      tone: 'done',
      title: 'abc-defg-hij',
      isCode: true,
      status: 'Saved by Marie',
      notionUrl: 'https://n/p',
      details: [TODAY, '32 min'],
    });
    expect(done({ status: 'saved' })).not.toHaveProperty('notionUrl');
  });

  it('always has a status word, first on the second line (the glossary words)', () => {
    expect(done({ status: 'awaiting-route', route: undefined })).toMatchObject({
      tone: 'caution',
      status: 'Choose Team or Personal',
      details: [TODAY, '32 min'],
    });
    expect(done({ status: 'processed' })).toMatchObject({
      tone: 'caution',
      status: 'Transcribed, not saved yet',
      details: [TODAY, '32 min', 'Team'],
    });
    expect(done({ status: 'ready' })).toMatchObject({ tone: 'neutral', status: 'Not transcribed' });
    expect(done({ status: 'empty' })).toMatchObject({ tone: 'none', status: 'Nothing to save', details: [TODAY, '32 min'] });
    expect(done({ status: 'recording' })).toMatchObject({ tone: 'live', status: 'Recording', details: [TODAY] });
    expect(done({ status: 'failed', error: 'Gemini is unavailable (503).' })).toMatchObject({
      tone: 'caution',
      status: 'Couldn’t transcribe',
    });
    expect(done({ status: 'failed', error: 'Notion rejected the token.' }).status).toBe('Couldn’t save to Notion');
  });

  it('puts the step or the retry before when: what drops out first when the line is full is the least useful', () => {
    expect(done({ status: 'processing', stage: 'transcribing-text' })).toMatchObject({
      tone: 'working',
      status: 'Transcribing',
      details: ['Step 4 of 8', TODAY],
    });
    expect(done({ status: 'processing' })).toMatchObject({ status: 'Starting', details: ['Step 1 of 8', TODAY] });
    expect(done({ status: 'saving' })).toMatchObject({ status: 'Saving to Notion', details: ['Step 8 of 8', TODAY] });
    expect(done({ status: 'failed', retryAt: Date.UTC(2026, 8, 19, 16, 37) }).details).toEqual(['Trying again at 16:37', TODAY]);
  });

  it('dates older meetings like the other surfaces, and leaves out what it doesn’t know', () => {
    const old = recentRow(session({ status: 'ready', startedAt: Date.UTC(2026, 8, 16, 16, 42), route: undefined }), NOW, FMT);
    expect(old.details).toEqual(['Wed\u00a016\u00a0Sep\u00a016:42']);
  });
});

describe('meetingsLabel', () => {
  it('adds how many meetings need you', () => {
    expect(meetingsLabel(0)).toBe('Meetings');
    expect(meetingsLabel(1)).toBe('Meetings · 1 needs you');
    expect(meetingsLabel(3)).toBe('Meetings · 3 need you');
  });
});
