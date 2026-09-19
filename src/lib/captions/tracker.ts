/**
 * Turns Meet's churning caption DOM into CaptionSegment revisions, without touching
 * the DOM itself: callers pass an opaque key per caption block (the block element)
 * and what it currently reads.
 *
 * Meet refines a block's text in place, so one block = one segment whose `rev`
 * grows. Meet also re-renders blocks as new nodes (region replaced after a CC
 * toggle or layout change, or a fresh copy of the active block); a new node whose
 * text continues a just-removed block, or the most recent block, keeps that
 * segment's id so consumers see one segment instead of duplicates. A block that
 * another still-visible block started after is never taken over: that is a new turn.
 */
import { normalizeToken, splitWords } from '../align/sequence';
import type { CaptionSegment } from '../types';

export interface BlockReading {
  speaker: string;
  text: string;
  self: boolean;
}

export interface CaptionTrackerOptions {
  /** Id prefix. Must differ between trackers of one session; random by default. */
  idPrefix?: string;
  /** How long after a block's last activity a new node may still continue it. */
  continuationWindowMs?: number;
  /**
   * A drop of at least this many characters within one node, to text that does not
   * continue the old one, means Meet restarted a very long block: the old text is
   * kept as its own segment instead of being overwritten.
   */
  resetDropChars?: number;
}

interface Entry<K> {
  seg: CaptionSegment;
  /** Live node currently feeding this segment, or null once finalized. */
  key: K | null;
  /** Creation order, for stable sorting. */
  order: number;
  /** Last text change or removal, for the continuation window. */
  lastActive: number;
}

const DEFAULT_WINDOW_MS = 3000;
/** Also used by the watcher for blocks that predate the recording. */
export const DEFAULT_RESET_DROP = 250;
/** Share of the old block's leading words a new text must repeat to count as its continuation. */
const CONTINUATION_SHARE = 0.6;
/**
 * A finalized block shorter than this ("Oui.", "OK so") is only continued by an exact
 * repeat: a new turn that merely starts with the same word is not a re-render of it.
 */
const MIN_PARTIAL_WORDS = 3;

export class CaptionTracker<K = unknown> {
  private readonly prefix: string;
  private readonly windowMs: number;
  private readonly resetDrop: number;
  private readonly entries = new Map<string, Entry<K>>();
  private readonly byKey = new Map<K, string>();
  /** Nodes whose segment was taken over by a newer copy; their late edits are stale. */
  private readonly retired = new Set<K>();
  private readonly changed = new Set<string>();
  private lastTouched: string | null = null;
  private counter = 0;

