import { describe, expect, it } from 'vitest';
import type { SessionMeta, SessionStatus, SpeakerInfo } from '@lib/types';
import {
  byline,
  CHOSEN_MS,
  ROUTE_COUNTDOWN_MS,
  routingMode,
  routingTitle,
  secondsLeft,
  shortDuration,
  speakerNames,
  windowHeightFor,
} from '@lib/ui/routingView';
import { formatLength, whenText } from '@lib/ui/sessionView';

const NBSP = '\u00a0';
const GB = { locale: 'en-GB', timeZone: 'UTC' } as const;
const US = { locale: 'en-US', timeZone: 'UTC' } as const;
/** Saturday 19 September 2026, 15:42 UTC. */
const NOW = Date.UTC(2026, 8, 19, 15, 42, 0);

function meta(status: SessionStatus, patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    meetCode: 'abc-defg-hij',
    startedAt: 0,
    status,
    idempotencyKey: 'abc-defg-hij-1970-01-01',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

function speaker(name: string, firstAt: number, self = false): SpeakerInfo {
  return { name, self, firstAt, lastAt: firstAt + 1000, talkMs: 1000 };
}

describe('secondsLeft', () => {
  it('rounds up and never goes negative', () => {
    expect(ROUTE_COUNTDOWN_MS).toBe(60_000);
    expect(secondsLeft(60_000, 0)).toBe(60);
    expect(secondsLeft(60_000, 1)).toBe(60);
    expect(secondsLeft(60_000, 59_001)).toBe(1);
    expect(secondsLeft(60_000, 60_000)).toBe(0);
    expect(secondsLeft(60_000, 90_000)).toBe(0);
  });
});

describe('routingMode', () => {
  it('asks while the session waits for a route', () => {
    expect(routingMode(meta('awaiting-route'))).toBe('choose');
  });

  it('lets the destination change where the background still accepts it', () => {
    for (const s of ['ready', 'failed', 'processed'] as const) expect(routingMode(meta(s)), s).toBe('change');
  });

  it('has nothing to ask once the meeting is being handled or gone', () => {
    for (const s of ['recording', 'processing', 'saving', 'saved', 'duplicate'] as const) {
      expect(routingMode(meta(s)), s).toBe('done');
    }
    expect(routingMode(null)).toBe('missing');
  });
});

describe('the byline', () => {
  it('names up to three speakers in order of first speech, self as "you"', () => {
    expect(speakerNames(undefined)).toBeNull();
    expect(speakerNames([])).toBeNull();
    expect(speakerNames([speaker('Marie Curie', 0), speaker('Ilyas', 5, true), speaker('Tom Martin', 9)])).toBe(
      'Marie Curie, you, Tom Martin',
    );
    expect(
      speakerNames([
        speaker('Marie Curie', 0),
        speaker('Tom Martin', 1),
        speaker('Ilyas', 2, true),
        speaker('Sofia', 3),
        speaker('Julien', 4),
      ]),
    ).toBe(`Marie Curie, Tom Martin, you +2${NBSP}more`);
  });

  it('writes durations as Meetings does, keeping number and unit together', () => {
    expect(shortDuration(40_000)).toBe(`40${NBSP}s`);
    expect(shortDuration(32 * 60_000 + 10_000)).toBe(`32${NBSP}min`);
    expect(shortDuration(59 * 60_000 + 40_000)).toBe(`1${NBSP}h`);
    expect(shortDuration(72 * 60_000)).toBe(`1${NBSP}h 12${NBSP}min`);
    for (const ms of [40_000, 32 * 60_000, 72 * 60_000]) expect(shortDuration(ms).replace(/\u00a0/g, ' ')).toBe(formatLength(ms));
  });

  it('dates the meeting with the same words and clock as Meetings and the popup', () => {
    const m = (startedAt: number) => meta('awaiting-route', { startedAt, durationMs: 32 * 60_000, speakers: [speaker('Marie', 0)] });
    const when = (at: number, fmt: { locale: string; timeZone: string }) => byline(m(at), NOW, fmt).split(' · ')[0];
    const days = [
      Date.UTC(2026, 8, 19, 14, 2), // today
      Date.UTC(2026, 8, 18, 16, 10), // yesterday
      Date.UTC(2026, 8, 16, 21, 5), // this week
      Date.UTC(2025, 11, 30, 9, 0), // last year
    ];
    for (const fmt of [GB, US, { locale: 'fr-FR', timeZone: 'UTC' }]) {
      for (const at of days) expect(when(at, fmt), `${fmt.locale} ${at}`).toBe(whenText(at, NOW, fmt));
    }
    expect(when(days[0]!, GB)).toBe(`Today${NBSP}14:02`);
    expect(when(days[1]!, GB)).toBe(`Yesterday${NBSP}16:10`);
    // Day before month in every locale, three-letter months (never ICU's "Sept"), one unbroken line.
    expect(when(days[2]!, GB)).toBe(['Wed', '16', 'Sep', '21:05'].join(NBSP));
    expect(when(days[2]!, US)).toMatch(/^Wed\u00a016\u00a0Sep\u00a09:05[\u00a0\u202f]PM$/);
    expect(when(days[3]!, GB)).toBe(['Tue', '30', 'Dec', '2025', '09:00'].join(NBSP));
  });

  it('joins when, how long and who; falls back to the Meet code without speakers', () => {
    const m = meta('awaiting-route', {
      meetingTitle: 'Weekly product sync',
      startedAt: Date.UTC(2026, 8, 19, 14, 2),
      durationMs: 32 * 60_000,
      speakers: [speaker('Marie Curie', 0), speaker('Tom Martin', 1), speaker('Ilyas', 2, true)],
    });
    expect(byline(m, NOW, GB)).toBe(`Today${NBSP}14:02 · 32${NBSP}min · Marie Curie, Tom Martin, you`);
    expect(byline({ ...m, speakers: undefined }, NOW, GB)).toBe(`Today${NBSP}14:02 · 32${NBSP}min · abc-defg-hij`);
    // The title already is the code: nothing to add.
    expect(byline({ ...m, speakers: [], meetingTitle: undefined }, NOW, GB)).toBe(`Today${NBSP}14:02 · 32${NBSP}min`);
    // No duration yet: derived from endedAt, else left out.
    expect(byline({ ...m, durationMs: undefined, endedAt: m.startedAt + 45 * 60_000 }, NOW, GB)).toContain(
      `45${NBSP}min`,
    );
    expect(byline({ ...m, durationMs: undefined, speakers: [] }, NOW, GB)).toBe(`Today${NBSP}14:02 · abc-defg-hij`);
  });
});

describe('the window', () => {
  it('is titled by its task, then the meeting', () => {
    expect(routingTitle(meta('awaiting-route', { meetingTitle: '  Weekly sync ' }))).toBe(
      'Choose Team or Personal: Weekly sync',
    );
    expect(routingTitle(meta('awaiting-route'))).toBe('Choose Team or Personal: abc-defg-hij');
    expect(routingTitle(null)).toBe('Choose Team or Personal');
  });

  it('fits its height to the content plus the frame Chrome draws around it', () => {
    // 380×280 outer with a 60 px frame leaves 220; content of 226.4 needs 287.
    expect(windowHeightFor(226.4, 280, 220)).toBe(287);
    expect(windowHeightFor(200, 280, 220)).toBe(260);
  });

  it('shows the confirmation for 400 ms before closing', () => {
    expect(CHOSEN_MS).toBe(400);
  });
});
