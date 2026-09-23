import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@lib/ui/styles.css';
import { createMenu, menuButtonAttrs, menuButtonKeys, type Menu, type MenuItem } from '@lib/ui/menu';

let host: HTMLElement;
let anchor: HTMLButtonElement;
let other: HTMLButtonElement;
let menu: Menu;

beforeEach(() => {
  host = document.createElement('div');
  anchor = document.createElement('button');
  anchor.textContent = '⋯';
  anchor.setAttribute('aria-label', 'More actions for Weekly sync');
  other = document.createElement('button');
  other.textContent = 'Elsewhere';
  host.append(anchor, other);
  document.body.append(host);
  menu = createMenu(host);
  for (const [name, value] of Object.entries(menuButtonAttrs(menu))) anchor.setAttribute(name, String(value));
});

afterEach(() => {
  menu.destroy();
  host.remove();
});

function items(selected: string[] = []): MenuItem[] {
  return [
    { label: 'Transcribe again', onSelect: () => selected.push('transcribe') },
    { label: 'Change profile…', onSelect: () => selected.push('change-profile') },
    { label: 'Delete…', separatorBefore: true, onSelect: () => selected.push('delete') },
  ];
}

const open = () => menu.element.matches(':popover-open');
const labels = () => [...menu.element.querySelectorAll('[role="menuitem"]')].map((el) => el.firstChild?.textContent);
const key = (target: Element, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

describe('the ⋯ menu', () => {
  it('is one popover menu, named after its button, with separators', () => {
    expect(menu.element.getAttribute('role')).toBe('menu');
    expect(menu.element.getAttribute('popover')).toBe('manual');
    expect(anchor.getAttribute('aria-haspopup')).toBe('menu');
    expect(anchor.getAttribute('aria-controls')).toBe(menu.element.id);
    menu.open(anchor, items());
    expect(open()).toBe(true);
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    expect(menu.element.getAttribute('aria-label')).toBe('More actions for Weekly sync');
    expect(labels()).toEqual(['Transcribe again', 'Change profile…', 'Delete…']);
    expect(menu.element.querySelectorAll('[role="separator"]').length).toBe(1);
    menu.close();
    expect(open()).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on the first or last item from the keyboard, on the menu itself from the pointer', () => {
    menu.open(anchor, items(), { focus: 'first' });
    expect(document.activeElement?.textContent).toBe('Transcribe again');
    menu.open(anchor, items(), { focus: 'last' });
    expect(document.activeElement?.textContent).toBe('Delete…');
    menu.open(anchor, items());
    expect(document.activeElement).toBe(menu.element);
  });

  it('moves with the arrow keys (wrapping), Home, End and a letter', () => {
    menu.open(anchor, items(), { focus: 'first' });
    const active = () => document.activeElement?.firstChild?.textContent;
    key(document.activeElement!, 'ArrowDown');
    expect(active()).toBe('Change profile…');
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowDown');
    expect(active()).toBe('Transcribe again');
    key(document.activeElement!, 'ArrowUp');
    expect(active()).toBe('Delete…');
    key(document.activeElement!, 'Home');
    expect(active()).toBe('Transcribe again');
    key(document.activeElement!, 'End');
    expect(active()).toBe('Delete…');
    key(document.activeElement!, 'c');
    expect(active()).toBe('Change profile…');
  });

  it('arrow keys on the menu itself (opened by pointer) reach the first and last items', () => {
    menu.open(anchor, items());
    key(menu.element, 'ArrowDown');
    expect(document.activeElement?.firstChild?.textContent).toBe('Transcribe again');
    menu.open(anchor, items());
    key(menu.element, 'ArrowUp');
    expect(document.activeElement?.firstChild?.textContent).toBe('Delete…');
  });

  it('runs a choice after closing, with focus back on the button', () => {
    const selected: string[] = [];
    let focusedDuring: Element | null = null;
    const list = items(selected);
    list[1]!.onSelect = () => {
      focusedDuring = document.activeElement;
      selected.push('change-profile');
    };
    menu.open(anchor, list, { focus: 'first' });
    (menu.element.querySelectorAll('[role="menuitem"]')[1] as HTMLElement).click();
    expect(selected).toEqual(['change-profile']);
    expect(open()).toBe(false);
    expect(focusedDuring).toBe(anchor);
  });

  it('keeps a disabled item focusable, with its reason, but does nothing with it', () => {
    const onSelect = vi.fn();
    menu.open(anchor, [{ label: 'Delete…', disabled: true, note: 'Wait for it to finish', onSelect }], { focus: 'first' });
    const item = menu.element.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toBe('Delete…Wait for it to finish');
    expect(document.activeElement).toBe(item);
    item.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(open()).toBe(true);
  });

  it('Esc closes and returns focus to the button; Tab closes and moves on from the button', () => {
    menu.open(anchor, items(), { focus: 'first' });
    key(document.activeElement!, 'Escape');
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(anchor);

    menu.open(anchor, items(), { focus: 'first' });
    key(document.activeElement!, 'Tab');
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('closes on a pointerdown elsewhere, without stealing focus; the button itself toggles', () => {
    menu.open(anchor, items());
    anchor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(open()).toBe(true);
    other.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(open()).toBe(false);

    menu.toggle(anchor, items());
    expect(open()).toBe(true);
    menu.toggle(anchor, items());
    expect(open()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it('opening for another button closes the first', () => {
    menu.open(anchor, items());
    menu.open(other, items(), { signature: 'b' });
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
    expect(menu.anchor).toBe(other);
    expect(menu.signature).toBe('b');
  });

  it('↓ and ↑ on the button open the menu', () => {
    const opened: string[] = [];
    anchor.addEventListener('keydown', menuButtonKeys((focus) => opened.push(focus)));
    key(anchor, 'ArrowDown');
    key(anchor, 'ArrowUp');
    key(anchor, 'Enter');
    expect(opened).toEqual(['first', 'last']);
  });
});

describe('menu position', () => {
  function place(css: Partial<CSSStyleDeclaration>): void {
    Object.assign(anchor.style, { position: 'fixed', width: '32px', height: '32px', ...css });
  }

  it('hangs under the button with trailing edges aligned', () => {
    place({ top: '100px', left: '300px' });
    menu.open(anchor, items());
    const a = anchor.getBoundingClientRect();
    const m = menu.element.getBoundingClientRect();
    expect(menu.element.dataset.placement).toBe('below');
    expect(Math.round(m.top)).toBe(Math.round(a.bottom + 4));
    expect(Math.abs(m.right - a.right)).toBeLessThanOrEqual(1);
  });

  it('flips above the button near the bottom of the viewport', () => {
    place({ bottom: '8px', left: '300px' });
    menu.open(anchor, items());
    const a = anchor.getBoundingClientRect();
    const m = menu.element.getBoundingClientRect();
    expect(menu.element.dataset.placement).toBe('above');
    expect(Math.round(m.bottom)).toBe(Math.round(a.top - 4));
  });

  it('stays inside the viewport at the leading edge', () => {
    place({ top: '100px', left: '0px' });
    menu.open(anchor, items());
    expect(menu.element.getBoundingClientRect().left).toBeGreaterThanOrEqual(8);
  });
});