  constructor(options: CaptionTrackerOptions = {}) {
    this.prefix =
      options.idPrefix ?? `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.windowMs = options.continuationWindowMs ?? DEFAULT_WINDOW_MS;
    this.resetDrop = options.resetDropChars ?? DEFAULT_RESET_DROP;
  }

  /** Number of nodes currently feeding a segment. */
  get liveCount(): number {
    return this.byKey.size;
  }

  liveKeys(): K[] {
    return [...this.byKey.keys()];
  }

  /** Every node still referenced (live and superseded copies); remove() the ones that are gone. */
  heldKeys(): K[] {
    return [...this.byKey.keys(), ...this.retired];
  }

  /** Records what the block `key` reads at `t` (ms from recording start). */
  update(key: K, reading: BlockReading, t: number): void {
    if (this.retired.has(key)) return;
    const text = cleanText(reading.text);
    if (!text) return;
    const speaker = cleanText(reading.speaker);
    const now = clampTime(t);

    const id = this.byKey.get(key);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (entry) {
      if (entry.seg.speaker !== speaker) {
        // Meet reused the node for someone else.
        this.detach(key, now);
      } else if (entry.seg.text === text) {
        return;
      } else if (this.isRestart(entry.seg.text, text)) {
        this.detach(key, now);
        this.create(key, speaker, reading.self, text, now);
        return;
      } else {
        this.revise(entry, text, now);
        return;
      }
    }

    const candidate = this.findContinuation(speaker, text, now);
    if (!candidate) {
      this.create(key, speaker, reading.self, text, now);
      return;
    }
    if (candidate.key !== null) {
      this.byKey.delete(candidate.key);
      this.retired.add(candidate.key);
    }
    candidate.key = key;
    this.byKey.set(key, candidate.seg.id);
    if (candidate.seg.text !== text) this.revise(candidate, text, now);
    else candidate.lastActive = Math.max(candidate.lastActive, now);
  }

  /** The block left the DOM: its segment is final unless a re-render continues it. */
  remove(key: K, t: number): void {
    if (this.retired.delete(key)) return;
    this.detach(key, clampTime(t));
  }

  /** Every tracked block is gone at once (Meet replaced the whole caption region). */
  removeAll(t: number): void {
    const now = clampTime(t);
    for (const key of [...this.byKey.keys()]) this.detach(key, now);
    this.retired.clear();
  }

  /**
   * Moves every segment by `deltaMs` (t = 0 was corrected) and bumps its rev, so
   * consumers that already hold a revision replace it.
   */
  shiftTimes(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs === 0) return;
    for (const entry of this.entries.values()) {
      const tStart = clampTime(entry.seg.tStart + deltaMs);
      const tEnd = Math.max(tStart, clampTime(entry.seg.tEnd + deltaMs));
      entry.seg = { ...entry.seg, tStart, tEnd, rev: entry.seg.rev + 1 };
      entry.lastActive = clampTime(entry.lastActive + deltaMs);
      this.changed.add(entry.seg.id);
    }
  }

  /** Latest revision of every segment changed since the last drain, ordered by tStart. */
  drainChanges(): CaptionSegment[] {
    const out = [...this.changed]
      .map((id) => this.entries.get(id))
      .filter((e): e is Entry<K> => e !== undefined);
    this.changed.clear();
    return sortEntries(out).map((e) => ({ ...e.seg }));
  }

  /** Latest revision of every segment seen, ordered by tStart. */
  segments(): CaptionSegment[] {
    return sortEntries([...this.entries.values()]).map((e) => ({ ...e.seg }));
  }

  private create(key: K, speaker: string, self: boolean, text: string, t: number): void {
    const order = ++this.counter;
    const id = `${this.prefix}-${order}`;
    const seg: CaptionSegment = { id, speaker, self, text, tStart: t, tEnd: t, rev: 0 };
    this.entries.set(id, { seg, key, order, lastActive: t });
    this.byKey.set(key, seg.id);
    this.changed.add(seg.id);
    this.lastTouched = seg.id;
  }

  private revise(entry: Entry<K>, text: string, t: number): void {
    entry.seg = { ...entry.seg, text, tEnd: Math.max(entry.seg.tStart, t), rev: entry.seg.rev + 1 };
    entry.lastActive = Math.max(entry.lastActive, t);
    this.changed.add(entry.seg.id);
    this.lastTouched = entry.seg.id;
  }

  private detach(key: K, t: number): void {
    const id = this.byKey.get(key);
    if (id === undefined) return;
    this.byKey.delete(key);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.key = null;
    entry.lastActive = Math.max(entry.lastActive, t);
  }

  private isRestart(oldText: string, newText: string): boolean {
    return oldText.length - newText.length >= this.resetDrop && !continues(oldText, newText);
  }

  /**
   * Candidates are finalized blocks active within the window (re-rendered region)
   * and the most recently touched block even if still live (Meet swapped in a fresh
   * copy before dropping the old one). A block that a still-live block started after
   * is not a candidate: someone spoke since, so the new node is a new turn. Finalized
   * short blocks need an exact repeat. An exact repeat of the text wins, earliest
   * block first so a re-rendered region maps back in order; otherwise the most
   * recently active continuation.
   */
  private findContinuation(speaker: string, text: string, t: number): Entry<K> | null {
    let newestLive = 0;
    for (const id of this.byKey.values()) newestLive = Math.max(newestLive, this.entries.get(id)?.order ?? 0);
    let exact: Entry<K> | null = null;
    let partial: Entry<K> | null = null;
    const norm = normalizeWords(text).join(' ');
    for (const entry of this.entries.values()) {
      if (entry.seg.speaker !== speaker) continue;
      if (t - entry.lastActive > this.windowMs) continue;
      if (entry.key !== null && entry.seg.id !== this.lastTouched) continue;
      if (entry.order < newestLive) continue;
      const words = normalizeWords(entry.seg.text);
      if (words.join(' ') === norm) {
        if (!exact || entry.order < exact.order) exact = entry;
      } else if ((entry.key !== null || words.length >= MIN_PARTIAL_WORDS) && continues(entry.seg.text, text)) {
        if (!partial || entry.lastActive > partial.lastActive) partial = entry;
      }
    }
    return exact ?? partial;
  }
}

/** True when `next` repeats most of the leading words of `prev` (extension or refinement). */
export function continues(prev: string, next: string): boolean {
  const a = normalizeWords(prev);
  const b = normalizeWords(next);
  if (a.length === 0 || b.length === 0) return false;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= Math.max(1, Math.ceil(a.length * CONTINUATION_SHARE));
}

function normalizeWords(text: string): string[] {
  return splitWords(text).map(normalizeToken).filter(Boolean);
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clampTime(t: number): number {
  return Number.isFinite(t) ? Math.max(0, Math.round(t)) : 0;
}

function sortEntries<K>(entries: Entry<K>[]): Entry<K>[] {
  return entries.sort((x, y) => x.seg.tStart - y.seg.tStart || x.order - y.order);
}
