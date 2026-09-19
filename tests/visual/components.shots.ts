/**
 * Kitchen sink of the design system: every shared component and glyph in every state
 * (focus, pending, invalid, disabled, selected), light and dark. Built with controls.ts
 * so the builders are what gets reviewed. `pnpm shots tests/visual/components.shots.ts`.
 */
import {
  button,
  callout,
  factList,
  field,
  iconButton,
  kbd,
  note,
  secretInput,
  section,
  segmented,
  setFieldMessage,
  statusLine,
  stepProgress,
  switchInput,
  switchRow,
  textInput,
  visuallyHidden,
  type Tone,
} from '@lib/ui/controls';
import { h, type Child } from '@lib/ui/dom';
import { GLYPH_NAMES, svg } from '@lib/ui/icons';
import { gallery, type Shot } from './harness';

const noop = () => {};

/** Sheet-only layout: cards in a grid, captions above each state. */
const SHEET_CSS = `
  .sheet { padding: 24px; display: grid; gap: 24px; max-width: 1200px; }
  .sheet h2.cap { font: var(--t-caption); letter-spacing: .02em; color: var(--label-2); text-transform: uppercase; margin: 0 0 8px; }
  .sheet .card { background: var(--surface); border: 1px solid var(--separator); border-radius: 12px; padding: 16px; display: grid; gap: 12px; min-width: 0; }
  .sheet .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; align-items: start; }
  .sheet .line { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .sheet .state { display: grid; gap: 4px; justify-items: start; min-width: 0; }
  .sheet .state > small { font: var(--t-caption); color: var(--label-2); }
  .sheet .state > .field { justify-self: stretch; }
  .sheet .glyphs { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 12px; }
  .sheet .glyphs div { display: grid; justify-items: center; gap: 6px; font: var(--t-caption); color: var(--label-2); }
  .sheet .glyphs .big { font-size: 32px; color: var(--label); }
  .sheet .popup-frame { width: 360px; max-width: 100%; border: 1px solid var(--separator); border-radius: 8px; overflow: hidden; }
  .sheet .w328 { width: 328px; max-width: 100%; }
  .sheet .demo-row { display: grid; grid-template-columns: minmax(0, 1fr) 236px auto; gap: 16px; align-items: start; }
  @media (width < 720px) {
    .sheet { padding: 16px; }
    .sheet .card { padding: 12px; }
    .sheet .demo-row { grid-template-columns: minmax(0, 1fr) auto; }
    .sheet .demo-row > :first-child, .sheet .demo-row > .status-line { grid-column: 1 / -1; }
    .sheet .demo-row > :last-child { grid-column: 1 / -1; justify-self: end; }
  }
`;

function state(caption: string, ...children: Child[]): HTMLElement {
  return h('div', { class: 'state' }, h('small', null, caption), ...children);
}

function card(title: string, ...children: Child[]): HTMLElement {
  return h('section', null, h('h2', { class: 'cap' }, title), h('div', { class: 'card' }, ...children));
}

function glyphs(): HTMLElement {
  const tones: [Tone, string][] = [
    ['live', 'Recording'],
    ['working', 'Transcribing'],
    ['caution', 'Couldn’t transcribe'],
    ['done', 'Saved to Notion'],
    ['neutral', 'Not transcribed'],
    ['none', 'Nothing to save'],
  ];
  return card(
    'Glyphs (inline SVG, currentColor) and status lines',
    h(
      'div',
      { class: 'glyphs' },
      GLYPH_NAMES.map((name) => h('div', null, h('span', { class: 'big' }, svg(name)), svg(name), name)),
    ),
    h(
      'div',
      { class: 'cols' },
      h(
        'div',
        { class: 'state' },
        tones.map(([tone, word]) => statusLine({ tone, word })),
      ),
      h(
        'div',
        { class: 'state' },
        statusLine({
          tone: 'working',
          word: 'Transcribing',
          detail: [h('span', null, 'Personal · pass 2 of 2'), stepProgress(4)],
        }),
        statusLine({
          tone: 'caution',
          word: 'Couldn’t transcribe',
          detail: 'Gemini is unavailable right now (503). Trying again at 16:37',
        }),
        statusLine({ tone: 'done', word: 'Saved to Notion', detail: 'Team' }),
      ),
    ),
  );
}

