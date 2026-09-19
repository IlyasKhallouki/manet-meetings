/**
 * What the toolbar button shows: the icon (idle, or the red recording dot), the badge
 * and the tooltip.
 *
 * - Recording: the recording icon, no badge. A recording with a problem (no call audio,
 *   audio that stopped arriving, no captions, captions gone quiet) adds an amber "!". What
 *   counts as a problem is recordingHealth's call, the rules the popup and Meetings follow,
 *   so the "!" never shows without the popup saying why (and never stays away when it does).
 * - Idle: an amber count of the meetings that need you, or nothing.
 *
 * Red stays on the icon's dot, which means "recording now"; the badge is never red. The
 * badge is never the only signal: the popup says the same thing in words (HIG
 * notifications.md › Badging). Tooltips never name the meeting, so they are safe to
 * show while sharing a screen.
 */
import { recordingHealth, type HealthInput } from '@lib/recordingHealth';
import { needsYou } from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';
import { clockTime } from './copy';

export type RecordingProblem =
  /** The call audio is lost; only captions are recorded. */
  | { kind: 'captions-only' }
  /** No audio chunk since `since` (epoch ms), though the recorder was not declared dead. */
  | { kind: 'audio-stalled'; since: number }
  /** No caption 20 s into the recording, or the tab can't deliver them. */
  | { kind: 'no-captions' }
  /** The last caption was at `since` (epoch ms), more than 5 min ago. */
  | { kind: 'captions-quiet'; since: number };

export type ActionState =
  | { kind: 'idle'; needsYou: number; shortcut: string | null }
  | { kind: 'recording'; since: number; problem: RecordingProblem | null };

export const ICONS = {
  idle: { 16: '/icon/16.png', 32: '/icon/32.png' },
  recording: { 16: '/icon/rec-16.png', 32: '/icon/rec-32.png' },
} as const;

/** Amber with near-black text (8.52:1); readable on light and dark toolbars. */
export const BADGE_COLORS = { background: '#F9AB00', color: '#1F1F1F' } as const;

export interface ActionPresentation {
  icon: { 16: string; 32: string };
  badge: { text: string; background: string; color: string };
  title: string;
}

/**
 * The most serious of recordingHealth's problems, or null: lost audio, then stalled audio,
 * then captions. The badge has room for one "!"; the tooltip names that one.
 */
export function recordingProblem(meta: HealthInput, now: number): RecordingProblem | null {
  const { audio, captions } = recordingHealth(meta, now);
  if (audio?.kind === 'lost') return { kind: 'captions-only' };
  if (audio?.kind === 'stalled') return { kind: 'audio-stalled', since: now - audio.silentMs };
  if (captions?.kind === 'blocked' || captions?.kind === 'none-yet') return { kind: 'no-captions' };
  if (captions?.kind === 'quiet') return { kind: 'captions-quiet', since: now - captions.quietMs };
  return null;
}

export interface ActionInputs {
  /** The session being recorded now, if any. */
  recording: SessionMeta | null;
  /** Every session; only read when nothing records. */
  sessions: readonly SessionMeta[];
  now: number;
  /** The keyboard shortcut as Chrome shows it, or null when unset. */
  shortcut: string | null;
}

export function actionStateFor({ recording, sessions, now, shortcut }: ActionInputs): ActionState {
  if (recording) return { kind: 'recording', since: recording.startedAt, problem: recordingProblem(recording, now) };
  return { kind: 'idle', needsYou: sessions.filter(needsYou).length, shortcut };
}

function problemTitle(problem: RecordingProblem, locale?: string): string {
  switch (problem.kind) {
    case 'captions-only':
      return 'Recording captions only — no call audio';
    case 'audio-stalled':
      return `Recording — no call audio since ${clockTime(problem.since, locale)}`;
    case 'no-captions':
      return 'Recording — no captions yet';
    case 'captions-quiet':
      return `Recording — no captions since ${clockTime(problem.since, locale)}`;
  }
}

function idleTitle(needsYouCount: number, shortcut: string | null): string {
  const record = `Manet Meetings: record this call${shortcut ? ` (${shortcut})` : ''}`;
  if (needsYouCount === 0) return record;
  const count = needsYouCount === 1 ? '1 meeting needs you' : `${needsYouCount} meetings need you`;
  return `${record} · ${count}`;
}

/** `locale` picks the hour cycle of times in the tooltip; for tests. */
export function presentAction(state: ActionState, locale?: string): ActionPresentation {
  if (state.kind === 'recording') {
    return {
      icon: ICONS.recording,
      badge: { text: state.problem ? '!' : '', ...BADGE_COLORS },
      title: state.problem ? problemTitle(state.problem, locale) : `Recording since ${clockTime(state.since, locale)}`,
    };
  }
  const n = state.needsYou;
  return {
    icon: ICONS.idle,
    badge: { text: n === 0 ? '' : n > 99 ? '99+' : String(n), ...BADGE_COLORS },
    title: idleTitle(n, state.shortcut),
  };
}
