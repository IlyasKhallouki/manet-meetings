/** Minimal element builder for the extension pages (no framework). */

export type Child = Node | string | number | null | undefined | false;
type AttrValue = string | number | boolean | null | undefined;
export type Attrs = Record<string, AttrValue | ((event: Event) => void)>;

/**
 * h('button', { class: 'primary', type: 'button', onclick: fn, disabled: true }, 'Save').
 * `on*` functions become listeners; `true` sets an empty attribute; false/null/undefined skip it.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (typeof value === 'function') el.addEventListener(name.slice(2), value);
    else if (value === true) el.setAttribute(name, '');
    else if (value !== false && value !== null && value !== undefined) el.setAttribute(name, String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Element, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

/** Replaces the element's content. */
export function mount(parent: Element, ...children: (Child | Child[])[]): void {
  parent.replaceChildren();
  append(parent, children);
}

/**
 * Remembers which keyed control had focus (`data-key`) before `render` and restores it
 * afterwards, so re-rendering does not throw keyboard users back to the top.
 */
export function keepFocus(root: Element, render: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active) ? active.dataset.key : undefined;
  render();
  if (!key || active?.isConnected) return;
  root.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
}
