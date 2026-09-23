/**
 * The ⋯ menu: ONE popover element per page, shared by every row's More actions button.
 * It lives outside the patched rows, so a row re-render can never destroy an open menu;
 * the owner closes it when that row's actions change (`signature`).
 *
 * Popover API in manual mode (top layer, Chrome 114+) with our own dismissal, because
 * light dismiss would close the menu on the pointerdown that should toggle it. CSS anchor
 * positioning needs Chrome 125 and the manifest allows 116, so it is positioned here:
 * trailing edge under the button, flipped above it near the bottom of the viewport. When
 * it fits neither way (a short window such as the toolbar popup, which can't show anything
 * past its own edge), it takes the roomier side and scrolls.
 *
 * Keyboard (WAI-ARIA menu button): Enter, Space or ↓ on the button opens it on the first
 * item, ↑ on the last; ↑ ↓ Home End and a letter move between items; Enter or Space
 * chooses; Esc closes and returns focus to the button; Tab closes and moves on from the
 * button. Opened with the pointer, focus goes to the menu itself, so no item looks
 * selected until the pointer or an arrow key picks one.
 */
import { h, type Attrs } from './dom';
import { svg } from './icons';

export interface MenuItem {
  label: string;
  /** Runs after the menu has closed and focus is back on the button. */
  onSelect: () => void;
  /** Shown dimmed; can take focus (so its note is read) but does nothing. */
  disabled?: boolean;
  /** Why it is unavailable, under the label. */
  note?: string;
  /** A separator above this item. */
  separatorBefore?: boolean;
  /** A choice among the items: true shows ✓ and aria-checked. Undefined for a plain action. */
  checked?: boolean;
  attrs?: Attrs;
}

/** Why the menu closed: an outside pointerdown, Esc, an item was chosen, or anything else. */
export type MenuCloseReason = 'outside' | 'escape' | 'choice' | 'other';

export interface OpenOptions {
  /** first/last item (keyboard), or the menu itself (pointer). Default: menu. */
  focus?: 'first' | 'last' | 'menu';
  /** What the items were built from; the owner compares it to tell when they go stale. */
  signature?: string;
  /** Accessible name; defaults to the button's. */
  label?: string;
  /** Runs once the menu has closed, with why. */
  onClose?: (reason: MenuCloseReason) => void;
}

export interface Menu {
  readonly element: HTMLElement;
  /** The button the menu is open for, or null when closed. */
  readonly anchor: HTMLElement | null;
  readonly signature: string | undefined;
  open(anchor: HTMLElement, items: MenuItem[], options?: OpenOptions): void;
  /** `restoreFocus`: put focus back on the button (Esc, a choice, stale items). */
  close(options?: { restoreFocus?: boolean }): void;
  /** Opens for `anchor`, or closes when it is already open for it. */
  toggle(anchor: HTMLElement, items: MenuItem[], options?: OpenOptions): void;
  /** Re-anchors after the page moved. */
  position(): void;
  destroy(): void;
}

/** Distance between the button and the menu, and the menu and the viewport edge. */
const GAP = 4;
const EDGE = 8;

let menuCount = 0;

/**
 * Creates the page's menu inside `host` (anywhere outside the re-rendered rows). Wire a
 * button with menuButtonAttrs() and call toggle() from its click handler.
 */
