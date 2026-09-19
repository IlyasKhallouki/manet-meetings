/**
 * What the pages show for a session: status wording and tone, which actions are
 * available, and formatted row fields. Pure, so the rules can be tested without a DOM.
 *
 * The action rules mirror what the background accepts (sessionManager.ts): Transcribe
 * from awaiting-route, ready, failed or processed; Save from processed, or failed with a
 * stored result; a route change from awaiting-route, ready, failed or processed.
 */
import type { JobStage, Route, SessionMeta, SessionStatus } from '../types';
import { formatBytes, formatDuration } from '../util/time';

export type SessionAction = 'stop' | 'transcribe' | 'save' | 'delete';

export interface ActionView {
  /** Worth showing for this status (possibly disabled). */
  visible: boolean;
  enabled: boolean;
  label: string;
  /** The obvious next step; at most one per session. */
  primary: boolean;
  /** Why a visible action is disabled. */
  hint?: string;
}

export type StatusTone = 'recording' | 'waiting' | 'busy' | 'done' | 'error';

export interface StatusView {
  label: string;
  tone: StatusTone;
  /** Stage while processing, "captions only" while recording without audio. */
  detail?: string;
}

const TRANSCRIBABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'failed', 'processed']);
const ROUTABLE = new Set<SessionStatus>(['awaiting-route', 'ready', 'processed', 'failed']);
const BUSY = new Set<SessionStatus>(['processing', 'saving']);

const STAGE_LABELS: Record<JobStage, string> = {
  'checking-duplicate': 'Checking Notion for duplicates',
  'loading-audio': 'Loading audio',
  'transcribing-timing': 'Transcribing (timing pass)',
  'transcribing-text': 'Transcribing (text pass)',
  aligning: 'Aligning words',
  merging: 'Matching speakers',
  summarizing: 'Summarizing',
  saving: 'Saving to Notion',
};

const STATUS: Record<SessionStatus, { label: string; tone: StatusTone }> = {
  recording: { label: 'Recording', tone: 'recording' },
  'awaiting-route': { label: 'Choose a destination', tone: 'waiting' },
  ready: { label: 'Ready to transcribe', tone: 'waiting' },
  processing: { label: 'Processing', tone: 'busy' },
  processed: { label: 'Transcribed, not saved', tone: 'waiting' },
  saving: { label: 'Saving to Notion', tone: 'busy' },
  saved: { label: 'Saved', tone: 'done' },
  duplicate: { label: 'Already in Notion', tone: 'done' },
  failed: { label: 'Failed', tone: 'error' },
};

/** Newest recording first, ties by id descending (the order listSessions returns). */
export function compareSessions(a: SessionMeta, b: SessionMeta): number {
  return b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function stageLabel(stage: JobStage): string {
  return STAGE_LABELS[stage];
}

export function statusView(meta: SessionMeta): StatusView {
  const base = STATUS[meta.status];
  if (meta.status === 'processing') return { ...base, detail: meta.stage ? stageLabel(meta.stage) : 'Starting' };
  if (meta.status === 'recording' && meta.audio.error) return { ...base, detail: 'captions only' };
  return { ...base };
}

export function canChooseRoute(meta: SessionMeta): boolean {
  return ROUTABLE.has(meta.status);
}

export function routeLabel(route: Route | undefined): string {
  if (route === 'team') return 'Team';
  if (route === 'personal') return 'Personal';
  return 'Not chosen';
}

/**
 * `hasResult`: a transcript is stored for the session (Save needs one).
 * `pending`: this page is waiting on a request for the session, so nothing else may start.
 */
export function sessionActions(
  meta: SessionMeta,
  ctx: { hasResult: boolean; pending?: boolean },
): Record<SessionAction, ActionView> {
  const { status } = meta;
  const busy = BUSY.has(status);
  const canSave = (status === 'processed' || status === 'failed') && ctx.hasResult;
  const canTranscribe = TRANSCRIBABLE.has(status);
  const retrySave = status === 'failed' && ctx.hasResult;

  const view = (visible: boolean, allowed: boolean, label: string, primary: boolean, hint: string): ActionView => {
    const enabled = allowed && !ctx.pending;
    const out: ActionView = { visible, enabled, label, primary: primary && enabled };
    if (visible && !enabled) out.hint = ctx.pending ? 'Working…' : hint;
    return out;
  };

  let transcribeLabel = 'Transcribe';
  if (status === 'failed') transcribeLabel = ctx.hasResult ? 'Transcribe again' : 'Retry';
  else if (status === 'processed') transcribeLabel = 'Transcribe again';

  return {
    stop: view(status === 'recording', status === 'recording', 'Stop', true, 'Not recording.'),
    transcribe: view(
      canTranscribe || busy,
      canTranscribe,
      transcribeLabel,
      !canSave,
      busy ? 'A job is already running for this meeting.' : 'Not available now.',
    ),
    save: view(
      status === 'processed' || status === 'saving' || retrySave,
      canSave,
      retrySave ? 'Retry save' : 'Save to Notion',
      true,
      status === 'saving' ? 'Saving to Notion…' : 'Nothing to save yet: transcribe first.',
    ),
    delete: view(true, !busy, 'Delete', false, 'Wait for the running job to finish.'),
  };
}

export interface FormatOptions {
  /** Defaults to the browser's locale. */
  locale?: string;
  /** Defaults to the local zone. */
  timeZone?: string;
}

export function formatDateTime(epochMs: number, opts: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(opts.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: opts.timeZone,
  }).format(epochMs);
}

