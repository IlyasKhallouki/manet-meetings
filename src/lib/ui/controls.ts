/**
 * Shared controls: thin builders over h() that emit the class vocabulary documented at
 * the top of styles.css, with the ARIA each control needs. Surfaces compose these; they
 * never restyle them (per-surface CSS adjusts layout, not what a control looks like).
 *
 * Busy and unavailable controls use aria-disabled="true", never the disabled attribute:
 * a disabled button drops keyboard focus to <body> (review C4). Every builder guards its
 * handler, and guard() does the same for hand-built elements.
 *
 * Busy (a request this control started is running: "Starting…", "Checking…", a segment
 * or switch whose change is being saved) is aria-busy="true" plus aria-disabled="true":
 * setBusy() or the `busy` option. It looks grey and stays legible (≥ 4.5:1), because
 * focus stays on it and its label is the only feedback. Unavailable (setDisabled, the
 * `disabled` option) is aria-disabled alone.
 */
import { h, type Attrs, type Child } from './dom';
import { svg, type Glyph } from './icons';

type Children = Child | Child[];

// ---------------------------------------------------------------------------------------
// Inert state

/** True while the element is busy, aria-disabled or natively disabled. */
export function isInert(el: EventTarget | null): boolean {
  return (
    el instanceof Element &&
    (el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('aria-busy') === 'true' ||
      (el as HTMLButtonElement).disabled === true)
  );
}

/** Marks a control unavailable without taking its focus away. */
export function setDisabled(el: Element, disabled: boolean): void {
  if (disabled) el.setAttribute('aria-disabled', 'true');
  else el.removeAttribute('aria-disabled');
}

/**
 * Marks a control busy while a request it started runs (aria-busy + aria-disabled): it
 * ignores activation, keeps focus, and shows grey with a legible label and a progress
 * cursor. Clearing it clears both attributes.
 */
export function setBusy(el: Element, busy: boolean): void {
  if (busy) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
  setDisabled(el, busy);
}

/** Wraps a handler so it does nothing while its element is aria-disabled. */
export function guard<E extends Event>(handler: (event: E) => void): (event: E) => void {
  return (event) => {
    if (isInert(event.currentTarget)) {
      event.preventDefault();
      return;
    }
    handler(event);
  };
}

// ---------------------------------------------------------------------------------------
// Buttons

/**
 * Every button is a capsule (the concentric rule: an inset control inside an r18 row
 * would fall under an 8 px radius, so it becomes a capsule instead).
 * bordered — the default next step (--fill, 3:1 outline, 34 px).
 * prominent — the ONE filled navy button per view (Record this call, Continue, default route).
 * live — Stop recording (red fill). Red means recording, nothing else.
 * plain — text-only tint button in bars and footers (Meetings, Settings, Pause), 30 px.
 * link — inline, inside a sentence ("Allow microphone…"): tint and underlined.
 */
export type ButtonKind = 'bordered' | 'prominent' | 'live' | 'plain' | 'link';

export interface ButtonOptions {
  kind?: ButtonKind;
  /** 48 px, full width, 17/600: the popup's one big button. */
  hero?: boolean;
  onClick?: (event: MouseEvent) => void;
  /** Unavailable: aria-disabled (focus stays); the click handler is skipped. */
  disabled?: boolean;
  /** Busy: its request is running (aria-busy + aria-disabled); see setBusy(). */
  busy?: boolean;
  class?: string;
  /** Any other attributes: data-key, data-role, aria-*, title… */
  attrs?: Attrs;
}

