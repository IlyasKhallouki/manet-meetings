import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfigFile, parseConfigFile, serializeConfig } from '@lib/config';
import { starterProfiles } from '@lib/profiles';
import { normalizeSettings } from '@lib/settingsSchema';
import type { Settings } from '@lib/types';
import { createShareView } from '@lib/ui/shareView';

const DB = 'https://www.notion.so/Meetings-0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function setup(current: Settings = normalizeSettings({ displayName: 'Ilyas', geminiApiKey: 'gem', notionToken: 'ntn', profiles: starterProfiles(DB, '') })) {
  let stored = current;
  const handlers = {
    current: () => stored,
    apply: vi.fn(async (next: Settings) => (stored = next)),
    download: vi.fn(),
    imported: vi.fn(),
  };
  const { element } = createShareView(handlers, { now: () => NOW });
  document.body.append(element);
  const el = <T extends HTMLElement>(key: string) => element.querySelector<T>(`[data-key="${key}"]`)!;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  async function choose(text: string) {
    const input = element.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([text], 'manet-config.json', { type: 'application/json' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      const preview = element.querySelector<HTMLElement>('[data-role="import-preview"]');
      const alert = element.querySelector<HTMLElement>('[role="alert"]');
      if ((!preview || preview.hidden) && (!alert || alert.hidden)) throw new Error('not yet');
    });
  }
  return { element, handlers, el, settle, choose, stored: () => stored };
}

afterEach(() => document.body.replaceChildren());

describe('Share', () => {
  it('exports without keys unless asked', () => {
    const { el, handlers } = setup();
    el('export').click();
    const name = el<HTMLInputElement>('export-name');
    name.value = 'Acme team';
    el('export-go').click();
    const [fileName, text] = handlers.download.mock.calls[0]!;
    expect(fileName).toBe('manet-config-acme-team.json');
    const parsed = parseConfigFile(text);
    expect(parsed.ok && parsed.file.keys).toBeFalsy();
    expect(text).not.toContain('Ilyas');
  });

  it('warns when the keys go in the file, and includes them', () => {
    const { el, element, handlers } = setup();
    el('export').click();
    el<HTMLInputElement>('export-keys').click();
    expect(element.textContent).toContain('Anyone with this file can use these keys.');
    el('export-go').click();
    const parsed = parseConfigFile(handlers.download.mock.calls[0]![1]);
    expect(parsed.ok && parsed.file.keys).toEqual({ geminiApiKey: 'gem', notionToken: 'ntn' });
  });

  it('previews an import, then applies it', async () => {
    const team = normalizeSettings({ profiles: [...starterProfiles(DB, ''), { ...starterProfiles(DB)[0]!, id: 'client', name: 'Client meeting' }], retentionDays: 14 });
    const { choose, element, el, handlers, stored } = setup();
    await choose(serializeConfig(buildConfigFile(team, { name: 'Acme team', includeKeys: false, now: NOW })));
    const preview = element.querySelector('[data-role="import-preview"]')!;
    expect(preview.textContent).toContain('Import “Acme team”');
    expect(preview.textContent).toContain('New: Client meeting');
    expect(preview.textContent).toContain('Keep audio: 7 days → 14 days');
    expect(preview.textContent).toContain('API keys: not in the file, yours are kept');
    el('import-go').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(stored().profiles.map((p) => p.id)).toEqual(['team', 'personal', 'client']);
    expect(stored().displayName).toBe('Ilyas');
    expect(handlers.imported).toHaveBeenCalled();
    expect(element.textContent).toContain('Imported “Acme team”');
  });

  it('previews a default-profile change even when no shared setting changes', async () => {
    const withClient = normalizeSettings({
      profiles: [...starterProfiles(DB, ''), { ...starterProfiles(DB)[0]!, id: 'client', name: 'Client meeting' }],
      defaultProfileId: 'client',
    });
    const { choose, element } = setup();
    await choose(serializeConfig(buildConfigFile(withClient, { name: 'Acme team', includeKeys: false, now: NOW })));
    const preview = element.querySelector('[data-role="import-preview"]')!;
    expect(preview.textContent).toContain('Default profile: Team → Client meeting');
    expect(preview.textContent).not.toContain('no changes');
  });

  it('says what is wrong with a file that isn’t a config, and changes nothing', async () => {
    const { choose, element, handlers } = setup();
    await choose('{"hello": 1}');
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(
      'This file isn’t a Manet Meetings config. Choose a file exported from Settings › Share.',
    );
    expect(handlers.apply).not.toHaveBeenCalled();
  });
});
