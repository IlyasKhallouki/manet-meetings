import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '@lib/ui/styles.css';
import type { MicPermission } from '@lib/ui/mic';
import { createPermissionView } from '@lib/ui/permissionView';
import permissionHtml from '../../entrypoints/permission/index.html?raw';

const SITE_SETTINGS = 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fkhgbnfmcdfgjmfhelkfjbkaconlkehpo';

function render(state: MicPermission): HTMLElement {
  const doc = new DOMParser().parseFromString(permissionHtml, 'text/html');
  document.body.className = doc.body.className;
  const root = document.importNode(doc.getElementById('app')!, true);
  document.body.replaceChildren(root);
  createPermissionView(
    root,
    { request: () => new Promise(() => {}), query: () => Promise.resolve(state), openSiteSettings() {}, close() {} },
    SITE_SETTINGS,
  ).update(state);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
});

describe('permission page layout (real CSS)', () => {
  for (const state of ['prompt', 'denied', 'granted'] as const) {
    it(`${state}: no sideways scroll at 390 px`, async () => {
      await page.viewport(390, 700);
      render(state);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    });
  }

  it('keeps the column at 560 px including padding, 12vh from the top', async () => {
    await page.viewport(1280, 800);
    const root = render('prompt');
    expect(root.getBoundingClientRect().width).toBe(560);
    const lead = root.querySelector<HTMLElement>('.perm-lead')!;
    expect(lead.getBoundingClientRect().width).toBeLessThanOrEqual(512);
    // 12vh from the top.
    expect(Math.round(root.querySelector('.perm')!.getBoundingClientRect().top)).toBe(Math.round(800 * 0.12));
  });
});