function classes(...names: (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

export function button(label: Children, options: ButtonOptions = {}): HTMLButtonElement {
  const kind = options.kind ?? 'bordered';
  const el = h(
    'button',
    {
      type: 'button',
      ...options.attrs,
      class: classes(
        kind === 'link' ? 'link' : 'btn',
        kind !== 'bordered' && kind !== 'link' && kind,
        options.hero && 'hero',
        options.class,
        options.attrs?.class as string | undefined,
      ),
    },
    label,
  );
  if (options.disabled) setDisabled(el, true);
  if (options.busy) setBusy(el, true);
  const onClick = options.onClick;
  if (onClick) el.addEventListener('click', guard<MouseEvent>(onClick));
  return el;
}

export interface IconButtonOptions extends Omit<ButtonOptions, 'kind' | 'hero'> {
  /** Tooltip; defaults to the accessible label. */
  tooltip?: string | null;
}

/** 32×32 round glyph-only button (the ⋯ menu button). `label` is its accessible name. */
export function iconButton(glyph: Glyph, label: string, options: IconButtonOptions = {}): HTMLButtonElement {
  const tooltip = options.tooltip === undefined ? label : options.tooltip;
  return button(svg(glyph), {
    ...options,
    class: classes('icon', options.class),
    attrs: { 'aria-label': label, title: tooltip ?? undefined, ...options.attrs },
  });
}

// ---------------------------------------------------------------------------------------
// Glyph + word

/** Status tones → glyph. Only the glyph is coloured; the word stays --label. */
export type Tone = 'live' | 'working' | 'caution' | 'done' | 'neutral' | 'none';

const TONE_GLYPH: Record<Tone, Glyph> = {
  live: 'live',
  working: 'working',
  caution: 'caution',
  done: 'done',
  neutral: 'neutral',
  none: 'dash',
};

export function toneGlyph(tone: Tone, title?: string): SVGSVGElement {
  return svg(TONE_GLYPH[tone], { class: `tone-${tone}`, title });
}

export interface StatusLineOptions {
  tone: Tone;
  word: Children;
  /** Second line(s): destination, stage, error detail. --label-2, 13/18 footnote. */
  detail?: Children;
  attrs?: Attrs;
}

/** ◐ Transcribing / Personal · pass 2 of 2 — glyph + word, then detail. */
export function statusLine({ tone, word, detail, attrs }: StatusLineOptions): HTMLDivElement {
  const hasDetail = detail !== undefined && detail !== null && detail !== false;
  return h(
    'div',
    { ...attrs, class: classes('status-line', attrs?.class as string | undefined), 'data-tone': tone },
    h('span', { class: 'status-head' }, toneGlyph(tone), h('span', { class: 'status-word' }, word)),
    hasDetail ? h('span', { class: 'status-detail' }, detail) : null,
  );
}

/** Text only screen readers get ("speaking", "(opens Settings)"). */
export function visuallyHidden(text: string): HTMLSpanElement {
  return h('span', { class: 'visually-hidden' }, text);
}

// ---------------------------------------------------------------------------------------
// Segmented control (Team | Personal)

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
  /** Second line in the large variant ("Shared with the team"). */
  sub?: string;
  /** aria-keyshortcuts, e.g. "T". */
  shortcut?: string;
  attrs?: Attrs;
}

export interface SegmentedOptions<V extends string> {
  /** Accessible name of the group, unless labelledBy names a visible label. */
  label?: string;
  labelledBy?: string;
  options: SegmentOption<V>[];
  /** The pressed segment; null when nothing is chosen yet. */
  value: V | null;
  /** Activation (click, Enter, Space) commits. Arrow keys only move focus. */
  onSelect: (value: V, event: Event) => void;
  disabled?: boolean;
  /** Every segment busy while the choice is being saved (see setBusy()). */
  busy?: boolean;
  /** 56 px segments with a subtitle. */
  large?: boolean;
  attrs?: Attrs;
}

/**
 * Two or more aria-pressed buttons in a role=group track. Not radios: arrow keys on a
 * radio group change the selection, which here would commit a choice on every key
 * press. The builder never flips aria-pressed itself;
 * the owner calls setSegmented() once the choice is committed.
 */
export function segmented<V extends string>(o: SegmentedOptions<V>): HTMLDivElement {
  const group = h('div', {
    role: 'group',
    'aria-label': o.labelledBy ? undefined : o.label,
    'aria-labelledby': o.labelledBy,
    ...o.attrs,
    class: classes('segmented', o.large && 'large', o.attrs?.class as string | undefined),
  });
  for (const option of o.options) {
    const segment = h(
      'button',
      {
        type: 'button',
        ...option.attrs,
        class: 'segment',
        'data-value': option.value,
        'aria-pressed': String(option.value === o.value),
        'aria-keyshortcuts': option.shortcut,
        'aria-disabled': o.disabled || o.busy ? 'true' : undefined,
        'aria-busy': o.busy ? 'true' : undefined,
      },
      // The ✓ hangs off the label's leading edge (styles.css), so "✓ Team" reads as one
      // thing in any segment width; the segment's symmetric padding keeps its room.
      h('span', { class: 'segment-label' }, svg('check', { class: 'segment-check' }), option.label),
      option.sub ? h('span', { class: 'segment-sub' }, option.sub) : null,
    );
    segment.addEventListener(
      'click',
      guard((event) => o.onSelect(option.value, event)),
    );
    group.append(segment);
  }
  group.addEventListener('keydown', (event) => moveFocus(group, event));
  return group;
}

function moveFocus(group: HTMLElement, event: KeyboardEvent): void {
  const segments = [...group.querySelectorAll<HTMLButtonElement>(':scope > .segment')];
  const current = segments.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0) return;
  const last = segments.length - 1;
  const next =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? current === last ? 0 : current + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? current === 0 ? last : current - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : -1;
  if (next < 0) return;
  event.preventDefault();
  segments[next]?.focus();
}