function type(): HTMLElement {
  return card(
    'Type (Inter, rem)',
    h('p', { class: 't-title1' }, 'Meetings — Title 1, 22/28 600'),
    h('p', { class: 't-title3' }, 'Weekly product sync — Title 3, 17/22 600'),
    h('p', { class: 't-headline' }, 'Onboarding — Lumind × Kera — Headline 14/20 600'),
    h('p', { class: 't-body' }, 'Each meeting is transcribed and saved to Notion — Body 14/20'),
    h('p', { class: 't-callout l2' }, 'Marie Curie · Tom Martin · you · qrs-tuvw-xyz — Callout 13/18'),
    h('p', { class: 't-caption l2' }, 'RECENT · ✓ Saved — Caption 12/16 500'),
    h(
      'p',
      { class: 't-body' },
      h('span', { class: 'num' }, '12:48 · 38.2 MB · step 4 of 8'),
      ' tabular, ',
      h('span', { class: 'mono' }, 'abc-defg-hij'),
      ' mono',
    ),
  );
}

function buttons(): HTMLElement {
  return card(
    'Buttons',
    h(
      'div',
      { class: 'line' },
      state('bordered', button('Open in Notion')),
      state('prominent', button('Continue', { kind: 'prominent' })),
      state('live', button('Stop recording', { kind: 'live' })),
      state('plain', button('Settings', { kind: 'plain' })),
      state('icon', iconButton('more', 'More actions for Weekly product sync')),
      state('icon, menu open', iconButton('more', 'More actions', { attrs: { 'aria-expanded': 'true' } })),
    ),
    h(
      'div',
      { class: 'line' },
      state('busy', button('Checking…', { busy: true })),
      state('prominent busy', button('Continue', { kind: 'prominent', busy: true })),
      state('live busy', button('Stopping…', { kind: 'live', busy: true })),
      state('plain unavailable', button('Pause', { kind: 'plain', disabled: true })),
      state('icon busy', iconButton('more', 'More actions', { busy: true })),
    ),
    h(
      'div',
      { class: 'cols' },
      state(
        'link in grey detail text',
        h(
          'p',
          { class: 't-callout l2 w328' },
          'Your mic isn’t allowed yet, so your voice won’t be in the recording. ',
          button('Allow microphone…', { kind: 'link' }),
        ),
      ),
      state(
        'link in a hint, link after caution text',
        h(
          'p',
          { class: 'hint' },
          'Create an internal integration at ',
          h('a', { href: '#', target: '_blank' }, 'notion.so/developers/tokens'),
          ' and paste its token here.',
        ),
        h(
          'p',
          { class: 't-callout', style: 'color:var(--caution)' },
          'Chrome blocked the microphone. ',
          button('Fix in Chrome…', { kind: 'link' }),
        ),
      ),
    ),
    h(
      'div',
      { class: 'cols' },
      state('hero prominent', h('div', { class: 'w328' }, button('Record this call', { kind: 'prominent', hero: true }))),
      state('hero live', h('div', { class: 'w328' }, button('Stop recording', { kind: 'live', hero: true }))),
      state('hero busy', h('div', { class: 'w328' }, button('Starting…', { kind: 'prominent', hero: true, busy: true }))),
    ),
  );
}

