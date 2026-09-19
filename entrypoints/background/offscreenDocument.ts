import { browser } from 'wxt/browser';

const OFFSCREEN_PATH = '/offscreen.html';

export interface OffscreenDocument {
  /** Opens the offscreen document unless it is already open. */
  ensure(): Promise<void>;
  exists(): Promise<boolean>;
}

export function createOffscreenDocument(): OffscreenDocument {
  let creating: Promise<void> | null = null;

  async function exists(): Promise<boolean> {
    const contexts = await browser.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [browser.runtime.getURL(OFFSCREEN_PATH)],
    });
    return contexts.length > 0;
  }

  async function create(): Promise<void> {
    if (await exists()) return;
    try {
      await browser.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Record the Meet tab audio and run transcription outside the service worker.',
      });
    } catch (err) {
      // Only one offscreen document may exist; if another context won the race, we are done.
      if (!(await exists())) throw err;
    }
  }

  return {
    exists,
    ensure() {
      creating ??= create().finally(() => {
        creating = null;
      });
      return creating;
    },
  };
}