/** Presses the segment with `value` (null: none) and releases the others. */
export function setSegmented(group: Element, value: string | null): void {
  for (const segment of group.querySelectorAll<HTMLElement>(':scope > .segment')) {
    segment.setAttribute('aria-pressed', String(segment.dataset.value === value));
  }
}

// ---------------------------------------------------------------------------------------
// Switch

export interface SwitchOptions {
  checked: boolean;
  onChange: (checked: boolean, event: Event) => void;
  id?: string;
  /** Accessible name when no <label for> points at the switch. */
  label?: string;
  describedBy?: string;
  disabled?: boolean;
  /** Its change is being saved (see setBusy()). */
  busy?: boolean;
  attrs?: Attrs;
}

/** <input type=checkbox role=switch class=switch>, 51×31 — the iOS metric, exactly. */
export function switchInput(o: SwitchOptions): HTMLInputElement {
  const input = h('input', {
    type: 'checkbox',
    role: 'switch',
    id: o.id,
    'aria-label': o.label,
    'aria-describedby': o.describedBy,
    'aria-disabled': o.disabled || o.busy ? 'true' : undefined,
    'aria-busy': o.busy ? 'true' : undefined,
    ...o.attrs,
    class: classes('switch', o.attrs?.class as string | undefined),
  });
  input.checked = o.checked;
  // preventDefault on click reverts the toggle, so a busy or unavailable switch can't flip.
  input.addEventListener(
    'click',
    guard(() => {}),
  );
  input.addEventListener('change', (event) => o.onChange(input.checked, event));
  return input;
}

export interface SwitchRowOptions extends Omit<SwitchOptions, 'label' | 'describedBy' | 'id'> {
  id: string;
  label: Children;
  hint?: Children;
  /** Extra content under the hint (a mic status line…). */
  extra?: Children;
}

/** A settings-style row: label + hint on the leading side, the switch trailing. */
export function switchRow(o: SwitchRowOptions): HTMLDivElement {
  const hintId = o.hint ? `${o.id}-hint` : undefined;
  // The row's <label for> names the switch, so no aria-label is passed down.
  const { label: _label, hint: _hint, extra: _extra, ...rest } = o;
  return h(
    'div',
    { class: 'switch-row' },
    h(
      'div',
      { class: 'switch-row-text' },
      h('label', { class: 'field-label', for: o.id }, o.label),
      o.hint ? h('p', { class: 'hint', id: hintId }, o.hint) : null,
      o.extra ?? null,
    ),
    switchInput({ ...rest, describedBy: hintId }),
  );
}

// ---------------------------------------------------------------------------------------
// Text fields

export interface FieldOptions {
  id: string;
  label: Children;
  /** The input(s). A single input or a row [input, Show, Check] (wrapped in .field-row). */
  control: HTMLElement | HTMLElement[];
  hint?: Children;
  /** Slot beside the label: the per-field "✓ Saved" (role=status). */
  status?: Children;
  attrs?: Attrs;
}