function fields(): HTMLElement {
  const name = field({
    id: 'k-name',
    label: 'Name',
    status: h('span', { class: 'saved', role: 'status' }, svg('check'), 'Saved'),
    control: textInput({ id: 'k-name', value: 'Ilya Kaplan' }),
    hint: 'Shown as “Recorded by” in Notion, and used instead of “You” in transcripts.',
  });
  const team = field({
    id: 'k-team',
    label: 'Team database',
    control: textInput({ id: 'k-team', value: 'https://www.notion.so/lumind/Meetings-0123456789abcdef' }),
  });
  setFieldMessage(team, '“Meetings” is ready.', 'done');
  const personal = field({
    id: 'k-personal',
    label: 'Personal database',
    control: textInput({ id: 'k-personal', value: 'fedcba9876543210fedcba9876543210', class: 'mono' }),
  });
  setFieldMessage(
    personal,
    'This database isn’t shared with your token. In Notion, open it and choose ••• › Connections.',
  );
  const token = secretInput({ id: 'k-token', value: 'ntn_000000000000000000000000000000' });
  const gemini = secretInput({ id: 'k-gemini', placeholder: 'Not set' }, [button('Check')]);
  const langs = field({
    id: 'k-langs',
    label: 'Languages',
    control: textInput({ id: 'k-langs', placeholder: 'Automatic' }),
    hint: 'Leave empty to detect languages automatically.',
  });
  setFieldMessage(langs, 'Gemini doesn’t list “fr-CA” for transcription. Try fr-FR, or leave this empty.', 'neutral');
  return card(
    'Text fields',
    h(
      'div',
      { class: 'cols' },
      h('div', { class: 'state' }, name),
      h('div', { class: 'state' }, team),
      h('div', { class: 'state' }, personal),
      h('div', { class: 'state' }, field({ id: 'k-token', label: 'Token', control: token.row, hint: 'Secret: mono, Show/Hide.' })),
      h('div', { class: 'state' }, field({ id: 'k-gemini', label: 'Gemini API key', control: gemini.row })),
      h('div', { class: 'state' }, langs),
      h(
        'div',
        { class: 'state' },
        field({
          id: 'k-vocab',
          label: 'Vocabulary',
          control: h('textarea', { id: 'k-vocab', class: 'input', rows: 4 }, 'Lumind\nManet\nOPFS'),
          hint: h('span', null, 'One term per line. ', h('span', { class: 'num' }, '3 of 1,000')),
        }),
      ),
      h(
        'div',
        { class: 'state' },
        field({
          id: 'k-days',
          label: 'Keep audio',
          control: [textInput({ id: 'k-days', type: 'number', value: '7', style: 'width:5rem;flex:none' }), h('span', null, 'days after saving to Notion')],
        }),
        field({
          id: 'k-sel',
          label: 'Select',
          control: h('select', { id: 'k-sel', class: 'input' }, h('option', null, 'Team'), h('option', null, 'Personal')),
        }),
      ),
      h(
        'div',
        { class: 'state' },
        h('small', null, 'radios / checkbox'),
        h(
          'div',
          { class: 'line' },
          h('label', { class: 'line' }, h('input', { type: 'radio', name: 'k-r', checked: true }), 'Team'),
          h('label', { class: 'line' }, h('input', { type: 'radio', name: 'k-r' }), 'Personal'),
          h('label', { class: 'line' }, h('input', { type: 'checkbox', checked: true }), 'Checkbox'),
        ),
      ),
    ),
  );
}

function toggles(): HTMLElement {
  const choices = [
    { value: 'team' as const, label: 'Team' },
    { value: 'personal' as const, label: 'Personal' },
  ];
  return card(
    'Switch and segmented',
    h(
      'div',
      { class: 'line' },
      state('off', switchInput({ checked: false, label: 'Off', onChange: noop })),
      state('on', switchInput({ checked: true, label: 'On', onChange: noop })),
      state('busy (keeps its colours)', switchInput({ checked: true, label: 'Busy', busy: true, onChange: noop })),
    ),
    h(
      'div',
      { class: 'group roomy', style: 'max-width:560px' },
      h(
        'div',
        { class: 'group-row' },
        switchRow({
          id: 'k-auto',
          label: 'Transcribe automatically',
          hint: 'Each meeting is transcribed and saved to Notion after you choose Team or Personal.',
          checked: true,
          onChange: noop,
        }),
      ),
    ),
    h(
      'div',
      { class: 'line' },
      state('none chosen', segmented({ label: 'Save to', options: choices, value: null, onSelect: noop })),
      state('Team', segmented({ label: 'Save to', options: choices, value: 'team', onSelect: noop })),
      state('Personal', segmented({ label: 'Save to', options: choices, value: 'personal', onSelect: noop })),
      state('busy (saving Personal)', segmented({ label: 'Save to', options: choices, value: 'personal', busy: true, onSelect: noop })),
      state('unavailable', segmented({ label: 'Save to', options: choices, value: null, disabled: true, onSelect: noop })),
    ),
    h(
      'div',
      { class: 'line' },
      ['team', 'personal'].map((value) =>
        state(
          `large, with subtitles (${value})`,
          h(
            'div',
            { style: 'width:340px;max-width:100%;display:grid' },
            segmented({
              label: 'Save this meeting to',
              large: true,
              options: [
                { value: 'team', label: 'Team', sub: 'Shared with the team', shortcut: 'T' },
                { value: 'personal', label: 'Personal', sub: 'Only you', shortcut: 'P' },
              ],
              value,
              onSelect: noop,
            }),
          ),
        ),
      ),
    ),
  );
}

function facts(width: string): HTMLElement {
  const roll = h(
    'span',
    null,
    'Marie Curie · ',
    h('span', { style: 'color:var(--label);text-decoration:underline 2px;text-underline-offset:3px' }, 'Tom Martin'),
    visuallyHidden(' (speaking)'),
    ' · You',
  );
  return h(
    'div',
    { style: `width:${width};max-width:100%` },
    factList([
      { label: 'Speakers', value: roll },
      { label: 'Audio', value: 'Call and your mic' },
      {
        label: 'Captions',
        value: 'None yet — turn on captions (CC) in Meet',
        detail: 'Without captions, the transcript can’t name who spoke.',
        tone: 'caution',
      },
      { label: 'Audio', value: 'Call only', detail: ['Your mic isn’t allowed yet. ', button('Allow microphone…', { kind: 'link' })] },
    ]),
  );
}

