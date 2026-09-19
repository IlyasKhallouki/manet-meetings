/** The extension-API side of the pages: opening pages, reading state, talking to the background. */
import { browser } from 'wxt/browser';
import { sendToBackground } from '../messages';
import { getActiveRecording, getSession } from '../storage/sessionStore';
import type { PopupInput } from './popupView';

const RESULT_PREFIX = 'result:';

export type PagePath = '/dashboard.html' | '/permission.html';

/** Focuses a tab that already shows the page, or opens a new one. */
export async function openExtensionPage(path: PagePath): Promise<void> {
  const url = browser.runtime.getURL(path);
  let existing: { id?: number; windowId?: number } | undefined;
  try {
    [existing] = await browser.tabs.query({ url });
  } catch {
    existing = undefined;
  }
  if (existing?.id === undefined) {
    await browser.tabs.create({ url, active: true });
    return;
  }
  await browser.tabs.update(existing.id, { active: true });
  if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
}

/** Chrome's per-site settings for this extension, where a blocked microphone is unblocked. */
export function siteSettingsUrl(): string {
  const origin = `chrome-extension://${browser.runtime.id}`;
  return `chrome://settings/content/siteDetails?site=${encodeURIComponent(origin)}`;
}

async function storedKeys(): Promise<string[]> {
  const local = browser.storage.local;
  // getKeys arrived in Chrome 130 and the manifest allows 116.
  try {
    if (typeof local.getKeys === 'function') return await local.getKeys();
  } catch {
    // Fall back to reading everything.
  }
  return Object.keys(await local.get(null));
}

/** Sessions with a stored transcript, which Save needs. */
export async function listResultIds(): Promise<Set<string>> {
  const ids = (await storedKeys()).filter((k) => k.startsWith(RESULT_PREFIX)).map((k) => k.slice(RESULT_PREFIX.length));
  return new Set(ids);
}

/** Calls `onChange(id, present)` when a result is stored or deleted. Returns an unsubscribe. */
export function watchResultIds(onChange: (sessionId: string, present: boolean) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(RESULT_PREFIX)) continue;
      // Chrome omits newValue on removal; some implementations send null.
      onChange(key.slice(RESULT_PREFIX.length), change.newValue !== undefined && change.newValue !== null);
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

/**
 * Starts recording `tabId`. Must be called from the popup's click: tabCapture only works
 * after the user invoked the extension on that tab. Throws the background's reason.
 */
export async function startRecording(tabId: number): Promise<string> {
  const result = await sendToBackground('session/start', { tabId });
  if (!result.ok) throw new Error(result.error);
  return result.sessionId;
}

async function activeTab(): Promise<PopupInput['tab']> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;
    const out: NonNullable<PopupInput['tab']> = {};
    if (tab.id !== undefined) out.id = tab.id;
    if (tab.url !== undefined) out.url = tab.url;
    return out;
  } catch {
    return null;
  }
}

export async function loadPopupInput(): Promise<PopupInput> {
  const [tab, active] = await Promise.all([activeTab(), getActiveRecording()]);
  return { tab, active, session: active ? await getSession(active.sessionId) : null };
}
