import { describe, expect, it } from 'vitest';
import readme from '../fixtures/captions/README.md?raw';
import inCallOn from '../fixtures/captions/in-call-captions-on.html?raw';

interface Capture {
  documentTitle: string;
  titleElement: { jsname: string | null } | null;
  regions: { ariaLabel: string | null }[];
  buttons: { jsname: string | null; ariaLabel: string | null; icons: string[] }[];
  toolbarHtml: string | null;
  snapshots: { t: number; html: string }[];
}

// The README tells the team to paste this snippet into a live call; keep it working.
describe('README capture snippet', () => {
  it('records the caption panel revisions, the call controls and the title', async () => {
    const code = /```js\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(code).toContain('const SECONDS = 60;');

    const page = new DOMParser().parseFromString(inCallOn, 'text/html');
    const host = document.createElement('div');
    host.append(...[...page.body.children].map((n) => document.importNode(n, true)));
    document.body.append(host);
    const previousTitle = document.title;
    document.title = page.title;
    const w = window as unknown as { __manetCapture?: Capture };
    try {
      const run = globalThis.eval(code!.replace('const SECONDS = 60;', 'const SECONDS = 0.5;')) as Promise<void>;
      await new Promise((resolve) => setTimeout(resolve, 150));
      (host.querySelector('.ygicle')!.firstChild as Text).data = 'Can everyone see my screen now?';
      await run;

      const capture = w.__manetCapture!;
      expect(capture.snapshots).toHaveLength(2);
      expect(capture.snapshots[0]!.html).toContain('Can everyone see my screen?');
      expect(capture.snapshots[1]!.html).toContain('Can everyone see my screen now?');
      expect(capture.buttons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ jsname: 'RrG0hf', ariaLabel: 'Turn off captions', icons: ['closed_caption'] }),
          expect.objectContaining({ jsname: 'CQylAd', ariaLabel: 'Leave call', icons: ['call_end'] }),
        ]),
      );
      expect(capture.toolbarHtml).toContain('jsname="CQylAd"');
      expect(capture.titleElement).toMatchObject({ jsname: 'NeC6gb' });
      expect(capture.documentTitle).toBe('Meet - Weekly product sync');
      expect(capture.regions.map((r) => r.ariaLabel)).toEqual(expect.arrayContaining(['Captions', 'Call controls']));
    } finally {
      host.remove();
      document.title = previousTitle;
      delete w.__manetCapture;
    }
  });
});