function blocks(): HTMLElement {
  return card(
    'Facts, callout, note, progress, kbd',
    h(
      'div',
      { class: 'cols' },
      state('fact list at 328 px (popup)', facts('328px')),
      state('fact list at 220 px (large text: stacks)', facts('220px')),
    ),
    h(
      'div',
      { class: 'cols' },
      callout({
        title: 'Meetings can’t be saved to Notion yet',
        body: 'Add your name, a Notion token and the Team database.',
        actions: button('Open settings'),
      }),
      note({
        body: 'No Gemini key: transcripts will come from Meet’s captions only.',
        actions: button('Add key'),
      }),
    ),
    h(
      'div',
      { class: 'line' },
      state('step 1 of 8', stepProgress(1)),
      state('step 4 of 8', stepProgress(4)),
      state('step 8 of 8', stepProgress(8)),
      state('kbd', h('span', { class: 't-callout l2' }, 'You’ll choose Team or Personal next. ', kbd('Alt+Shift+R'))),
    ),
  );
}

function structure(): HTMLElement {
  const row = (title: string, by: string, status: HTMLElement, action?: HTMLElement) =>
    h(
      'li',
      { class: 'demo-row' },
      h('div', null, h('p', { class: 't-headline' }, title), h('p', { class: 't-callout l2' }, by)),
      status,
      h('div', { class: 'line', style: 'justify-content:flex-end;flex-wrap:nowrap' }, action ?? null, iconButton('more', `More actions for ${title}`)),
    );
  const confirm = (busy: boolean) =>
    h(
      'li',
      { class: 'is-confirming', style: 'display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;justify-content:space-between' },
      h('p', null, 'Delete this recording, its captions and transcript? The Notion page stays.'),
      h('div', { class: 'line' }, button('Cancel', { busy }), button('Delete', { busy })),
    );
  const menu = h(
    'div',
    { class: 'menu', role: 'menu', style: 'position:static' },
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button' }, 'Transcribe again'),
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', 'data-demo': 'highlight' }, 'Save a second copy…'),
    h('hr', { class: 'menu-sep', role: 'separator' }),
    h(
      'button',
      { class: 'menu-item', role: 'menuitem', type: 'button', 'aria-disabled': 'true' },
      'Delete…',
      h('span', { class: 'menu-item-note' }, 'Wait for it to finish'),
    ),
  );
  return card(
    'Grouped section, inline confirm, menu, shells',
    section({
      title: 'Today',
      list: true,
      rows: [
        row('Pricing call with Acme', 'Marie Curie, Tom Martin, you · qrs-tuvw-xyz', statusLine({ tone: 'live', word: 'Recording' }), button('Stop recording')),
        row(
          'Design review',
          'Ilya K, Sofia · 38.2 MB audio',
          statusLine({ tone: 'working', word: 'Transcribing', detail: [h('span', null, 'Personal · step 4 of 8 · running for 3 min'), stepProgress(4)] }),
        ),
        confirm(false),
        confirm(true),
        row(
          'fff-gggg-hhh',
          'No speakers · 1.2 MB audio',
          statusLine({
            tone: 'neutral',
            word: 'Not transcribed',
            detail: segmented({
              label: 'Save to',
              options: [
                { value: 'team', label: 'Team' },
                { value: 'personal', label: 'Personal' },
              ],
              value: 'team',
              onSelect: noop,
            }),
          }),
          button('Transcribe'),
        ),
      ],
    }),
    h(
      'div',
      { class: 'cols' },
      state('menu (static render; hover/focus highlight shown on item 2)', menu),
      state(
        'popup shell (360)',
        h(
          'div',
          { class: 'popup-frame' },
          h(
            'div',
            { class: 'popup-root' },
            h('p', { class: 't-title3', style: 'display:flex;align-items:center;gap:8px;color:var(--live)' }, svg('live', { class: 'tone-live' }), 'Recording', h('span', { class: 'num', style: 'margin-left:auto;font-weight:500;color:var(--label)' }, '12:48')),
            button('Stop recording', { kind: 'live', hero: true }),
            h('nav', { class: 'popup-foot' }, button('Meetings · 1 needs you', { kind: 'plain' }), button('Settings', { kind: 'plain' })),
          ),
        ),
      ),
    ),
  );
}

