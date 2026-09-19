import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createOffscreenDocument } from '@/entrypoints/background/offscreenDocument';

// chrome.offscreen and runtime.getContexts are not implemented by fakeBrowser.
function stubOffscreenApi(opts: { exists?: boolean; createError?: string } = {}) {
  let open = opts.exists ?? false;
  const createDocument = vi.spyOn(fakeBrowser.offscreen, 'createDocument').mockImplementation((async () => {
    await new Promise((r) => setTimeout(r, 5));
    if (opts.createError) throw new Error(opts.createError);
    if (open) throw new Error('Only a single offscreen document may be created.');
    open = true;
  }) as never);
  const getContexts = vi.spyOn(fakeBrowser.runtime, 'getContexts').mockImplementation((async () =>
    open
      ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: fakeBrowser.runtime.getURL('/offscreen.html') }]
      : []) as never);
  return {
    createDocument,
    getContexts,
    open: (v: boolean) => {
      open = v;
    },
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('offscreen document', () => {
  it('creates the document for user media and blobs', async () => {
    const api = stubOffscreenApi();
    const doc = createOffscreenDocument();
    expect(await doc.exists()).toBe(false);
    await doc.ensure();
    expect(await doc.exists()).toBe(true);
    expect(api.createDocument).toHaveBeenCalledTimes(1);
    expect(api.createDocument.mock.calls[0]?.[0]).toMatchObject({
      url: '/offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'],
    });
    expect(api.getContexts.mock.calls[0]?.[0]).toEqual({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: ['chrome-extension://test-extension-id/offscreen.html'],
    });
  });

  it('creates the document once when asked concurrently', async () => {
    const api = stubOffscreenApi();
    const doc = createOffscreenDocument();
    await Promise.all([doc.ensure(), doc.ensure(), doc.ensure()]);
    expect(api.createDocument).toHaveBeenCalledTimes(1);
  });

  it('reuses a document that already exists', async () => {
    const api = stubOffscreenApi({ exists: true });
    await createOffscreenDocument().ensure();
    expect(api.createDocument).not.toHaveBeenCalled();
  });

  it('accepts losing a creation race to another context', async () => {
    const api = stubOffscreenApi();
    // Another context opens the document between our check and our create call.
    api.getContexts.mockImplementationOnce((async () => {
      api.open(true);
      return [];
    }) as never);
    await expect(createOffscreenDocument().ensure()).resolves.toBeUndefined();
    expect(api.createDocument).toHaveBeenCalledTimes(1);
  });

  it('surfaces real creation errors and retries on the next call', async () => {
    const api = stubOffscreenApi({ createError: 'boom' });
    const doc = createOffscreenDocument();
    await expect(doc.ensure()).rejects.toThrow('boom');
    api.createDocument.mockImplementation((async () => {
      api.open(true);
    }) as never);
    await doc.ensure();
    expect(api.createDocument).toHaveBeenCalledTimes(2);
  });
});