export interface SessionRowView {
  id: string;
  /** Meet's title, or the meet code. */
  title: string;
  meetCode: string;
  date: string;
  duration: string;
  audio: string;
  /** Why there is no (or partial) audio. */
  audioNote?: string;
  status: StatusView;
  route: string;
  recovered: boolean;
  error?: string;
  notion?: { url: string; label: string };
}

/** Audio bytes of a session: what is on disk when known, else the recorder's count. 0 once purged. */
export function audioBytesOf(meta: SessionMeta, onDisk?: number): number {
  if (meta.audio.deletedAt !== undefined) return 0;
  return onDisk ?? meta.audio.bytes;
}

function durationOf(meta: SessionMeta, now: number): number | undefined {
  if (meta.durationMs !== undefined) return meta.durationMs;
  if (meta.endedAt !== undefined) return meta.endedAt - meta.startedAt;
  if (meta.status === 'recording') return now - meta.startedAt;
  return undefined;
}

export function sessionRow(
  meta: SessionMeta,
  opts: FormatOptions & { now: number; audioBytes?: number },
): SessionRowView {
  const duration = durationOf(meta, opts.now);
  const bytes = audioBytesOf(meta, opts.audioBytes);
  let audio = bytes > 0 ? formatBytes(bytes) : 'None';
  if (meta.audio.deletedAt !== undefined) audio = 'Deleted';

  const row: SessionRowView = {
    id: meta.id,
    title: meta.meetingTitle?.trim() || meta.meetCode,
    meetCode: meta.meetCode,
    date: formatDateTime(meta.startedAt, opts),
    duration: duration === undefined ? '—' : formatDuration(duration),
    audio,
    status: statusView(meta),
    route: routeLabel(meta.route),
    recovered: meta.recovered === true,
  };
  if (meta.audio.error) row.audioNote = meta.audio.error;
  // An error from an earlier attempt is history once the meeting is in Notion.
  if (meta.error && meta.status !== 'saved' && meta.status !== 'duplicate') row.error = meta.error;
  if (meta.notion && (meta.status === 'saved' || meta.status === 'duplicate')) {
    row.notion = {
      url: meta.notion.url,
      label:
        meta.status === 'saved'
          ? 'Open in Notion'
          : `Already saved by ${meta.notion.recordedBy?.trim() || 'a teammate'}`,
    };
  }
  return row;
}

export interface StorageSummary {
  audioBytes: number;
  /** "3.0 KB in 2 recordings". */
  audio: string;
  /** "5.0 MB used of 100.0 MB available", when the browser gave an estimate. */
  usage?: string;
}

export function storageSummary(
  sessions: readonly SessionMeta[],
  onDisk: ReadonlyMap<string, number> | null,
  estimate: { usage: number; quota: number } | null,
): StorageSummary {
  let total = 0;
  let count = 0;
  for (const meta of sessions) {
    const bytes = audioBytesOf(meta, onDisk?.get(meta.id));
    if (bytes <= 0) continue;
    total += bytes;
    count++;
  }
  const out: StorageSummary = {
    audioBytes: total,
    audio: `${formatBytes(total)} in ${count} recording${count === 1 ? '' : 's'}`,
  };
  if (estimate) out.usage = `${formatBytes(estimate.usage)} used of ${formatBytes(estimate.quota)} available`;
  return out;
}