function renderSheet(): void {
  document.title = 'Components';
  document.body.className = 'page page-meetings';
  const style = h('style', null, SHEET_CSS);
  const sheet = h(
    'div',
    { class: 'sheet' },
    h('header', { class: 'page-head', style: 'padding:0;margin:0' }, h('h1', null, 'Components'), h('nav', null, button('Settings', { kind: 'plain' }))),
    glyphs(),
    type(),
    buttons(),
    toggles(),
    fields(),
    blocks(),
    structure(),
  );
  document.body.replaceChildren(style, sheet);
  // Static demo of the menu highlight (real menus highlight on :hover/:focus).
  const demo = sheet.querySelector<HTMLElement>('[data-demo="highlight"]');
  if (demo) demo.style.cssText = 'background:var(--accent);color:var(--on-accent)';
  assertNoHorizontalOverflow();
}

/** Fails the shot if anything pokes past the viewport (the 390 px quality floor). */
function assertNoHorizontalOverflow(): void {
  const width = document.documentElement.clientWidth;
  const offenders = [...document.body.querySelectorAll<HTMLElement>('*')].filter((el) => {
    if (el.getBoundingClientRect().right <= width + 0.5) return false;
    return ![...el.children].some((child) => child.getBoundingClientRect().right > width + 0.5);
  });
  if (offenders.length || document.documentElement.scrollWidth > width) {
    const names = offenders.slice(0, 8).map((el) => `${el.tagName.toLowerCase()}.${el.className} "${el.textContent?.slice(0, 30)}"`);
    throw new Error(`horizontal overflow at ${width}px: ${names.join(' | ')}`);
  }
}

/** One real keyboard-focus ring per shot: :focus-visible must match, not a lookalike. */
function focusShot(name: string, build: () => HTMLElement, pick: (root: HTMLElement) => HTMLElement | null): Shot {
  return {
    name: `components-focus-${name}`,
    width: 420,
    height: 120,
    render() {
      document.body.className = 'page';
      const root = h('div', { class: 'sheet' }, h('div', { class: 'line' }, build()));
      document.body.replaceChildren(h('style', null, SHEET_CSS), root);
      const target = pick(root);
      target?.focus({ focusVisible: true } as FocusOptions);
      if (!target?.matches(':focus-visible')) throw new Error(`${name}: focus ring not visible`);
    },
  };
}

const choices = [
  { value: 'team' as const, label: 'Team' },
  { value: 'personal' as const, label: 'Personal' },
];

gallery('components', [
  { name: 'components-960', width: 960, height: 900, full: true, render: renderSheet },
  { name: 'components-390', width: 390, height: 900, full: true, render: renderSheet },
  focusShot(
    'buttons',
    () => h('div', { class: 'line' }, button('Open in Notion'), button('Continue', { kind: 'prominent' }), button('Stop recording', { kind: 'live' })),
    (root) => root.querySelector('.prominent'),
  ),
  focusShot(
    'plain-icon',
    () => h('div', { class: 'line' }, button('Settings', { kind: 'plain' }), iconButton('more', 'More actions')),
    (root) => root.querySelector('.icon'),
  ),
  focusShot(
    'field',
    () => h('div', { style: 'width:300px' }, textInput({ id: 'f', value: 'Ilya Kaplan' })),
    (root) => root.querySelector('input'),
  ),
  focusShot(
    'switch',
    () => h('div', { class: 'line' }, switchInput({ checked: true, label: 'On', onChange: noop }), switchInput({ checked: false, label: 'Off', onChange: noop })),
    (root) => root.querySelector('.switch'),
  ),
  focusShot(
    'segmented',
    () => segmented({ label: 'Save to', options: choices, value: 'team', onSelect: noop }),
    (root) => root.querySelector('.segment[data-value="personal"]'),
  ),
  focusShot(
    'link',
    () =>
      h(
        'p',
        { class: 't-callout l2', style: 'width:150px' },
        'Your mic isn’t allowed yet, so your voice won’t be in the recording. ',
        button('Allow microphone…', { kind: 'link' }),
      ),
    (root) => root.querySelector('.link'),
  ),
  focusShot(
    'busy',
    () => h('div', { style: 'width:328px' }, button('Starting…', { kind: 'prominent', hero: true, busy: true })),
    (root) => root.querySelector('.btn'),
  ),
  focusShot(
    'segmented-busy',
    () => segmented({ label: 'Save to', options: choices, value: 'personal', busy: true, onSelect: noop }),
    (root) => root.querySelector('.segment[data-value="personal"]'),
  ),
  focusShot(
    'segmented-pressed',
    () => segmented({ label: 'Save to', options: choices, value: 'team', onSelect: noop }),
    (root) => root.querySelector('.segment[data-value="team"]'),
  ),
]);
