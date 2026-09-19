/**
 * Merges what was said (Gemini words) with who said it (Meet captions) into a
 * speaker-labelled transcript, degrading gracefully when either side is missing.
 * Where the audio cannot have the speech (the recorder's own voice without their
 * mic, a failed transcription part, audio that ended early), the caption text
 * itself fills in (see fill.ts).
 */
import { normalizeToken } from '../align/sequence';
import type { CaptionSegment, MeetingTranscript, TimedWord, TranscriptTurn } from '../types';
import { formatClock } from '../util/time';
import { assignSpeakers, type Lags } from './assign';
import {
  fillNotes,
  formatRanges,
  inUncoveredTime,
  mayBeHeard,
  touchesUncoveredTime,
  uncoveredRanges,
  unheardFills,
  wholeFill,
  type CaptionFill,
  type TimeRange,
} from './fill';
import { estimateLags, estimateLagsFromTiming, type LagEstimate } from './lag';
import {
  DEFAULT_CAPTION_LAG_MS,
  latestRevisions,
  prepareSegments,
  speakerLabel,
  UNKNOWN_SPEAKER,
  type Segment,
} from './segments';
import { buildTurns, tidyText, type LabeledWord } from './turns';
import { alignUntimed } from './untimed';

export { DEFAULT_CAPTION_LAG_MS, UNKNOWN_SPEAKER };
export type { TimeRange };

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
  /**
   * Whether the recorder's mic is in the recording (SessionMeta.audio.micIncluded).
   * Default true. When false, the audio cannot contain the recorder's own speech, so
   * their caption blocks are kept as caption text and never label audio words.
   */
  micIncluded?: boolean;
  /**
   * Ranges (ms from recording start) with no audio transcription, such as a failed
   * part (TranscriptionResult.gaps). Captions there become caption-text turns.
   */
  gaps?: readonly TimeRange[];
  /**
   * Where the recorded audio ends (ms from recording start), when the recorder
   * stopped before the meeting did. Captions after it become caption-text turns.
   */
  audioEndMs?: number;
}

/** Without speakers, a pause this long starts a new paragraph. */
const AUDIO_ONLY_PAUSE_MS = 1500;
/** Below this share of matched words, speakers from the untimed fallback are a guess. */
const ROUGH_MATCH_RATIO = 0.3;

const NOTES = {
  noCaptions: 'Meet captions were not captured, so speakers are not identified.',
  textAligned:
    'Word timings were unavailable, so speakers were assigned by matching the transcript to caption text; ' +
    'times are approximate.',
  rough: 'Few transcript words matched the captions, so speaker labels are rough.',
  untimedOnly: 'Word timings and captions were unavailable, so the transcript has no speakers or times.',
  untimedUnmatched: 'Word timings were unavailable, so the audio transcript has no speakers or times.',
  captionsOnly:
    'No audio transcript was available; the text comes from Meet captions and may contain recognition errors.',
  nothing: 'Nothing was captured: no audio transcript and no captions.',
} as const;

export function mergeTranscript(input: MergeInput): MeetingTranscript {
  const notes = [...(input.notes ?? [])];
  const segments = prepareSegments(input.captions, input.selfName);
  const words = cleanWords(input.words);
  const micIncluded = input.micIncluded ?? true;
  // Without the mic, the audio has none of the recorder's speech: their blocks can only mislabel words.
  const inAudio = micIncluded ? segments : segments.filter((seg) => !seg.self);

  if (words.length > 0) {
    if (segments.length === 0) {
      notes.push(NOTES.noCaptions);
      const unlabeled = words.map((w) => ({ ...w, speaker: UNKNOWN_SPEAKER }));
      return { turns: buildTurns(unlabeled, AUDIO_ONLY_PAUSE_MS), source: 'audio-only', notes };
    }
    const norm = words.map((w) => normalizeToken(w.text));
    const uncovered = uncoveredRanges(input.gaps, input.audioEndMs, words);
    const lags = resolveLags(input.captionLagMs, () => {
      const probe = inAudio.filter((seg) => mayBeHeard(seg, uncovered));
      const byText = estimateLags(words, probe, norm);
      return byText.start === null && byText.end === null ? estimateLagsFromTiming(words, probe) : byText;
    });
    const { labels, quality } = assignSpeakers(words, norm, inAudio, lags);
    const fills = [
      ...selfFills(segments, micIncluded, lags),
      ...unheardFills({ words, norm }, inAudio, quality, lags, uncovered),
    ];
    const labeled = words.map((w, i) => ({ ...w, speaker: labels[i] ?? UNKNOWN_SPEAKER }));
    const turns = buildTurns(inReadingOrder(labeled, fills));
    const unknown = unknownNote(turns);
    if (unknown) notes.push(unknown);
    notes.push(...fillNotes(fills, words, input.selfName));
    return { turns, source: 'audio+captions', notes };
  }

  const text = input.text?.trim() ?? '';
  if (text) {
    const lags = resolveLags(input.captionLagMs);
    const uncovered = uncoveredRanges(input.gaps, input.audioEndMs);
    // Keep the transcript off blocks it cannot contain, so they neither pull words nor lose their text.
    const fills = selfFills(segments, micIncluded, lags);
    const audible: Segment[] = [];
    for (const seg of inAudio) {
      if (inUncoveredTime(seg, lags, uncovered)) fills.push(wholeFill(seg, lags, 'gap'));
      else audible.push(seg);
    }
    const aligned = alignUntimed(text, audible, lags);
    if (aligned) {
      // A block at an uncovered edge that received no transcript word was not heard.
      audible.forEach((seg, k) => {
        if (aligned.perSegment[k] === 0 && seg.tokens.length > 0 && touchesUncoveredTime(seg, lags, uncovered)) {
          fills.push(wholeFill(seg, lags, 'gap'));
        }
      });
      notes.push(NOTES.textAligned);
      if (aligned.matchedRatio < ROUGH_MATCH_RATIO) notes.push(NOTES.rough);
      notes.push(...fillNotes(fills, aligned.words, input.selfName));
      return { turns: buildTurns(inReadingOrder(aligned.words, fills)), source: 'audio+captions', notes };
    }
    notes.push(segments.length > 0 ? NOTES.untimedUnmatched : NOTES.untimedOnly);
    const paragraphs = text
      .split(/\n+/)
      .map(tidyText)
      .filter(Boolean)
      .map((p): TranscriptTurn => ({ speaker: UNKNOWN_SPEAKER, start: 0, end: 0, text: p }));
    notes.push(...fillNotes(fills, [], input.selfName));
    return { turns: [...paragraphs, ...buildTurns(fills)], source: 'audio-only', notes };
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

/** The recorder's blocks as caption text when the recording has no mic. */
function selfFills(segments: readonly Segment[], micIncluded: boolean, lags: Lags): CaptionFill[] {
  return micIncluded ? [] : segments.filter((seg) => seg.self).map((seg) => wholeFill(seg, lags, 'mic'));
}

/** Words and caption fills by start; words first on ties. */
function inReadingOrder(words: readonly LabeledWord[], fills: readonly LabeledWord[]): LabeledWord[] {
  if (fills.length === 0) return [...words];
  return [...words, ...fills].sort((x, y) => x.start - y.start);
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
  return `Speaker unknown for ${formatRanges(ranges)} (no captions at the time).`;
}
