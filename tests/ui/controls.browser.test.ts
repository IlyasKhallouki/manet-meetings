import { afterEach, describe, expect, it, vi } from 'vitest';
import '@lib/ui/styles.css';
import {
  button,
  callout,
  factList,
  field,
  guard,
  iconButton,
  isInert,
  kbd,
  note,
  secretInput,
  section,
  segmented,
  setBusy,
  setDisabled,
  setFieldMessage,
  setSegmented,
  statusLine,
  stepProgress,
  switchInput,
  switchRow,
  textInput,
} from '@lib/ui/controls';
import { h } from '@lib/ui/dom';
import { GLYPH_NAMES, svg } from '@lib/ui/icons';

let host: HTMLElement;

function mountHost(...children: Node[]): HTMLElement {
  host = h('div', null, ...children);
  document.body.append(host);
  return host;
}

afterEach(() => host?.remove());

function key(el: Element, k: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}

describe('svg()', () => {
  it('is decorative by default and colours with currentColor', () => {
    const el = svg('caution');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute('fill')).toBe('currentColor');
    expect(el.getAttribute('viewBox')).toBe('0 0 16 16');
    expect(el.getAttribute('focusable')).toBe('false');
    expect(el.classList.contains('glyph-caution')).toBe(true);
    expect(el.querySelector('path')?.getAttribute('fill-rule')).toBe('evenodd');
  });

  it('with a title becomes an image with that name', () => {
    const el = svg('done', { title: 'Saved', class: 'tone-done', size: 16 });
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Saved');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(el.querySelector('title')?.textContent).toBe('Saved');
    expect(el.getAttribute('width')).toBe('16');
    expect(el.classList.contains('tone-done')).toBe(true);
  });

  it('has the whole glyph set from the spec', () => {
    expect(GLYPH_NAMES.sort()).toEqual(
      ['caution', 'check', 'chevron', 'dash', 'done', 'info', 'live', 'mic', 'more', 'neutral', 'working'].sort(),
    );
  });
});

