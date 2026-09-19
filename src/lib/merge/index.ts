/**
 * Merges what was said (Gemini words) with who said it (Meet captions) into a
 * speaker-labelled transcript, degrading gracefully when either side is missing.
 */
import { normalizeToken } from '../align/sequence';
import type { CaptionSegment, MeetingTranscript, TimedWord, TranscriptTurn } from '../types';
import { formatClock } from '../util/time';
import { assignSpeakers, type Lags } from './assign';
import { estimateLags, estimateLagsFromTiming, type LagEstimate } from './lag';
import { DEFAULT_CAPTION_LAG_MS, latestRevisions, prepareSegments, speakerLabel, UNKNOWN_SPEAKER } from './segments';
import { buildTurns, tidyText, type LabeledWord } from './turns';
import { alignUntimed } from './untimed';

export { DEFAULT_CAPTION_LAG_MS, UNKNOWN_SPEAKER };

export interface MergeInput {
  /** Timed words (ms from recording start). Empty when the timing pass failed. */
  words: TimedWord[];
  /** Untimed transcript text, used only when `words` is empty. */
  text?: string;
  /** Latest revision per caption block. */
  captions: CaptionSegment[];
  /** Replaces Meet's label for the local user ("You"/"Vous"). */
  selfName: string;
  /**
   * How long captions trail speech. When omitted it is estimated from caption text,
   * else from where caption blocks start and end relative to pauses, else
   * DEFAULT_CAPTION_LAG_MS.
   */
  captionLagMs?: number;
  /** Notes from earlier stages; kept first. */
  notes?: string[];
}

/** Without speakers, a pause this long starts a new paragraph. */
const AUDIO_ONLY_PAUSE_MS = 1500;
/** Below this share of matched words, speakers from the untimed fallback are a guess. */
const ROUGH_MATCH_RATIO = 0.3;
const MAX_UNKNOWN_RANGES = 5;

const NOTES = {
  noCaptions: 'Meet captions were not captured, so speakers are not identified.',
  textAligned:
    'Word timings were unavailable, so speakers were assigned by matching the transcript to caption text; ' +
    'times are approximate.',
  rough: 'Few transcript words matched the captions, so speaker labels are rough.',
  untimedOnly: 'Word timings and captions were unavailable, so the transcript has no speakers or times.',
  captionsOnly:
    'No audio transcript was available; the text comes from Meet captions and may contain recognition errors.',
  nothing: 'Nothing was captured: no audio transcript and no captions.',
} as const;

export function mergeTranscript(input: MergeInput): MeetingTranscript {
  const notes = [...(input.notes ?? [])];
  const segments = prepareSegments(input.captions, input.selfName);
  const words = cleanWords(input.words);

  if (words.length > 0) {
    if (segments.length === 0) {
      notes.push(NOTES.noCaptions);
      const unlabeled = words.map((w) => ({ ...w, speaker: UNKNOWN_SPEAKER }));
      return { turns: buildTurns(unlabeled, AUDIO_ONLY_PAUSE_MS), source: 'audio-only', notes };
    }
    const norm = words.map((w) => normalizeToken(w.text));
    const lags = resolveLags(input.captionLagMs, () => {
      const byText = estimateLags(words, segments, norm);
      return byText.start === null && byText.end === null ? estimateLagsFromTiming(words, segments) : byText;
    });
    const labels = assignSpeakers(words, norm, segments, lags);
    const turns = buildTurns(words.map((w, i) => ({ ...w, speaker: labels[i] ?? UNKNOWN_SPEAKER })));
    const unknown = unknownNote(turns);
    if (unknown) notes.push(unknown);
    return { turns, source: 'audio+captions', notes };
  }

  const text = input.text?.trim() ?? '';
  if (text) {
    const aligned = alignUntimed(text, segments, resolveLags(input.captionLagMs));
    if (aligned) {
      notes.push(NOTES.textAligned);
      if (aligned.matchedRatio < ROUGH_MATCH_RATIO) notes.push(NOTES.rough);
      return { turns: buildTurns(aligned.words), source: 'audio+captions', notes };
    }
    notes.push(NOTES.untimedOnly);
    const turns = text
      .split(/\n+/)
      .map(tidyText)
      .filter(Boolean)
      .map((p): TranscriptTurn => ({ speaker: UNKNOWN_SPEAKER, start: 0, end: 0, text: p }));
    return { turns, source: 'audio-only', notes };
  }

  if (segments.length > 0) {
    const t = captionsToTranscript(input.captions, input.selfName, input.captionLagMs);
    return { ...t, notes: [...notes, NOTES.captionsOnly, ...t.notes] };
  }

  notes.push(NOTES.nothing);
  return { turns: [], source: 'captions-only', notes };
}