/**
 * label (+ status) / control / message slot / hint. The input whose id matches gets
 * aria-describedby → message + hint. The message slot is a polite live region that
 * setFieldMessage() fills: ▲ caution (sets aria-invalid), ✓ done, or ⓘ neutral.
 */
export function field(o: FieldOptions): HTMLDivElement {
  const msgId = `${o.id}-msg`;
  const hintId = `${o.id}-hint`;
  const controls = Array.isArray(o.control) ? o.control : [o.control];
  const input = controls.flatMap((c) => (c.id === o.id ? [c] : [...c.querySelectorAll<HTMLElement>(`#${CSS.escape(o.id)}`)]))[0];
  input?.setAttribute('aria-describedby', o.hint ? `${msgId} ${hintId}` : msgId);
  return h(
    'div',
    { ...o.attrs, class: classes('field', o.attrs?.class as string | undefined) },
    h(
      'div',
      { class: 'field-head' },
      h('label', { class: 'field-label', for: o.id }, o.label),
      o.status ?? null,
    ),
    Array.isArray(o.control) ? h('div', { class: 'field-row' }, controls) : o.control,
    h('p', { class: 'field-msg', id: msgId, role: 'status' }),
    o.hint ? h('p', { class: 'hint', id: hintId }, o.hint) : null,
  );
}

export type MessageTone = 'caution' | 'done' | 'neutral';

const MESSAGE_GLYPH: Record<MessageTone, Glyph> = { caution: 'caution', done: 'done', neutral: 'info' };

/** Shows (or clears, with null) the message under a field built by field(). */
export function setFieldMessage(fieldEl: Element, message: Children | null, tone: MessageTone = 'caution'): void {
  const slot = fieldEl.querySelector<HTMLElement>(':scope > .field-msg');
  if (!slot) return;
  const id = slot.id.replace(/-msg$/, '');
  const input = fieldEl.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (message === null || message === undefined || message === false) {
    slot.replaceChildren();
    delete slot.dataset.tone;
    input?.removeAttribute('aria-invalid');
    return;
  }
  slot.dataset.tone = tone;
  slot.replaceChildren(svg(MESSAGE_GLYPH[tone], { class: `tone-${tone}` }), h('span', null, message));
  if (tone === 'caution') input?.setAttribute('aria-invalid', 'true');
  else input?.removeAttribute('aria-invalid');
}

/** <input class="input">; pass `class: 'input mono'` for codes. */
export function textInput(attrs: Attrs = {}): HTMLInputElement {
  return h('input', {
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    ...attrs,
    class: classes('input', attrs.class as string | undefined),
  });
}

export interface SecretFieldParts {
  row: HTMLDivElement;
  input: HTMLInputElement;
  toggle: HTMLButtonElement;
}

/**
 * A password-type mono input + a Show/Hide button. The visible label is the action
 * ("Show" / "Hide"), so the button carries no aria-pressed (a toggle whose name
 * changes with its state reads twice as confusing).
 */
export function secretInput(attrs: Attrs & { id: string }, extra: HTMLElement[] = []): SecretFieldParts {
  const input = textInput({
    ...attrs,
    type: 'password',
    class: classes('mono', attrs.class as string | undefined),
  });
  const toggle = button('Show', {
    class: 'secret-toggle',
    attrs: { 'aria-controls': attrs.id },
    onClick: () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? 'Show' : 'Hide';
    },
  });
  const row = h('div', { class: 'field-row' }, input, toggle, extra);
  return { row, input, toggle };
}

// ---------------------------------------------------------------------------------------
// Fact list

export interface Fact {
  label: string;
  value: Children;
  /** Explanation under the value, --label-2. */
  detail?: Children;
  /** caution: ▲ + caution colour on the value line (the detail stays --label-2). */
  tone?: 'caution';
  attrs?: Attrs;
}

/**
 * dt/dd pairs in two columns (72 px labels); below ~18em of its own width (large text)
 * each label stacks above its value (container query in styles.css).
 */