export function createMenu(host: HTMLElement): Menu {
  const id = `menu-${++menuCount}`;
  const element = h('div', {
    id,
    class: 'menu',
    role: 'menu',
    popover: 'manual',
    tabindex: '-1',
    'aria-orientation': 'vertical',
  });
  host.append(element);

  let anchor: HTMLElement | null = null;
  let signature: string | undefined;
  let entries: { el: HTMLButtonElement; item: MenuItem }[] = [];
  let onCloseCb: OpenOptions['onClose'];

  const items = () => entries.map((e) => e.el);

  function focusItem(index: number): void {
    const list = items();
    if (list.length === 0) return;
    const i = (index + list.length) % list.length;
    const item = list[i]!;
    item.focus({ preventScroll: true });
    revealItem(item);
  }

  /** In a menu that scrolls, brings the item into view (only the menu scrolls, never the page). */
  function revealItem(item: HTMLElement): void {
    if (element.scrollHeight <= element.clientHeight) return;
    const pad = parseFloat(getComputedStyle(element).paddingBlockStart) || 0;
    const top = item.offsetTop - pad;
    const bottom = item.offsetTop + item.offsetHeight + pad;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
  }

  function currentIndex(): number {
    return items().indexOf(document.activeElement as HTMLButtonElement);
  }

  function choose(entry: { el: HTMLButtonElement; item: MenuItem }): void {
    if (entry.item.disabled) return;
    close({ restoreFocus: true, reason: 'choice' });
    entry.item.onSelect();
  }

  function build(list: MenuItem[]): void {
    entries = [];
    const children: HTMLElement[] = [];
    for (const item of list) {
      if (item.separatorBefore && children.length > 0) children.push(h('div', { class: 'menu-sep', role: 'separator' }));
      const choice = item.checked !== undefined;
      const el = h(
        'button',
        {
          type: 'button',
          ...item.attrs,
          class: choice ? 'menu-item menu-item-choice' : 'menu-item',
          role: choice ? 'menuitemradio' : 'menuitem',
          'aria-checked': choice ? String(item.checked) : undefined,
          tabindex: '-1',
          'aria-disabled': item.disabled ? 'true' : undefined,
        },
        choice ? h('span', { class: 'menu-item-check' }, item.checked ? svg('check') : null) : null,
        h('span', { class: 'menu-item-label' }, item.label),
        item.note ? h('span', { class: 'menu-item-note' }, item.note) : null,
      );
      const entry = { el, item };
      el.addEventListener('click', () => choose(entry));
      el.addEventListener('pointermove', () => {
        if (document.activeElement !== el) el.focus({ preventScroll: true });
      });
      entries.push(entry);
      children.push(el);
    }
    element.replaceChildren(...children);
  }

  function position(): void {
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    const m = element.getBoundingClientRect();
    // Its full height even while capped (no border), measured without lifting the cap: that
    // would lose how far it has been scrolled.
    const full = Math.max(m.height, element.scrollHeight);
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const below = vh - EDGE - (a.bottom + GAP);
    const above = a.top - GAP - EDGE;
    const placement = full <= below || (full > above && below >= above) ? 'below' : 'above';
    const limit = placement === 'below' ? below : above;
    const capped = full > limit;
    const room = Math.floor(Math.max(0, limit));
    const height = capped ? room : full;
    element.style.maxBlockSize = capped ? `${room}px` : '';
    element.style.overflowY = capped ? 'auto' : '';
    // A capped menu may have gained an always-visible scrollbar, widening it; re-read the
    // width now that the cap styles are applied, before computing where its left edge lands.
    const width = capped ? element.getBoundingClientRect().width : m.width;
    let left = a.right - width;
    left = Math.min(left, vw - EDGE - width);
    left = Math.max(EDGE, left);
    const top = placement === 'below' ? a.bottom + GAP : a.top - GAP - height;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(Math.max(EDGE, top))}px`;
    element.dataset.placement = placement;
  }

  const onOutside = (event: Event) => {
    const target = event.target as Node | null;
    if (!anchor || !target) return;
    if (element.contains(target) || anchor.contains(target)) return;
    close({ reason: 'outside' });
  };
  // The page scrolled or resized; the menu's own scrolling moves nothing.
  const onViewport = (event: Event) => {
    if (event.target !== element) position();
  };

  function open(target: HTMLElement, list: MenuItem[], options: OpenOptions = {}): void {
    if (anchor && anchor !== target) close();
    anchor = target;
    signature = options.signature;
    onCloseCb = options.onClose;
    build(list);
    const label = options.label ?? target.getAttribute('aria-label') ?? undefined;
    if (label) element.setAttribute('aria-label', label);
    else element.removeAttribute('aria-label');
    if (!element.matches(':popover-open')) element.showPopover();
    target.setAttribute('aria-expanded', 'true');
    position();
    // A menu that scrolls opens on the current choice.
    const chosen = entries.find((e) => e.item.checked);
    if (chosen) revealItem(chosen.el);
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    const focus = options.focus ?? 'menu';
    if (focus === 'first') focusItem(0);
    else if (focus === 'last') focusItem(-1);
    else element.focus({ preventScroll: true });
  }

  function close(options: { restoreFocus?: boolean; reason?: MenuCloseReason } = {}): void {
    const was = anchor;
    if (!was) return;
    const cb = onCloseCb;
    anchor = null;
    signature = undefined;
    onCloseCb = undefined;
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('scroll', onViewport, true);
    was.setAttribute('aria-expanded', 'false');
    const hadFocus = element.contains(document.activeElement);
    if (element.matches(':popover-open')) element.hidePopover();
    element.replaceChildren();
    entries = [];
    if ((options.restoreFocus || hadFocus) && was.isConnected) was.focus({ preventScroll: true });
    cb?.(options.reason ?? 'other');
  }

  element.addEventListener('keydown', (event) => {
    const index = currentIndex();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(index < 0 ? 0 : index + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(index < 0 ? -1 : index - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        return;
      case 'End':
        event.preventDefault();
        focusItem(-1);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close({ restoreFocus: true, reason: 'escape' });
        return;
      case 'Tab':
        // Back to the button; the Tab itself then moves on from there.
        close({ restoreFocus: true });
        return;
      case 'Enter':
      case ' ':
        if (index < 0) event.preventDefault();
        return;
      default:
        if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const key = event.key.toLowerCase();
          const list = entries.map((e) => e.item.label.toLowerCase());
          for (let step = 1; step <= list.length; step++) {
            const i = (Math.max(index, -1) + step) % list.length;
            if (list[i]!.startsWith(key)) {
              focusItem(i);
              break;
            }
          }
        }
    }
  });

  // The pointer leaving the menu takes the highlight with it, as in native menus.
  element.addEventListener('pointerleave', () => {
    if (anchor && element.contains(document.activeElement) && document.activeElement !== element) {
      element.focus({ preventScroll: true });
    }
  });

  element.addEventListener('focusout', (event) => {
    const next = event.relatedTarget as Node | null;
    if (!anchor || !next) return;
    if (!element.contains(next) && !anchor.contains(next)) close();
  });

  return {
    element,
    get anchor() {
      return anchor;
    },
    get signature() {
      return signature;
    },
    open,
    close,
    toggle(target, list, options) {
      if (anchor === target) close({ restoreFocus: true });
      else open(target, list, options);
    },
    position,
    destroy() {
      close();
      element.remove();
    },
  };
}

/** ARIA for a button that opens `menu`. */
export function menuButtonAttrs(menu: Menu): Attrs {
  return { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menu.element.id };
}

/**
 * The button's own keys: ↓ opens on the first item, ↑ on the last. Click (Enter/Space
 * included) is the owner's toggle; `event.detail === 0` there means the keyboard.
 */
export function menuButtonKeys(open: (focus: 'first' | 'last') => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  };
}
