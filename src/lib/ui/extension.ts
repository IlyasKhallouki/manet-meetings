/** The extension-API side of the pages: opening pages, reading state, talking to the background. */
import { browser } from 'wxt/browser';
import { sendToBackground } from '../messages';
import { getActiveRecording, getSession } from '../storage/sessionStore';
import type { PopupInput } from './popupView';
import type { FieldName } from './settingsForm';

const RESULT_PREFIX = 'result:';

/** A page, or Settings opened on one field: '/options.html#geminiApiKey' focuses the key. */
export type PagePath = '/dashboard.html' | '/permission.html' | '/options.html' | `/options.html#${FieldName}`;

/**
 * Focuses a tab that already shows the page, or opens a new one. With a #field, an open
 * Settings tab moves to the field in place (a fragment change: no reload, edits kept);
 * without one it is only brought forward.
 */
export async function openExtensionPage(path: PagePath): Promise<void> {
  const url = browser.runtime.getURL(path);
  const hash = url.indexOf('#');
  const base = hash < 0 ? url : url.slice(0, hash);
  const field = hash >= 0 && hash < url.length - 1;
  let existing: { id?: number; windowId?: number } | undefined;
  try {
    // Chrome ignores the tab's #fragment when matching, so the bare page finds it.
    [existing] = await browser.tabs.query({ url: base });
  } catch {
    existing = undefined;
  }
  if (existing?.id === undefined) {
    await browser.tabs.create({ url, active: true });
    return;
  }
  await browser.tabs.update(existing.id, field ? { active: true, url } : { active: true });
  if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true });
}

/**
 * Opens Settings, on `field` when given (Settings focuses the field the link names). For
 * the pages' "Open settings" and "Add key" buttons: openSettings('geminiApiKey').
 */
export function openSettings(field?: FieldName): Promise<void> {
  return openExtensionPage(field ? `/options.html#${field}` : '/options.html');
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
 * Starts recording `tabId` for `profileId` (the default profile when absent). Must be called
 * from the popup's click: tabCapture only works after the user invoked the extension on
 * that tab. Throws the background's reason.
 */
export async function startRecording(tabId: number, profileId?: string): Promise<string> {
  const result = await sendToBackground('session/start', profileId ? { tabId, profileId } : { tabId });
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
