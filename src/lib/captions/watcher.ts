/**
 * Feeds a CaptionTracker from Meet's captions region through a MutationObserver.
 *
 * Meet edits caption text in place and adds/removes block nodes; it also recreates the
 * whole region when captions are toggled or the layout changes. The content script
 * calls sync() about once a second so the observer follows a recreated region; the
 * tracker's continuation rule keeps segment ids stable across such re-renders.
 */
import {
  captionBlockOf,
  findCaptionRegion,
  readCaptionBlock,
  readCaptionBlocks,
  type CaptionBlock,
} from '../meet/captionAdapter';
import type { CaptionTracker } from './tracker';

export interface CaptionWatcherOptions {
  doc: Document;
  tracker: CaptionTracker<Element>;
  /** Current time in ms from recording start. */
  now: () => number;
  /**
   * Blocks already on screen at the first sync() were spoken before recording started:
   * skip each one until its text changes, and skip their re-rendered copies too. A
   * region that only appears later holds post-start captions and is read in full.
   */
  skipExisting?: boolean;
  onError?: (err: unknown) => void;
}

const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true };

export class CaptionWatcher {
  private readonly opts: CaptionWatcherOptions;
  private region: Element | null = null;
  private readonly observer: MutationObserver;
  /** Pre-recording text per node, while unchanged. */
  private readonly baseline = new WeakMap<Element, string>();
  /** Pre-recording speaker+text pairs, to recognise their copies after a re-render. */
  private readonly baselineTexts = new Set<string>();
  private firstSync = true;

  constructor(opts: CaptionWatcherOptions) {
    this.opts = opts;
    this.observer = new MutationObserver((records) => this.guard(() => this.process(records)));
  }

  get observing(): boolean {
    return this.region !== null;
  }

  /** Finds the captions region, following it if Meet replaced it. Returns whether one is observed. */
  sync(): boolean {
    const baselineAll = this.firstSync && this.opts.skipExisting === true;
    this.firstSync = false;
    this.guard(() => {
      const found = findCaptionRegion(this.opts.doc);
      if (this.region && this.region.isConnected && (found === this.region || found === null)) {
        this.flush();
        this.sweep(this.opts.now());
        return;
      }
      this.detach();
      if (found) this.attach(found, baselineAll);
    });
    return this.region !== null;
  }

  /** Processes mutations not yet delivered to the observer callback. */
  flush(): void {
    const records = this.observer.takeRecords();
    if (records.length > 0) this.guard(() => this.process(records));
  }

  /** Stops observing and finalizes every tracked block. */
  stop(): void {
    this.guard(() => this.detach());
  }

  private attach(region: Element, baselineAll: boolean): void {
    this.region = region;
    this.observer.observe(region, OBSERVE);
    const t = this.opts.now();
    for (const block of readCaptionBlocks(region)) {
      const pair = JSON.stringify([block.speaker, block.text]);
      if (baselineAll || this.baselineTexts.has(pair)) {
        this.baseline.set(block.node, block.text);
        this.baselineTexts.add(pair);
      } else {
        this.feed(block, t);
      }
    }
  }

  private detach(): void {
    if (!this.region) return;
    this.flush();
    this.observer.disconnect();
    this.region = null;
    this.opts.tracker.removeAll(this.opts.now());
  }

  private process(records: MutationRecord[]): void {
    const region = this.region;
    if (!region) return;
    const t = this.opts.now();
    const touched = new Set<Element>();
    let rescan = false;
    for (const record of records) {
      if (!this.collect(record.target, region, touched)) rescan = true;
      for (const node of record.addedNodes) {
        if (!this.collect(node, region, touched)) rescan = true;
      }
    }
    // Removals first, so a re-rendered copy can take over its predecessor's segment.
    this.sweep(t);
    const blocks = rescan
      ? readCaptionBlocks(region)
      : [...touched]
          .sort(byDocumentOrder)
          .map(readCaptionBlock)
          .filter((b): b is CaptionBlock => b !== null);
    for (const block of blocks) this.feed(block, t);
  }

  /**
   * Adds the block containing `node` to `touched`. Returns false for an element outside
   * any block that may hold blocks (e.g. a new wrapper), which calls for a full rescan.
   */
  private collect(node: Node, region: Element, touched: Set<Element>): boolean {
    const block = captionBlockOf(node, region);
    if (block) {
      touched.add(block);
      return true;
    }
    return !(
      node.nodeType === Node.ELEMENT_NODE &&
      node !== region &&
      (node as Element).childElementCount > 0 &&
      region.contains(node)
    );
  }

  /**
   * Finalizes nodes that left the region. Containment, not isConnected: when Meet drops
   * the whole region, edits queued just before still belong to their blocks, and
   * detach() finalizes everything right after.
   */
  private sweep(t: number): void {
    const region = this.region;
    for (const key of this.opts.tracker.heldKeys()) {
      if (!region || !region.contains(key)) this.opts.tracker.remove(key, t);
    }
  }

  private feed(block: CaptionBlock, t: number): void {
    const base = this.baseline.get(block.node);
    if (base !== undefined) {
      if (base === block.text) return;
      this.baseline.delete(block.node);
    }
    this.opts.tracker.update(block.node, block, t);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}

function byDocumentOrder(a: Element, b: Element): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