export function factList(facts: Fact[], attrs: Attrs = {}): HTMLDListElement {
  const dl = h('dl', { ...attrs, class: classes('facts', attrs.class as string | undefined) });
  for (const fact of facts) {
    const hasDetail = fact.detail !== undefined && fact.detail !== null && fact.detail !== false;
    dl.append(
      h('dt', null, fact.label),
      h(
        'dd',
        { ...fact.attrs, class: classes(fact.tone === 'caution' && 'is-caution', fact.attrs?.class as string | undefined) },
        h('span', { class: 'fact-value' }, fact.tone === 'caution' ? svg('caution') : null, h('span', null, fact.value)),
        hasDetail ? h('span', { class: 'fact-detail' }, fact.detail) : null,
      ),
    );
  }
  return dl;
}

// ---------------------------------------------------------------------------------------
// Callout and note

export interface CalloutOptions {
  title: Children;
  body?: Children;
  actions?: Children;
  attrs?: Attrs;
}

/** The one tinted block: ▲ + title + body + actions on --caution-weak (setup blocked). */
export function callout(o: CalloutOptions): HTMLDivElement {
  return h(
    'div',
    { ...o.attrs, class: classes('callout', o.attrs?.class as string | undefined) },
    svg('caution'),
    h('p', { class: 'callout-title' }, o.title),
    o.body ? h('p', { class: 'callout-body' }, o.body) : null,
    o.actions ? h('div', { class: 'callout-actions' }, o.actions) : null,
  );
}

export interface NoteOptions {
  body: Children;
  actions?: Children;
  attrs?: Attrs;
}

/** ⓘ neutral information on --fill (No Gemini key…). */
export function note(o: NoteOptions): HTMLDivElement {
  return h(
    'div',
    { ...o.attrs, class: classes('note', o.attrs?.class as string | undefined) },
    svg('info'),
    h('p', { class: 'note-body' }, o.body),
    o.actions ? h('div', { class: 'callout-actions' }, o.actions) : null,
  );
}

// ---------------------------------------------------------------------------------------
// Progress, kbd

/** Determinate 92×5 capsule bar. */
export function progress(value: number, max: number, label: string, attrs: Attrs = {}): HTMLProgressElement {
  const el = h('progress', {
    ...attrs,
    class: classes('progress', attrs.class as string | undefined),
    max,
    'aria-label': label,
  });
  el.value = value;
  return el;
}

/** Pipeline step n of 8, drawn half a step in so step 1 isn't empty and step 8 isn't full. */
export function stepProgress(step: number, total = 8, attrs: Attrs = {}): HTMLProgressElement {
  return progress(Math.max(0, step - 0.5), total, `Step ${step} of ${total}`, attrs);
}

/** The keyboard shortcut from commands.getAll(), e.g. "Alt+Shift+R" or "⌥⇧R". */
export function kbd(shortcut: string): HTMLElement {
  return h('kbd', { class: 'kbd' }, shortcut);
}

// ---------------------------------------------------------------------------------------
// Grouped sections

export interface SectionOptions {
  /** Header above the group (13/18 600 --label-2, inset 16 px). Omit for a bare group. */
  title?: Children;
  id?: string;
  /** The rows. Pass `list: true` to get <ul>/<li> semantics (Meetings). */
  rows: (HTMLElement | null | false)[];
  list?: boolean;
  attrs?: Attrs;
}

/** Header + inset grouped card with hairlines between rows. Rows get .group-row. */
export function section(o: SectionOptions): HTMLElement {
  const headerId = o.title && o.id ? `${o.id}-title` : undefined;
  const group = h(o.list ? 'ul' : 'div', { class: 'group', role: o.list ? 'list' : undefined });
  for (const row of o.rows) {
    if (!row) continue;
    const item = o.list && row.tagName !== 'LI' ? h('li', null, row) : row;
    item.classList.add('group-row');
    group.append(item);
  }
  return h(
    'section',
    {
      id: o.id,
      'aria-labelledby': headerId,
      ...o.attrs,
      class: classes('section', o.attrs?.class as string | undefined),
    },
    o.title ? h('h2', { class: 'section-header', id: headerId }, o.title) : null,
    group,
  );
}
