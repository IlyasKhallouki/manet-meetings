/**
 * Every Google Meet DOM selector and UI string Manet relies on lives in this file, so a
 * Meet redesign is a one-file fix. Meet ships obfuscated class names and jsname
 * attributes that change between builds, so each lookup tries jsname / role / aria
 * hooks first, then class names, then the shape of the markup, and every export returns
 * null / [] / false instead of throwing.
 *
 * Reconstructed (Sept 2026) from maintained open-source Meet scrapers, not from a live
 * call; tests/fixtures/captions/README.md lists sources with commit SHAs:
 *  - vivek-nexus/transcriptonic@0cb5eb5: region div[role=region][tabindex=0]; Meet edits
 *    caption text in place (characterData); call_end / closed_caption_off icons; .u6vdEc.
 *  - sanand0/tools@0a20f91, chen-ye/meet-cc-transcript@32fbeba: [jsname=dsyhDe] >
 *    region[aria-label=Captions] > .nMcdL > (.adE6rb > .NWpY1d name) + .ygicle text; "You".
 *  - ChrisRegado/streamdeck-googlemeet@3ab4e06: CC toggle jsname RrG0hf since the Feb 2026
 *    redesign (r8qRAd before), state shown by its closed_caption(_off) icon.
 *  - attendee-labs/attendee@11d70a1: "Turn on/off captions", Leave call jsname CQylAd.
 */

export interface CaptionBlock {
  /** The block element; stable while Meet refines its text in place. */
  node: Element;
  /** Speaker name as displayed; '' if Meet shows none. */
  speaker: string;
  /** Whitespace-collapsed caption text, never empty. */
  text: string;
  /** True when the name is Meet's local-user label ("You" / "Vous"). */
  self: boolean;
}

export type RegionHook = 'jsname' | 'label' | 'class' | 'structure';
export type ControlHook = 'jsname' | 'label' | 'icon';
export type PartHook = 'class' | 'structure';

export interface AdapterHealth {
  inCall: ControlHook | null;
  captionsButton: ControlHook | null;
  captionsState: 'icon' | 'aria-pressed' | 'label' | null;
  captionsOn: boolean | null;
  region: RegionHook | null;
  blockStrategy: PartHook | null;
  blocks: number;
  /** How the first block's speaker and text were read. */
  speaker: PartHook | null;
  text: PartHook | null;
  title: 'jsname' | 'class' | 'document' | null;
}

// Captions region.
const REGION_IN_PANEL = '[jsname="dsyhDe"] [role="region"]';
const REGION = '[role="region"]';
const REGION_BY_CLASS = '[role="region"].vNKgIf';
const REGION_FOCUSABLE = '[role="region"][tabindex="0"]';
const REGION_LABELS = ['captions', 'sous-titres'];

// One block per speaker turn.
const BLOCK_BY_CLASS = '.nMcdL';
const SPEAKER_BY_CLASS = ['.NWpY1d', '.KcIKyf'];
const TEXT_BY_CLASS = ['.ygicle', '.VbkSUe'];

const SELF_LABELS = new Set(['you', 'vous']);

// Toolbar.
const CLICKABLE = 'button, [role="button"]';
const ICON = 'i, .google-symbols';
const CC_JSNAMES = ['RrG0hf', 'r8qRAd'];
const CC_ICONS_OFF = ['closed_caption_off', 'subtitles_off'];
const CC_ICONS_ON = ['closed_caption', 'subtitles'];
const CC_LABEL = /caption|sous-titre/i;
const CC_LABEL_EXCLUDE = /setting|paramètre|langu|translat|tradu|style|size|taille/i;
/** Labels offering to turn captions off, so captions are on. Checked first: "désactiver" contains "activer". */
const CC_LABEL_WHEN_ON =
  /turn off captions|hide captions|désactiver les sous-titres|masquer les sous-titres/i;
const CC_LABEL_WHEN_OFF =
  /turn on captions|show captions|activer les sous-titres|afficher les sous-titres/i;