describe('buttons', () => {
  it('builds the class vocabulary per kind, always type=button', () => {
    expect(button('Open in Notion').className).toBe('btn');
    expect(button('Continue', { kind: 'prominent' }).className).toBe('btn prominent');
    expect(button('Stop recording', { kind: 'live', hero: true }).className).toBe('btn live hero');
    expect(button('Settings', { kind: 'plain' }).className).toBe('btn plain');
    expect(button('Allow microphone…', { kind: 'link' }).className).toBe('link');
    expect(button('x', { class: 'a', attrs: { class: 'b', 'data-key': 'k' } }).className).toBe('btn a b');
    expect(button('x').type).toBe('button');
  });

  it('marks pending with aria-disabled, never disabled, and skips the handler', () => {
    const onClick = vi.fn();
    const el = button('Checking…', { disabled: true, onClick });
    mountHost(el);
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.disabled).toBe(false);
    el.click();
    expect(onClick).not.toHaveBeenCalled();
    setDisabled(el, false);
    el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on a control that becomes pending (review C4)', () => {
    const el = button('Transcribe');
    mountHost(el);
    el.focus();
    setDisabled(el, true);
    expect(document.activeElement).toBe(el);
    expect(isInert(el)).toBe(true);
  });

  it('icon buttons are named by their label; the glyph is hidden', () => {
    const el = iconButton('more', 'More actions for Weekly sync');
    expect(el.getAttribute('aria-label')).toBe('More actions for Weekly sync');
    expect(el.title).toBe('More actions for Weekly sync');
    expect(el.className).toBe('btn icon');
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(iconButton('more', 'More', { tooltip: null }).hasAttribute('title')).toBe(false);
  });

  it('busy is aria-busy + aria-disabled: handler skipped, focus stays, both cleared together', () => {
    const onClick = vi.fn();
    const el = button('Starting…', { kind: 'prominent', hero: true, busy: true, onClick });
    mountHost(el);
    el.focus();
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    expect(el.disabled).toBe(false);
    el.click();
    expect(onClick).not.toHaveBeenCalled();
    setBusy(el, false);
    expect(el.hasAttribute('aria-busy')).toBe(false);
    expect(el.hasAttribute('aria-disabled')).toBe(false);
    el.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    setBusy(el, true);
    expect(document.activeElement).toBe(el);
    expect(isInert(el)).toBe(true);
  });

  it('aria-busy alone is inert too', () => {
    expect(isInert(h('button', { type: 'button', 'aria-busy': 'true' }, 'Checking…'))).toBe(true);
    expect(isInert(h('button', { type: 'button' }, 'Check'))).toBe(false);
  });

  it('guard() protects hand-built elements too', () => {
    const handler = vi.fn();
    const el = h('button', { type: 'button', 'aria-disabled': 'true' }, 'Go');
    el.addEventListener('click', guard(handler));
    el.click();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('segmented()', () => {
  const options = [
    { value: 'team' as const, label: 'Team', shortcut: 'T' },
    { value: 'personal' as const, label: 'Personal', shortcut: 'P' },
  ];

  it('is a named group of aria-pressed buttons', () => {
    const group = segmented({ label: 'Save to', options, value: 'team', onSelect: () => {} });
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Save to');
    const [team, personal] = [...group.querySelectorAll('button')];
    expect(team?.getAttribute('aria-pressed')).toBe('true');
    expect(personal?.getAttribute('aria-pressed')).toBe('false');
    expect(team?.getAttribute('aria-keyshortcuts')).toBe('T');
    expect(team?.type).toBe('button');
    expect(team?.querySelector('.segment-check')?.getAttribute('aria-hidden')).toBe('true');
    // The ✓ belongs to the label, so it can hang off the label's edge (styles.css).
    expect(team?.querySelector('.segment-label > .segment-check')).not.toBeNull();
    // The accessible name is the label alone (the ✓ is decorative).
    expect(team?.textContent).toBe('Team');
  });

  it('can be labelled by a visible element instead', () => {
    const group = segmented({ labelledBy: 'q', options, value: null, onSelect: () => {} });
    expect(group.getAttribute('aria-labelledby')).toBe('q');
    expect(group.hasAttribute('aria-label')).toBe(false);
    expect([...group.querySelectorAll('[aria-pressed="true"]')]).toHaveLength(0);
  });

  it('activation commits; the owner flips aria-pressed with setSegmented', () => {
    const onSelect = vi.fn();
    const group = segmented({ label: 'Save to', options, value: null, onSelect });
    mountHost(group);
    group.querySelector<HTMLButtonElement>('[data-value="personal"]')?.click();
    expect(onSelect).toHaveBeenCalledWith('personal', expect.any(Event));
    expect(group.querySelector('[data-value="personal"]')?.getAttribute('aria-pressed')).toBe('false');
    setSegmented(group, 'personal');
    expect(group.querySelector('[data-value="personal"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(group.querySelector('[data-value="team"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('arrow keys, Home and End move focus only — they never choose', () => {
    const onSelect = vi.fn();
    const group = segmented({ label: 'Save to', options, value: 'team', onSelect });
    mountHost(group);
    const [team, personal] = [...group.querySelectorAll<HTMLButtonElement>('button')];
    team?.focus();
    key(team!, 'ArrowRight');
    expect(document.activeElement).toBe(personal);
    key(personal!, 'ArrowRight');
    expect(document.activeElement).toBe(team);
    key(team!, 'ArrowLeft');
    expect(document.activeElement).toBe(personal);
    key(personal!, 'Home');
    expect(document.activeElement).toBe(team);
    key(team!, 'End');
    expect(document.activeElement).toBe(personal);
    expect(onSelect).not.toHaveBeenCalled();
    expect(team?.getAttribute('aria-pressed')).toBe('true');
  });

  it('pending segments keep focus and ignore activation', () => {
    const onSelect = vi.fn();
    const group = segmented({ label: 'Save to', options, value: 'team', disabled: true, onSelect });
    mountHost(group);
    const personal = group.querySelector<HTMLButtonElement>('[data-value="personal"]')!;
    personal.focus();
    personal.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(personal);
    expect(personal.getAttribute('aria-disabled')).toBe('true');
  });

  it('busy segments are aria-busy, ignore activation and keep focus', () => {
    const onSelect = vi.fn();
    const group = segmented({ label: 'Save to', options, value: 'personal', busy: true, onSelect });
    mountHost(group);
    const segments = [...group.querySelectorAll<HTMLButtonElement>('.segment')];
    expect(segments.map((s) => [s.getAttribute('aria-busy'), s.getAttribute('aria-disabled')])).toEqual([
      ['true', 'true'],
      ['true', 'true'],
    ]);
    segments[0]!.focus();
    segments[0]!.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(segments[0]);
    for (const s of segments) setBusy(s, false);
    segments[0]!.click();
    expect(onSelect).toHaveBeenCalledWith('team', expect.any(Event));
  });

  it('the ✓ sits 4 px before its label, whatever the segment width', () => {
    const narrow = segmented({ label: 'Save to', options, value: 'team', onSelect: () => {} });
    const wide = segmented({ label: 'Save to', options, value: 'team', large: true, onSelect: () => {} });
    mountHost(narrow, h('div', { style: 'width:340px;display:grid' }, wide));
    for (const group of [narrow, wide]) {
      for (const value of ['team', 'personal']) {
        setSegmented(group, value);
        const segment = group.querySelector<HTMLElement>(`[data-value="${value}"]`)!;
        const label = segment.querySelector<HTMLElement>('.segment-label')!.getBoundingClientRect();
        const check = segment.querySelector<SVGElement>('.segment-check')!.getBoundingClientRect();
        const box = segment.getBoundingClientRect();
        expect(getComputedStyle(segment.querySelector('.segment-check')!).visibility).toBe('visible');
        expect(label.left - check.right).toBeCloseTo(4, 0);
        expect(check.left).toBeGreaterThanOrEqual(box.left);
        // Centred on the label's (first) line.
        const lineMid = label.top + parseFloat(getComputedStyle(segment.querySelector('.segment-label')!).lineHeight) / 2;
        expect(Math.abs((check.top + check.bottom) / 2 - lineMid)).toBeLessThan(1);
      }
    }
  });

  it('never shrinks below its labels (no truncated Team | Personal)', () => {
    const group = segmented({ label: 'Save to', options, value: 'team', onSelect: () => {} });
    mountHost(h('div', { style: 'width:80px' }, group));
    for (const label of group.querySelectorAll<HTMLElement>('.segment-label')) {
      expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    }
    const [a, b] = [...group.querySelectorAll('button')].map((el) => el.getBoundingClientRect().width);
    expect(a).toBe(b);
  });
});

describe('switch', () => {
  it('is a checkbox with role=switch and reports changes', () => {
    const onChange = vi.fn();
    const el = switchInput({ checked: false, label: 'Include my microphone', onChange });
    mountHost(el);
    expect(el.type).toBe('checkbox');
    expect(el.getAttribute('role')).toBe('switch');
    expect(el.getAttribute('aria-label')).toBe('Include my microphone');
    el.click();
    expect(el.checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true, expect.any(Event));
  });

  it('a pending switch keeps focus and does not flip', () => {
    const onChange = vi.fn();
    const el = switchInput({ checked: true, label: 'Transcribe automatically', disabled: true, onChange });
    mountHost(el);
    el.focus();
    el.click();
    expect(el.checked).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(el);
  });

  it('a busy switch is aria-busy and does not flip', () => {
    const onChange = vi.fn();
    const el = switchInput({ checked: false, label: 'Include my microphone', busy: true, onChange });
    mountHost(el);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.getAttribute('aria-disabled')).toBe('true');
    el.click();
    expect(el.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('switchRow ties the label and hint to the switch', () => {
    const row = switchRow({
      id: 'auto',
      label: 'Transcribe automatically',
      hint: 'Each meeting is transcribed…',
      checked: true,
      onChange: () => {},
    });
    mountHost(row);
    const input = row.querySelector<HTMLInputElement>('input.switch')!;
    expect(input.id).toBe('auto');
    expect(row.querySelector('label')?.htmlFor).toBe('auto');
    expect(input.getAttribute('aria-describedby')).toBe('auto-hint');
    expect(row.querySelector('#auto-hint')?.textContent).toBe('Each meeting is transcribed…');
    expect(input.labels?.[0]?.textContent).toBe('Transcribe automatically');
  });
});

describe('fields', () => {
  it('wires label, message slot and hint to the input', () => {
    const f = field({ id: 'name', label: 'Name', control: textInput({ id: 'name' }), hint: 'Shown in Notion.' });
    mountHost(f);
    const input = f.querySelector<HTMLInputElement>('#name')!;
    expect(input.labels?.[0]?.textContent).toBe('Name');
    expect(input.getAttribute('aria-describedby')).toBe('name-msg name-hint');
    const slot = f.querySelector('#name-msg')!;
    expect(slot.getAttribute('role')).toBe('status');
    expect(slot.textContent).toBe('');
  });

  it('a caution message marks the field invalid; done and clearing do not', () => {
    const f = field({ id: 'db', label: 'Team database', control: textInput({ id: 'db' }) });
    mountHost(f);
    const input = f.querySelector('#db')!;
    const slot = f.querySelector<HTMLElement>('#db-msg')!;

    setFieldMessage(f, 'Paste the database link or ID from Notion.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(slot.dataset.tone).toBe('caution');
    expect(slot.querySelector('svg.glyph-caution')).not.toBeNull();
    expect(slot.textContent).toBe('Paste the database link or ID from Notion.');

    setFieldMessage(f, '“Meetings” is ready.', 'done');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(slot.querySelector('svg.glyph-done')).not.toBeNull();

    setFieldMessage(f, null);
    expect(slot.textContent).toBe('');
    expect(slot.hasAttribute('data-tone')).toBe(false);
  });

  it('an array control becomes a field-row and the id still gets described', () => {
    const f = field({
      id: 'days',
      label: 'Keep audio',
      control: [textInput({ id: 'days', type: 'number' }), h('span', null, 'days')],
    });
    expect(f.querySelector('.field-row > #days')).not.toBeNull();
    expect(f.querySelector('#days')?.getAttribute('aria-describedby')).toBe('days-msg');
  });

  it('secret inputs are password-type mono fields with a Show/Hide button', () => {
    const { row, input, toggle } = secretInput({ id: 'token', value: 'ntn_x' });
    mountHost(row);
    expect(input.type).toBe('password');
    expect(input.classList.contains('mono')).toBe(true);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(toggle.getAttribute('aria-controls')).toBe('token');
    expect(toggle.hasAttribute('aria-pressed')).toBe(false);
    toggle.click();
    expect(input.type).toBe('text');
    expect(toggle.textContent).toBe('Hide');
    toggle.click();
    expect(input.type).toBe('password');
    expect(toggle.textContent).toBe('Show');
  });
});

describe('status, facts, callouts', () => {
  it('statusLine: coloured glyph (hidden) + word + detail', () => {
    const el = statusLine({ tone: 'working', word: 'Transcribing', detail: 'Personal · pass 2 of 2' });
    expect(el.dataset.tone).toBe('working');
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('svg')?.classList.contains('glyph-working')).toBe(true);
    expect(el.querySelector('.status-word')?.textContent).toBe('Transcribing');
    expect(el.querySelector('.status-detail')?.textContent).toBe('Personal · pass 2 of 2');
    expect(statusLine({ tone: 'none', word: 'Nothing to save' }).querySelector('.glyph-dash')).not.toBeNull();
    expect(statusLine({ tone: 'done', word: 'Saved' }).querySelector('.status-detail')).toBeNull();
  });

  it('stepProgress is determinate and named "Step n of 8"', () => {
    const el = stepProgress(4);
    expect(el.max).toBe(8);
    expect(el.value).toBe(3.5);
    expect(el.getAttribute('aria-label')).toBe('Step 4 of 8');
    expect(stepProgress(1).value).toBe(0.5);
  });

  it('factList pairs dt/dd and marks caution values with ▲', () => {
    const dl = factList([
      { label: 'Speakers', value: 'Marie Curie · You' },
      { label: 'Audio', value: 'No call audio — saving captions only', detail: 'Tab audio failed.', tone: 'caution' },
    ]);
    expect([...dl.children].map((c) => c.tagName)).toEqual(['DT', 'DD', 'DT', 'DD']);
    const caution = dl.querySelectorAll('dd')[1]!;
    expect(caution.classList.contains('is-caution')).toBe(true);
    expect(caution.querySelector('.fact-value svg.glyph-caution')).not.toBeNull();
    expect(caution.querySelector('.fact-detail')?.textContent).toBe('Tab audio failed.');
    expect(dl.querySelectorAll('dd')[0]?.querySelector('svg')).toBeNull();
  });

  it('callout carries ▲, note carries ⓘ', () => {
    const c = callout({ title: 'Meetings can’t be saved to Notion yet', body: 'Add your name.', actions: button('Open settings') });
    expect(c.querySelector(':scope > svg.glyph-caution')).not.toBeNull();
    expect(c.querySelector('.callout-title')?.textContent).toBe('Meetings can’t be saved to Notion yet');
    expect(c.querySelector('.callout-actions button')).not.toBeNull();
    const n = note({ body: 'No Gemini key.' });
    expect(n.querySelector(':scope > svg.glyph-info')).not.toBeNull();
  });

  it('kbd renders the shortcut as given', () => {
    const el = kbd('Alt+Shift+R');
    expect(el.tagName).toBe('KBD');
    expect(el.textContent).toBe('Alt+Shift+R');
  });

  it('section: header labels a group; list rows become <li>', () => {
    const s = section({ title: 'Today', id: 'today', list: true, rows: [h('div', null, 'A'), null, h('div', null, 'B')] });
    expect(s.getAttribute('aria-labelledby')).toBe('today-title');
    expect(s.querySelector('h2#today-title')?.textContent).toBe('Today');
    const items = s.querySelectorAll('ul.group[role="list"] > li.group-row');
    expect(items).toHaveLength(2);
    expect(items[0]?.firstElementChild?.classList.contains('group-row')).toBe(false);
  });
});

describe('styles.css (real CSS)', () => {
  it('loads Inter and the token values', async () => {
    const el = button('Continue', { kind: 'prominent' });
    mountHost(el);
    await document.fonts.ready;
    expect(document.fonts.check('600 15px Inter')).toBe(true);
    const style = getComputedStyle(el);
    expect(style.fontFamily.startsWith('Inter')).toBe(true);
    expect(style.fontWeight).toBe('600');
    expect(style.minHeight).toBe('34px');
    // Every button is a capsule (the concentric rule).
    expect(style.borderRadius).toBe('999px');
  });

  it('never makes a control narrower than 28 px or a focus ring invisible', () => {
    const icon = iconButton('more', 'More actions');
    const plain = button('Settings', { kind: 'plain' });
    const toggle = switchInput({ checked: true, label: 'On', onChange: () => {} });
    const segments = segmented({
      label: 'Save to',
      options: [
        { value: 'team', label: 'Team' },
        { value: 'personal', label: 'Personal' },
      ],
      value: 'team',
      onSelect: () => {},
    });
    mountHost(icon, plain, toggle, segments);
    expect(icon.getBoundingClientRect().width).toBe(32);
    expect(icon.getBoundingClientRect().height).toBe(32);
    // The iOS switch metric, exactly.
    expect(toggle.getBoundingClientRect().width).toBe(51);
    expect(toggle.getBoundingClientRect().height).toBe(31);
    for (const el of [plain, ...segments.querySelectorAll<HTMLElement>('.segment')]) {
      expect(el.getBoundingClientRect().height).toBeGreaterThanOrEqual(28);
    }
    icon.focus({ focusVisible: true } as FocusOptions);
    const style = getComputedStyle(icon);
    expect(style.outlineStyle).toBe('solid');
    expect(style.outlineWidth).toBe('2px');
  });

  /* The glass budget: the three functional-layer surfaces carry a backdrop filter, and
   * nothing in the content layer does. (liquid-glass.md › Review checklist, Restraint.) */
  it('puts Liquid Glass on exactly three surfaces and never in the content layer', () => {
    const bar = h(
      'header',
      { class: 'page-bar' },
      h('div', { class: 'page-bar-inner' }, h('span', { class: 'bar-title' }, 'Meetings')),
    );
    const foot = h('nav', { class: 'popup-foot' }, button('Settings', { kind: 'plain' }));
    const menu = h('div', { class: 'menu', role: 'menu' }, h('button', { class: 'menu-item' }, 'Delete…'));
    const content = [
      h('div', { class: 'group' }, h('div', { class: 'group-row' }, 'row')),
      callout({ title: 'Setup' }),
      note({ body: 'No key' }),
      button('Continue', { kind: 'prominent' }),
      textInput({ id: 'g' }),
    ];
    mountHost(bar, foot, menu, ...content);
    const filtered = (el: Element) => getComputedStyle(el).backdropFilter !== 'none';
    expect(filtered(menu)).toBe(true);
    expect(getComputedStyle(bar, '::before').backdropFilter).not.toBe('none');
    expect(getComputedStyle(foot, '::before').backdropFilter).not.toBe('none');
    for (const el of content) {
      expect(filtered(el)).toBe(false);
      expect(getComputedStyle(el, '::before').backdropFilter).toBe('none');
    }
    // The opaque fallback exists for every one of them.
    const tokens = getComputedStyle(document.documentElement);
    expect(tokens.getPropertyValue('--glass-opaque').trim()).toMatch(/^#[0-9a-f]{6}$/i);
  });

  /* Glass only while the popup actually scrolls: a popup that fits has no scroll range,
   * its timeline is inactive and the toolbar stays the flat opaque bar. */
  it('the popup toolbar is a flat bar until the popup scrolls', async () => {
    const popup = (contentHeight: number) =>
      h(
        'div',
        { style: 'height:120px;width:220px;overflow:auto' },
        h('div', { style: `height:${contentHeight}px` }),
        h('nav', { class: 'popup-foot' }, button('Settings', { kind: 'plain' })),
      );
    const short = popup(20);
    const tall = popup(600);
    mountHost(short, tall);
    // Scroll timelines are resolved on the frame after layout.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const foot = (el: HTMLElement) => getComputedStyle(el.querySelector<HTMLElement>('.popup-foot')!);
    expect(foot(short).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(foot(short).boxShadow).not.toBe('none');
    expect(foot(tall).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  /* The bar is sticky, so the scrollport has to start below it. Without this, Shift+Tab
   * back up the page lands the focused control — ring and all — behind the glass
   * (WCAG 2.2 § 2.4.11 Focus Not Obscured). It belongs to the root, not body: that is
   * where the viewport takes its scroll padding from. */
  it('keeps the sticky page bar clear of whatever the keyboard focuses', () => {
    const previous = document.body.className;
    document.body.className = 'page page-meetings';
    try {
      const root = getComputedStyle(document.documentElement);
      const barHeight = parseFloat(root.getPropertyValue('--bar-h'));
      expect(barHeight).toBeGreaterThan(0);
      expect(parseFloat(root.scrollPaddingTop)).toBeGreaterThanOrEqual(barHeight);
    } finally {
      document.body.className = previous;
    }
  });

  /* Every mode that drops the material has to hand the boundary to a real hairline, and
   * the toolbar's can't come from ::before: the scroll-edge mask on that same box fades
   * the rim shadow away with it. Chrome can't be asked to emulate reduced transparency,
   * so the rule itself is the assertion. */
  it('gives the popup toolbar a hairline in every mode that drops the material', () => {
    const modes = new Set<string>();
    // Style rules are grouping rules too now (CSS nesting), so they are read before the
    // walk descends, not instead of it.
    const walk = (rules: CSSRuleList, condition: string): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule && /\.popup-foot(?![:\w-])/.test(rule.selectorText)) {
          const shadow = rule.style.getPropertyValue('box-shadow');
          if (shadow.includes('--glass-rim') || shadow.includes('--separator')) {
            if (condition.includes('reduced-transparency')) modes.add('reduced-transparency');
            if (condition.includes('contrast: more')) modes.add('contrast: more');
            if (condition.includes('reduced-motion')) modes.add('reduced-motion');
          }
        }
        if ('cssRules' in rule) {
          const nested = rule instanceof CSSMediaRule ? `${condition} ${rule.conditionText}` : condition;
          walk((rule as CSSGroupingRule).cssRules, nested);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules, '');
    expect([...modes].sort()).toEqual(['contrast: more', 'reduced-motion', 'reduced-transparency']);
  });

  /* The bar is transparent at rest and takes its material from a scroll-driven
   * animation, so a page that does not scroll never puts content under bare glass. */
  it('the page bar starts clear and its material is scroll-driven', () => {
    const bar = h('header', { class: 'page-bar' }, h('div', { class: 'page-bar-inner' }));
    mountHost(bar);
    const before = getComputedStyle(bar, '::before');
    expect(before.opacity).toBe('0');
    expect(before.animationName).toBe('bar-material');
    // getPropertyValue: animation-timeline is not in TypeScript's CSSStyleDeclaration yet.
    expect(before.getPropertyValue('animation-timeline')).toContain('scroll');
  });

  it('links are underlined (1 px, thicker on hover); button-styled links and plain buttons are not', () => {
    const inline = button('Allow microphone…', { kind: 'link' });
    const anchor = h('a', { href: '#x' }, 'notion.so/developers/tokens');
    const anchorButton = h('a', { href: '#y', class: 'btn' }, 'Open in Notion');
    const plain = button('Settings', { kind: 'plain' });
    mountHost(h('p', null, 'Your mic isn’t allowed yet. ', inline, ' ', anchor), anchorButton, plain);
    for (const el of [inline, anchor]) {
      const style = getComputedStyle(el);
      expect(style.textDecorationLine).toBe('underline');
      expect(style.textDecorationThickness).toBe('1px');
      expect(style.textUnderlineOffset).toBe('2px');
    }
    expect(getComputedStyle(anchorButton).textDecorationLine).toBe('none');
    expect(getComputedStyle(plain).textDecorationLine).toBe('none');
  });

  it('busy and unavailable buttons stay legible: no opacity, grey fill, --label-2 text', () => {
    const tokens = getComputedStyle(document.documentElement);
    const rgb = (token: string) => {
      const hex = tokens.getPropertyValue(token).trim().replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return `rgb(${r}, ${g}, ${b})`;
    };
    const kinds = [
      button('Checking…', { busy: true }),
      button('Starting…', { kind: 'prominent', hero: true, busy: true }),
      button('Stopping…', { kind: 'live', hero: true, busy: true }),
      button('Continue', { kind: 'prominent', disabled: true }),
    ];
    const plain = button('Pause', { kind: 'plain', busy: true });
    const group = segmented({
      label: 'Save to',
      options: [
        { value: 'team', label: 'Team' },
        { value: 'personal', label: 'Personal' },
      ],
      value: 'personal',
      busy: true,
      onSelect: () => {},
    });
    mountHost(...kinds, plain, group);
    for (const el of kinds) {
      const style = getComputedStyle(el);
      expect(style.opacity).toBe('1');
      expect(style.backgroundColor).toBe(rgb('--surface-2'));
      expect(style.color).toBe(rgb('--label-2'));
      expect(style.borderTopColor).toBe(rgb('--field-border'));
    }
    expect(getComputedStyle(kinds[0]!).cursor).toBe('progress');
    expect(getComputedStyle(kinds[3]!).cursor).toBe('default');
    expect(getComputedStyle(plain).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(plain).color).toBe(rgb('--label-2'));
    const [team, personal] = [...group.querySelectorAll<HTMLElement>('.segment')];
    expect(getComputedStyle(team!).opacity).toBe('1');
    expect(getComputedStyle(team!).color).toBe(rgb('--label-2'));
    expect(getComputedStyle(personal!).color).toBe(rgb('--label'));
    // The pressed thumb sinks to --fill-2 and keeps its ✓, ring and --label text.
    expect(getComputedStyle(personal!).backgroundColor).toBe(rgb('--fill-2'));
  });

  it('the fact list stacks labels above values when it is narrower than 18em', () => {
    const facts = () => factList([{ label: 'Speakers', value: 'Marie Curie · Tom Martin · You' }]);
    const wide = facts();
    const narrow = facts();
    mountHost(h('div', { style: 'width:328px' }, wide), h('div', { style: 'width:220px' }, narrow));
    const left = (dl: HTMLElement, tag: string) => dl.querySelector(tag)!.getBoundingClientRect().left;
    expect(left(wide, 'dd')).toBeGreaterThan(left(wide, 'dt'));
    expect(left(narrow, 'dd')).toBe(left(narrow, 'dt'));
  });

  it('inlines the per-surface files into the surface layer (no runtime @import left)', () => {
    const imports = [...document.styleSheets].flatMap((sheet) =>
      [...sheet.cssRules].filter((rule) => rule instanceof CSSImportRule),
    );
    expect(imports).toHaveLength(0);
    const layerOrder = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((rule): rule is CSSLayerStatementRule => rule instanceof CSSLayerStatementRule);
    expect(layerOrder?.nameList).toEqual(['tokens', 'reset', 'base', 'components', 'shells', 'surface']);
  });

  it('[hidden] always wins over component display rules', () => {
    const el = button('Hidden');
    el.hidden = true;
    mountHost(el);
    expect(getComputedStyle(el).display).toBe('none');
  });
});
