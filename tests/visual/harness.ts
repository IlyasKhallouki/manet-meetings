/**
 * Shared plumbing for the screenshot gallery (`pnpm shots`): loads a page's real HTML
 * shell, sizes the viewport, switches light/dark (and forced colours, reduced motion,
 * more contrast when a shot asks) and saves PNGs to UI_SHOTS_DIR.
 * Each surface has its own *.shots.ts file listing its states.
 *
 * Every PNG is exactly the viewport: the shot's width × height, or × the content height
 * with `full`. The viewport, media features, root styles and scroll are reset before each
 * shot, so nothing carries over from the one before.
 */
import { describe, inject, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import '@lib/ui/styles.css';

declare module 'vitest' {
  export interface ProvidedContext {
    shotsDir: string;
  }
}
declare module 'vitest/browser' {
  interface BrowserCommands {
    setColorScheme(scheme: 'light' | 'dark'): Promise<void>;
    /** Playwright's page.emulateMedia (vitest.config.ts). */
    emulateMedia(media: {
      colorScheme?: 'light' | 'dark' | 'no-preference' | null;
      reducedMotion?: 'reduce' | 'no-preference' | null;
      forcedColors?: 'active' | 'none' | null;
      contrast?: 'more' | 'no-preference' | null;
    }): Promise<void>;
  }
}

export const FMT = { locale: 'en-GB', timeZone: 'Africa/Casablanca' } as const;
export const never = () => new Promise<never>(() => {});
export const ok = () => Promise.resolve();

/** Replaces the document with the page's HTML shell (minus its script) and returns #app. */
export function shell(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.title = doc.title;
  document.body.className = doc.body.className;
  document.body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  return document.getElementById('app')!;
}

/** Accessibility settings a shot can turn on (each shot starts with all of them off). */
export interface Media {
  /** Windows High Contrast / Chrome's forced colours: the system palette replaces ours. */
  forcedColors?: boolean;
  reducedMotion?: boolean;
  /** prefers-contrast: more (macOS "Increase contrast"). */
  moreContrast?: boolean;
}

export interface Shot {
  name: string;
  width: number;
  /** Viewport height; with `full`, the minimum height before growing to fit the content. */
  height: number;
  full?: boolean;
  media?: Media;
  render(): void | Promise<void>;
}

/** The same shot under other media features, saved as `<name>-<suffix>`. */
export function variant(shot: Shot, suffix: string, media: Media): Shot {
  return { ...shot, name: `${shot.name}-${suffix}`, media: { ...shot.media, ...media } };
}

/** Puts the page back as a fresh shot expects it: no root styles, scrolled to the top. */
function reset(): void {
  document.documentElement.removeAttribute('style');
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
}

/**
 * A transparent box over exactly the viewport. Screenshotting it captures what is on
 * screen at the viewport's size; screenshotting <body> would capture the whole body,
 * however tall, whatever the viewport.
 */
function viewportFrame(): HTMLElement {
  const frame = document.createElement('div');
  frame.id = 'shot-viewport';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText =
    'position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;' +
    'background:none!important;pointer-events:none!important;z-index:2147483647!important;';
  document.documentElement.append(frame);
  return frame;
}

/** Registers one test per shot and colour scheme. */
export function gallery(title: string, shots: Shot[]): void {
  const out = inject('shotsDir');
  describe(title, () => {
    for (const scheme of ['light', 'dark'] as const) {
      for (const shot of shots) {
        it(`${shot.name} (${scheme})`, async () => {
          const media = shot.media ?? {};
          await commands.emulateMedia({
            colorScheme: scheme,
            forcedColors: media.forcedColors ? 'active' : 'none',
            reducedMotion: media.reducedMotion ? 'reduce' : 'no-preference',
            contrast: media.moreContrast ? 'more' : 'no-preference',
          });
          // The last shot may have grown the viewport to its content: start from this shot's own size.
          await page.viewport(shot.width, shot.height);
          reset();
          await shot.render();
          await new Promise((r) => setTimeout(r, 150));
          if (shot.full) {
            const height = Math.max(shot.height, document.documentElement.scrollHeight);
            await page.viewport(shot.width, height);
            await new Promise((r) => requestAnimationFrame(() => r(undefined)));
          }
          const frame = viewportFrame();
          try {
            await page.screenshot({ path: `${out}/${shot.name}-${scheme}.png`, element: frame });
          } finally {
            frame.remove();
          }
        });
      }
    }
  });
}
