/**
 * The glyph set: small inline SVGs drawn on a 16-unit grid, filled with currentColor so
 * CSS (and forced colors) decides their colour. Knockouts (the ✓ in done, the ! in caution,
 * the i in info) are evenodd holes, so the glyph reads on any background: surface, the
 * amber callout, the grey note or a selected segment.
 *
 * Unicode ◐ ▲ ○ ✓ render from a different fallback font on every OS; these don't.
 */

/** Path data per glyph (viewBox 0 0 16 16, fill-rule evenodd). */
export const GLYPHS = {
  /** ● Recording right now. Always --live. */
  live: 'M2.5 8a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0 -11 0Z',
  /** ◐ Starting / Transcribing / Summarizing / Saving to Notion. Always --label-2. */
  working: 'M2 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0ZM8 3.5a4.5 4.5 0 0 1 0 9Z',
  /** ▲ Needs you. Always --caution. */
  caution:
    'M6.777 3.299A1.4 1.4 0 0 1 9.223 3.299L14.242 12.319A1.4 1.4 0 0 1 13.019 14.4L2.981 14.4A1.4 1.4 0 0 1 1.758 12.319ZM7.125 5.9L7.125 9.3A0.875 0.875 0 0 0 8.875 9.3L8.875 5.9A0.875 0.875 0 0 0 7.125 5.9ZM7 11.85a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z',
  /** ✓ in a disc: saved to Notion, a check that passed. Always --done. */
  done: 'M1 8a7 7 0 1 0 14 0a7 7 0 1 0 -14 0ZM3.995 8.932L7.047 11.857L12.051 6.285A0.875 0.875 0 0 0 10.749 5.115L6.953 9.343L5.205 7.668A0.875 0.875 0 0 0 3.995 8.932Z',
  /** ○ Not transcribed. --label-2. */
  neutral: 'M2 8a6 6 0 1 0 12 0a6 6 0 1 0 -12 0ZM3.5 8a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0Z',
  /** — Nothing to save. --label-2. */
  dash: 'M3.5 9L12.5 9A1 1 0 0 0 12.5 7L3.5 7A1 1 0 0 0 3.5 9Z',
  /** ⓘ The neutral note. --label-2. */
  info: 'M1 8a7 7 0 1 0 14 0a7 7 0 1 0 -14 0ZM6.95 4.75a1.05 1.05 0 1 0 2.1 0a1.05 1.05 0 1 0 -2.1 0ZM7.125 7.4L7.125 11.6A0.875 0.875 0 0 0 8.875 11.6L8.875 7.4A0.875 0.875 0 0 0 7.125 7.4Z',
  /** ⋯ More actions (the row menu button). */
  more: 'M1.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0ZM6.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0ZM11.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0Z',
  /** The microphone (permission page tile). */
  mic: 'M5.75 3.75L5.75 7.25A2.25 2.25 0 0 0 10.25 7.25L10.25 3.75A2.25 2.25 0 0 0 5.75 3.75ZM2.5 7.5a.75 .75 0 0 1 1.5 0a4 4 0 0 0 8 0a.75 .75 0 0 1 1.5 0a5.5 5.5 0 0 1-4.75 5.45V14.5a.75 .75 0 0 1-1.5 0v-1.55A5.5 5.5 0 0 1 2.5 7.5Z',
  /** ⌄ Disclosure / pop-up chevron (points down; rotate with CSS for other directions). */
  chevron:
    'M3.684 6.816L8 11.131L12.316 6.816A0.8 0.8 0 0 0 11.184 5.684L8 8.869L4.816 5.684A0.8 0.8 0 0 0 3.684 6.816Z',
  /** ✓ bare: the selected segment, "✓ Saved", "✓ Team". */
  check:
    'M2.792 9.229L6.444 12.76L13.251 5.185A0.875 0.875 0 0 0 11.949 4.015L6.356 10.24L4.008 7.971A0.875 0.875 0 0 0 2.792 9.229Z',
} as const;

export type Glyph = keyof typeof GLYPHS;

export const GLYPH_NAMES = Object.keys(GLYPHS) as Glyph[];

export interface SvgOptions {
  /** Accessible name. Without it the glyph is decorative (aria-hidden), which is right
   *  whenever a word sits next to it — and in this UI one always should. */
  title?: string;
  /** Extra classes (the element always has `glyph glyph-<name>`). */
  class?: string;
  /** Rendered size; defaults to 1em so it follows the text. CSS may override. */
  size?: number | string;
}

const NS = 'http://www.w3.org/2000/svg';

/** svg('caution') → <svg class="glyph glyph-caution" aria-hidden="true" …>. */
export function svg(glyph: Glyph, options: SvgOptions = {}): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  const size = options.size === undefined ? '1em' : String(options.size);
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('fill', 'currentColor');
  el.setAttribute('focusable', 'false');
  el.setAttribute('class', `glyph glyph-${glyph}${options.class ? ` ${options.class}` : ''}`);
  if (options.title) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', options.title);
    const title = document.createElementNS(NS, 'title');
    title.textContent = options.title;
    el.append(title);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', GLYPHS[glyph]);
  path.setAttribute('fill-rule', 'evenodd');
  el.append(path);
  return el;
}
