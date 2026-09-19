import { describe, expect, it } from 'vitest';
import * as actionState from '@/entrypoints/background/actionState';
import {
  actionStateFor,
  BADGE_COLORS,
  ICONS,
  presentAction,
  recordingProblem,
  type ActionState,
} from '@/entrypoints/background/actionState';
import { problems } from '@/entrypoints/background/copy';
import {
  AUDIO_STALL_MS as STALL_MS,
  CAPTIONS_QUIET_WARN_MS as CAPTIONS_QUIET_MS,
  NO_CAPTIONS_AFTER_MS,
  recordingHealth,
} from '@lib/recordingHealth';
import type { SessionMeta, SpeakerInfo } from '@lib/types';

const START = Date.UTC(2026, 8, 19, 12, 2, 0);
const MINUTE = 60_000;

function meta(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 's1',
    meetCode: 'abc-defg-hij',
    startedAt: START,
    status: 'recording',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

function speaker(name: string, firstAt: number, lastAt: number): SpeakerInfo {
  return { name, self: false, firstAt, lastAt, talkMs: lastAt - firstAt };
}

/** A recording at `now` whose chunks and captions are fresh. */
function healthy(now: number, patch: Partial<SessionMeta> = {}): SessionMeta {
  return meta({
    audio: { mimeType: 'audio/webm', chunkCount: 3, bytes: 3000, micIncluded: true, lastChunkAt: now - 2000 },
    captionCount: 4,
    speakers: [speaker('Marie Curie', 1000, now - START - 3000)],
    ...patch,
  });
}

describe('recordingProblem', () => {
  it('finds nothing wrong while chunks and captions arrive', () => {
    const now = START + 10 * MINUTE;
    expect(recordingProblem(healthy(now), now)).toBeNull();
  });

  it('gives nobody-named 20 s before calling missing captions a problem', () => {
    const fresh = meta({ audio: { ...meta().audio, lastChunkAt: START + 18_000 } });
    expect(recordingProblem(fresh, START + NO_CAPTIONS_AFTER_MS - 1)).toBeNull();
    expect(recordingProblem(fresh, START + NO_CAPTIONS_AFTER_MS)).toEqual({ kind: 'no-captions' });
  });

  it('reports captions that cannot reach the extension at once', () => {
    const blocked = meta({ captionsError: problems.captionsMissing });
    expect(recordingProblem(blocked, START + 1000)).toEqual({ kind: 'no-captions' });
  });

  it('reports captions gone quiet for more than 5 min while audio flows', () => {
    const now = START + 20 * MINUTE;
    const lastAt = 20 * MINUTE - CAPTIONS_QUIET_MS - 1000;
    const quiet = healthy(now, { speakers: [speaker('Marie Curie', 1000, 2000), speaker('Tom Martin', 3000, lastAt)] });
    expect(recordingProblem(quiet, now)).toEqual({ kind: 'captions-quiet', since: START + lastAt });
    const recent = healthy(now, { speakers: [speaker('Tom Martin', 3000, 20 * MINUTE - CAPTIONS_QUIET_MS + 1000)] });
    expect(recordingProblem(recent, now)).toBeNull();
  });

  it('reports audio that stopped arriving, from the last chunk (or the start)', () => {
    const now = START + 10 * MINUTE;
    const lastChunkAt = now - STALL_MS - 1;
    const stalled = healthy(now, { audio: { ...healthy(now).audio, lastChunkAt } });
    expect(recordingProblem(stalled, now)).toEqual({ kind: 'audio-stalled', since: lastChunkAt });
    const neverStarted = meta({ captionCount: 2, speakers: [speaker('Marie', 0, 15_000)] });
    expect(recordingProblem(neverStarted, START + 16_000)).toEqual({ kind: 'audio-stalled', since: START });
  });

  it('puts lost audio before stalled audio, and audio before captions', () => {
    const now = START + 10 * MINUTE;
    const everything = meta({ audio: { ...meta().audio, error: 'Tab audio capture failed', lastChunkAt: START } });
    expect(recordingProblem(everything, now)).toEqual({ kind: 'captions-only' });
    const stalledNoCaptions = meta({ audio: { ...meta().audio, lastChunkAt: START } });
    expect(recordingProblem(stalledNoCaptions, now)).toMatchObject({ kind: 'audio-stalled' });
  });

  it('does not call captions quiet in a captions-only recording: losing the audio is the problem', () => {
    const now = START + 30 * MINUTE;
    const captionsOnly = healthy(now, {
      audio: { ...healthy(now).audio, error: 'Recording stopped' },
      speakers: [speaker('Marie', 0, 1000)],
    });
    expect(recordingProblem(captionsOnly, now)).toEqual({ kind: 'captions-only' });
  });

  it('follows recordingHealth, the rules the popup and Meetings use: "!" exactly when it finds a problem', () => {
    for (const name of ['NO_CAPTIONS_AFTER_MS', 'CAPTIONS_QUIET_MS', 'AUDIO_STALL_MS']) {
      expect(actionState, name).not.toHaveProperty(name);
    }
    const now = START + 10 * MINUTE;
    const cases: SessionMeta[] = [
      healthy(now),
      healthy(now, { speakers: [speaker('Tom', 0, 10 * MINUTE - 3 * MINUTE)] }),
      healthy(now, { speakers: [speaker('Tom', 0, 10 * MINUTE - 6 * MINUTE)] }),
      healthy(now, { captionCount: 0, speakers: [] }),
      healthy(now, { speakers: [] }),
      healthy(now, { captionsError: problems.captionsMissing }),
      healthy(now, { audio: { ...healthy(now).audio, error: 'Tab audio capture failed' } }),
      healthy(now, { audio: { ...healthy(now).audio, lastChunkAt: now - STALL_MS - 1 } }),
      healthy(now, { audio: { ...healthy(now).audio, lastChunkAt: now - STALL_MS } }),
    ];
    for (const meta of cases) {
      const health = recordingHealth(meta, now);
      const problem = recordingProblem(meta, now);
      expect(problem !== null, JSON.stringify(meta)).toBe(health.audio !== null || health.captions !== null);
      if (health.audio) expect(problem?.kind).toBe(health.audio.kind === 'lost' ? 'captions-only' : 'audio-stalled');
    }
  });
});

describe('actionStateFor', () => {
  const sessions = [
    meta({ id: 'a', status: 'awaiting-route' }),
    meta({ id: 'b', status: 'processed' }),
    meta({ id: 'c', status: 'failed' }),
    meta({ id: 'd', status: 'failed', retryAt: START + MINUTE }),
    meta({ id: 'e', status: 'saved' }),
    meta({ id: 'f', status: 'ready' }),
  ];

  it('counts the meetings that need you when nothing is recording', () => {
    expect(actionStateFor({ recording: null, sessions, now: START, shortcut: 'Alt+Shift+R' })).toEqual({
      kind: 'idle',
      needsYou: 3,
      shortcut: 'Alt+Shift+R',
    });
  });

  it('shows the recording instead of the count while one runs', () => {
    const now = START + MINUTE;
    const state = actionStateFor({ recording: healthy(now), sessions, now, shortcut: null });
    expect(state).toEqual({ kind: 'recording', since: START, problem: null });
  });
});

describe('presentAction', () => {
  const at = (hh: number, mm: number) => new Date(2026, 8, 19, hh, mm).getTime();

  it('shows the idle icon, no badge and how to record when nothing needs you', () => {
    expect(presentAction({ kind: 'idle', needsYou: 0, shortcut: 'Alt+Shift+R' }, 'en-GB')).toEqual({
      icon: ICONS.idle,
      badge: { text: '', ...BADGE_COLORS },
      title: 'Manet Meetings: record this call (Alt+Shift+R)',
    });
    expect(presentAction({ kind: 'idle', needsYou: 0, shortcut: null }, 'en-GB').title).toBe(
      'Manet Meetings: record this call',
    );
  });

  it('counts the meetings that need you on an amber badge, and says so in the tooltip', () => {
    const one = presentAction({ kind: 'idle', needsYou: 1, shortcut: 'Alt+Shift+R' }, 'en-GB');
    expect(one.badge).toEqual({ text: '1', background: '#F9AB00', color: '#1F1F1F' });
    expect(one.title).toBe('Manet Meetings: record this call (Alt+Shift+R) · 1 meeting needs you');
    expect(presentAction({ kind: 'idle', needsYou: 3, shortcut: null }, 'en-GB').title).toBe(
      'Manet Meetings: record this call · 3 meetings need you',
    );
    expect(presentAction({ kind: 'idle', needsYou: 140, shortcut: null }, 'en-GB').badge.text).toBe('99+');
  });

  it('switches to the recording icon with no badge while a recording is healthy', () => {
    const state: ActionState = { kind: 'recording', since: at(14, 2), problem: null };
    expect(presentAction(state, 'en-GB')).toEqual({
      icon: ICONS.recording,
      badge: { text: '', ...BADGE_COLORS },
      title: 'Recording since 14:02',
    });
  });

  it('adds the "!" badge and names the problem, never the meeting', () => {
    const since = at(14, 2);
    const problems: [ActionState, string][] = [
      [{ kind: 'recording', since, problem: { kind: 'captions-only' } }, 'Recording captions only — no call audio'],
      [{ kind: 'recording', since, problem: { kind: 'no-captions' } }, 'Recording — no captions yet'],
      [
        { kind: 'recording', since, problem: { kind: 'audio-stalled', since: at(14, 5) } },
        'Recording — no call audio since 14:05',
      ],
      [
        { kind: 'recording', since, problem: { kind: 'captions-quiet', since: at(14, 10) } },
        'Recording — no captions since 14:10',
      ],
    ];
    for (const [state, title] of problems) {
      expect(presentAction(state, 'en-GB')).toEqual({
        icon: ICONS.recording,
        badge: { text: '!', background: '#F9AB00', color: '#1F1F1F' },
        title,
      });
    }
  });

  it('uses a 12-hour clock where the browser locale does', () => {
    expect(presentAction({ kind: 'recording', since: at(14, 2), problem: null }, 'en-US').title).toBe(
      'Recording since 2:02 PM',
    );
  });

  it('points at the toolbar icon files', () => {
    expect(ICONS).toEqual({
      idle: { 16: '/icon/16.png', 32: '/icon/32.png' },
      recording: { 16: '/icon/rec-16.png', 32: '/icon/rec-32.png' },
    });
  });
});
