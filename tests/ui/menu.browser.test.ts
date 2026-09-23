import { afterEach, describe, expect, it } from 'vitest';
import { createMenu } from '@lib/ui/menu';

describe('menu items with a checkmark', () => {
  afterEach(() => document.body.replaceChildren());

  it('marks a checked item as the selected radio item with a check glyph', () => {
    const host = document.createElement('div');
    const anchor = document.createElement('button');
    document.body.append(host, anchor);
    const menu = createMenu(host);
    menu.open(anchor, [
      { label: 'Team', checked: true, onSelect: () => undefined },
      { label: 'Client meeting', checked: false, onSelect: () => undefined },
      { label: 'Delete…', onSelect: () => undefined },
    ]);
    const items = [...menu.element.querySelectorAll('.menu-item')];
    expect(items.map((i) => [i.getAttribute('role'), i.getAttribute('aria-checked')])).toEqual([
      ['menuitemradio', 'true'],
      ['menuitemradio', 'false'],
      ['menuitem', null],
    ]);
    expect(items[0]!.querySelector('.glyph-check')).not.toBeNull();
    expect(items[1]!.querySelector('.glyph-check')).toBeNull();
    menu.destroy();
  });
});