/** Unique speaker names in order of first appearance, self mapped to `selfName`. */
export function attendeesFrom(captions: CaptionSegment[], selfName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of latestRevisions(captions)) {
    const name = speakerLabel(c, selfName);
    const key = name.toLocaleLowerCase();
    if (name === UNKNOWN_SPEAKER || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** One "[hh:mm:ss] Speaker: text" line per turn. */
export function formatTranscript(t: MeetingTranscript): string {
  return t.turns.map((turn) => `[${formatClock(turn.start)}] ${turn.speaker}: ${turn.text}`).join('\n');
}

/**
 * Transcript from captions alone: consecutive blocks of one speaker become one turn
 * (split on long silences), times shifted back by the caption lag.
 */
export function captionsToTranscript(
  captions: CaptionSegment[],
  selfName: string,
  captionLagMs: number = DEFAULT_CAPTION_LAG_MS,
): MeetingTranscript {
  const blocks: LabeledWord[] = prepareSegments(captions, selfName).map((seg) => ({
    text: seg.text,
    speaker: seg.speaker,
    start: Math.max(0, seg.tStart - captionLagMs),
    end: Math.max(0, seg.tEnd - captionLagMs),
  }));
  return { turns: buildTurns(blocks), source: 'captions-only', notes: [] };
}

function resolveLags(explicit: number | undefined, estimate?: () => LagEstimate): Lags {
  if (explicit !== undefined && Number.isFinite(explicit)) return { start: explicit, end: explicit };
  const e = estimate?.() ?? { start: null, end: null };
  return {
    start: e.start ?? e.end ?? DEFAULT_CAPTION_LAG_MS,
    end: e.end ?? e.start ?? DEFAULT_CAPTION_LAG_MS,
  };
}

/** Non-empty words sorted by start; ties keep input order. */
function cleanWords(words: readonly TimedWord[]): TimedWord[] {
  return words
    .filter((w) => w.text.trim() !== '')
    .map((w) => ({ text: w.text.trim(), start: w.start, end: Math.max(w.start, w.end) }))
    .sort((x, y) => x.start - y.start);
}

function unknownNote(turns: readonly TranscriptTurn[]): string | null {
  const ranges: Array<[number, number]> = [];
  let lastIndex = -2;
  turns.forEach((turn, k) => {
    if (turn.speaker !== UNKNOWN_SPEAKER) return;
    const last = ranges.at(-1);
    if (last && lastIndex === k - 1) last[1] = Math.max(last[1], turn.end);
    else ranges.push([turn.start, turn.end]);
    lastIndex = k;
  });
  if (ranges.length === 0) return null;
  const shown = ranges.slice(0, MAX_UNKNOWN_RANGES).map(([a, b]) => `${formatClock(a)}–${formatClock(b)}`);
  const more = ranges.length > MAX_UNKNOWN_RANGES ? ` and ${ranges.length - MAX_UNKNOWN_RANGES} more` : '';
  return `Speaker unknown for ${shown.join(', ')}${more} (no captions at the time).`;
}
