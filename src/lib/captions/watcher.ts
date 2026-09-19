/**
 * Feeds a CaptionTracker from Meet's captions region through a MutationObserver.
 *
 * Meet edits caption text in place and adds/removes block nodes; it also recreates the
 * whole region when captions are toggled or the layout changes. The content script
 * calls sync() about once a second so the observer follows a recreated region; the
 * tracker's continuation rule keeps segment ids stable across such re-renders.
 */
import { splitWords } from '../align/sequence';
import {
  captionBlockOf,
  findCaptionRegion,
  readCaptionBlock,
  readCaptionBlocks,
  type CaptionBlock,
} from '../meet/captionAdapter';
import { continues, DEFAULT_RESET_DROP, type CaptionTracker } from './tracker';

export interface CaptionWatcherOptions {
  doc: Document;
  tracker: CaptionTracker<Element>;
  /** Current time in ms from recording start. */
  now: () => number;
  /**
   * Blocks already on screen at the first sync() were spoken before recording started:
   * only words added to them later are fed (corrections of the old words are not new
   * speech), and their re-rendered copies are treated the same. A region that only
   * appears later holds post-start captions and is read in full.
   */
  skipExisting?: boolean;
  onError?: (err: unknown) => void;
}

const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true };

/** What a block read when recording started. */
interface Baseline {
  speaker: string;
  text: string;
}

export class CaptionWatcher {
  private readonly opts: CaptionWatcherOptions;
  private region: Element | null = null;
  private readonly observer: MutationObserver;
  /** Pre-recording reading per node, while the node still holds that speech. */
  private readonly baseline = new WeakMap<Element, Baseline>();
  /** Pre-recording readings still on screen, to recognise their copies after a re-render. */
  private baselines: Baseline[] = [];
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
    const known = this.baselines;
    this.baselines = [];
    for (const block of readCaptionBlocks(region)) {
      // At the first sync every block predates the recording; later, copies of those still on screen do.
      const base = baselineAll
        ? { speaker: block.speaker, text: block.text }
        : known.find((b) => b.speaker === block.speaker && (b.text === block.text || continues(b.text, block.text)));
      if (base) {
        this.baseline.set(block.node, base);
        if (!this.baselines.includes(base)) this.baselines.push(base);
      }
      if (!baselineAll) this.feed(block, t);
    }
  }

  private detach(): void {
    if (!this.region) return;
    this.flush();
    // A pre-recording block Meet already dropped cannot come back in a re-render.
    const onScreen = new Set(readCaptionBlocks(this.region).map((b) => this.baseline.get(b.node)));
    this.baselines = this.baselines.filter((b) => onScreen.has(b));
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
    if (base) {
      const added = base.speaker === block.speaker ? wordsAdded(base.text, block.text) : null;
      if (added === '') return;
      if (added !== null) {
        this.opts.tracker.update(block.node, { ...block, text: added }, t);
        return;
      }
      // Meet reused the node for other speech.
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

/**
 * The words of `text` past the pre-recording `base` it grew from ('' when a correction
 * added none), or null when Meet restarted the block with other speech. Counted by
 * position, so a word Meet corrects inside the old part is not fed as new speech.
 */
function wordsAdded(base: string, text: string): string | null {
  if (base.length - text.length >= DEFAULT_RESET_DROP && !continues(base, text)) return null;
  return splitWords(text).slice(splitWords(base).length).join(' ');
}

function byDocumentOrder(a: Element, b: Element): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