const LEAVE_JSNAMES = ['CQylAd'];
const LEAVE_LABEL = /^(leave call|quitter l['’]appel)/i;
const LEAVE_ICON = 'call_end';

// Meeting title.
const TITLE_BY_JSNAME = '[jsname="NeC6gb"]';
const TITLE_BY_CLASS = '.u6vdEc';
const TITLE_PREFIX = /^(google\s+)?meet\s*[-–—:]\s*/i;
const TITLE_SUFFIX = /\s*[-–—:]\s*(google\s+)?meet$/i;
const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const MEET_NAME = /^(google\s+)?meet$/i;

type Found<H> = { el: Element; via: H } | null;

export function findCaptionRegion(root: ParentNode): Element | null {
  return safe(() => findRegion(root)?.el ?? null, null);
}

/** Blocks with non-empty text, in document order. */
export function readCaptionBlocks(region: Element): CaptionBlock[] {
  return safe(() => {
    const out: CaptionBlock[] = [];
    for (const node of blockElements(region).els) {
      const block = toCaptionBlock(node);
      if (block) out.push(block);
    }
    return out;
  }, []);
}

/** Reads one block element (as returned by captionBlockOf); null if it is not a block or has no text. */
export function readCaptionBlock(node: Element): CaptionBlock | null {
  return safe(() => {
    if (!node.matches(BLOCK_BY_CLASS) && !looksLikeBlock(node)) return null;
    return toCaptionBlock(node);
  }, null);
}

/** The caption block containing `node` (text node, descendant or the block itself), if any. */
export function captionBlockOf(node: Node, region: Element): Element | null {
  return safe(() => {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || el === region || !region.contains(el)) return null;
    const byClass = el.closest(BLOCK_BY_CLASS);
    if (byClass && byClass !== region && region.contains(byClass)) return byClass;
    if (region.querySelector(BLOCK_BY_CLASS)) return null;
    let cur = el;
    while (cur.parentElement && cur.parentElement !== region) cur = cur.parentElement;
    return cur.parentElement === region && looksLikeBlock(cur) ? cur : null;
  }, null);
}

export function isSelfLabel(name: string): boolean {
  return SELF_LABELS.has(name.normalize('NFC').trim().toLowerCase());
}

/** True while the call toolbar's leave button is on screen. */
export function isInCall(root: ParentNode): boolean {
  return safe(() => findLeaveButton(root) !== null, false);
}

/** Whether the CC toggle shows captions on; null when there is no toggle or its state is unreadable. */
export function captionsEnabled(root: ParentNode): boolean | null {
  return safe(() => {
    const button = findCaptionsButton(root);
    return button ? (readCaptionsState(button.el)?.on ?? null) : null;
  }, null);
}

/** Clicks the CC toggle only when it definitely shows captions off. Returns whether it clicked. */
export function enableCaptions(root: ParentNode): boolean {
  return safe(() => {
    const button = findCaptionsButton(root);
    if (!button || readCaptionsState(button.el)?.on !== false) return false;
    (button.el as HTMLElement).click();
    return true;
  }, false);
}

/** The meeting's title, or null when Meet only shows the meeting code. */
export function meetingTitle(doc: Document): string | null {
  return safe(() => findTitle(doc)?.title ?? null, null);
}

/** Which hooks matched, for one diagnostic log line per call. */
export function adapterHealth(doc: Document): AdapterHealth {
  const empty: AdapterHealth = {
    inCall: null,
    captionsButton: null,
    captionsState: null,
    captionsOn: null,
    region: null,
    blockStrategy: null,
    blocks: 0,
    speaker: null,
    text: null,
    title: null,
  };
  return safe(() => {
    const health = { ...empty };
    health.inCall = findLeaveButton(doc)?.via ?? null;
    const cc = findCaptionsButton(doc);
    health.captionsButton = cc?.via ?? null;
    const state = cc ? readCaptionsState(cc.el) : null;
    health.captionsState = state?.via ?? null;
    health.captionsOn = state?.on ?? null;
    const region = findRegion(doc);
    health.region = region?.via ?? null;
    if (region) {
      const { els, via } = blockElements(region.el);
      health.blockStrategy = els.length > 0 ? via : null;
      health.blocks = readCaptionBlocks(region.el).length;
      const first = els[0];
      if (first) {
        const read = readBlock(first);
        health.speaker = read.speakerVia;
        health.text = read.textVia;
      }
    }
    health.title = findTitle(doc)?.via ?? null;
    return health;
  }, empty);
}

function findRegion(root: ParentNode): Found<RegionHook> {
  const inPanel = root.querySelector(REGION_IN_PANEL);
  if (inPanel) return { el: inPanel, via: 'jsname' };
  for (const el of root.querySelectorAll(REGION)) {
    const label = clean(el.getAttribute('aria-label')).toLowerCase();
    if (REGION_LABELS.includes(label)) return { el, via: 'label' };
  }
  const byClass = root.querySelector(REGION_BY_CLASS);
  if (byClass) return { el: byClass, via: 'class' };
  // An unknown UI language and rotated classes leave only the region's shape.
  for (const el of root.querySelectorAll(REGION_FOCUSABLE)) {
    if ([...el.children].some(looksLikeBlock)) return { el, via: 'structure' };
  }
  return null;
}

function blockElements(region: Element): { els: Element[]; via: PartHook } {
  const byClass = region.querySelectorAll(BLOCK_BY_CLASS);
  if (byClass.length > 0) return { els: [...byClass], via: 'class' };
  return { els: [...region.children].filter(looksLikeBlock), via: 'structure' };
}

/** A block is [header with the name, text]; the trailing "jump to bottom" wrapper holds a button. */
function looksLikeBlock(el: Element): boolean {
  if (el.matches(CLICKABLE) || el.querySelector(CLICKABLE)) return false;
  const first = el.firstElementChild;
  const last = el.lastElementChild;
  if (!first || !last || first === last) return false;
  return clean(first.textContent) !== '' && clean(last.textContent) !== '';
}

function toCaptionBlock(node: Element): CaptionBlock | null {
  const read = readBlock(node);
  return read.text ? { node, speaker: read.speaker, text: read.text, self: isSelfLabel(read.speaker) } : null;
}

function readBlock(block: Element): {
  speaker: string;
  text: string;
  speakerVia: PartHook | null;
  textVia: PartHook | null;
} {
  let textEl = firstMatch(block, TEXT_BY_CLASS);
  let textVia: PartHook | null = textEl ? 'class' : null;
  if (!textEl && block.childElementCount >= 2) {
    textEl = block.lastElementChild;
    textVia = 'structure';
  }
  let speakerEl = firstMatch(block, SPEAKER_BY_CLASS);
  let speakerVia: PartHook | null = speakerEl ? 'class' : null;
  if (!speakerEl && block.firstElementChild && block.firstElementChild !== textEl) {
    speakerEl = block.firstElementChild;
    speakerVia = 'structure';
  }
  return { speaker: clean(speakerEl?.textContent), text: clean(textEl?.textContent), speakerVia, textVia };
}

function findCaptionsButton(root: ParentNode): Found<ControlHook> {
  const byJsname = byJsnames(root, CC_JSNAMES);
  if (byJsname) return { el: byJsname, via: 'jsname' };
  // The captions region has its own "Jump to the most recent captions" button.
  const region = findRegion(root)?.el;
  const clickables = [...root.querySelectorAll(CLICKABLE)].filter((el) => !region?.contains(el));
  // Icon ligature names are the same in every UI language, so they go before labels.
  const byIcon = clickables.find((el) =>
    iconNames(el).some((n) => CC_ICONS_OFF.includes(n) || CC_ICONS_ON.includes(n)),
  );
  if (byIcon) return { el: byIcon, via: 'icon' };
  const byLabel = clickables.find((el) => {
    const label = labelOf(el);
    return CC_LABEL.test(label) && !CC_LABEL_EXCLUDE.test(label);
  });
  return byLabel ? { el: byLabel, via: 'label' } : null;
}

function readCaptionsState(button: Element): { on: boolean; via: 'icon' | 'aria-pressed' | 'label' } | null {
  const icons = iconNames(button);
  if (icons.some((n) => CC_ICONS_OFF.includes(n))) return { on: false, via: 'icon' };
  if (icons.some((n) => CC_ICONS_ON.includes(n))) return { on: true, via: 'icon' };
  const pressed = button.getAttribute('aria-pressed');
  if (pressed === 'true' || pressed === 'false') return { on: pressed === 'true', via: 'aria-pressed' };
  const label = labelOf(button);
  if (CC_LABEL_WHEN_ON.test(label)) return { on: true, via: 'label' };
  if (CC_LABEL_WHEN_OFF.test(label)) return { on: false, via: 'label' };
  return null;
}

function findLeaveButton(root: ParentNode): Found<ControlHook> {
  const byJsname = byJsnames(root, LEAVE_JSNAMES);
  if (byJsname) return { el: byJsname, via: 'jsname' };
  const clickables = [...root.querySelectorAll(CLICKABLE)];
  const byLabel = clickables.find((el) =>
    [el.getAttribute('aria-label'), el.getAttribute('data-tooltip')].some((l) => LEAVE_LABEL.test(clean(l))),
  );
  if (byLabel) return { el: byLabel, via: 'label' };
  const byIcon = clickables.find((el) => iconNames(el).includes(LEAVE_ICON));
  return byIcon ? { el: byIcon, via: 'icon' } : null;
}

function findTitle(doc: Document): { title: string; via: 'jsname' | 'class' | 'document' } | null {
  const byJsname = usableTitle(doc.querySelector(TITLE_BY_JSNAME)?.textContent);
  if (byJsname) return { title: byJsname, via: 'jsname' };
  const byClass = usableTitle(doc.querySelector(TITLE_BY_CLASS)?.textContent);
  if (byClass) return { title: byClass, via: 'class' };
  const fromDocument = usableTitle(clean(doc.title).replace(TITLE_PREFIX, '').replace(TITLE_SUFFIX, ''));
  return fromDocument ? { title: fromDocument, via: 'document' } : null;
}

function usableTitle(raw: string | null | undefined): string | null {
  const title = clean(raw);
  if (!title || MEET_CODE.test(title) || MEET_NAME.test(title)) return null;
  return title;
}

function byJsnames(root: ParentNode, names: string[]): Element | null {
  for (const name of names) {
    const el = root.querySelector(`button[jsname="${name}"], [role="button"][jsname="${name}"]`);
    if (el) return el;
  }
  return null;
}

function firstMatch(root: Element, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function iconNames(el: Element): string[] {
  return [...el.querySelectorAll(ICON)].map((i) => clean(i.textContent).toLowerCase());
}

function labelOf(el: Element): string {
  return `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''}`;
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
