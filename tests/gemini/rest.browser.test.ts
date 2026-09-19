import { describe, expect, it } from 'vitest';
import { createInteraction, GeminiError, uploadFile, verifyApiKey } from '@lib/gemini/rest';

// Real Chrome against the real API with an invalid key. A test page enforces CORS
// (extension pages with host permissions do not), so this also proves that every
// header the client sends passes the API's CORS preflight.
const INVALID_KEY = 'manet-test-invalid-key';
const NETWORK_HINT = 'needs network access to generativelanguage.googleapis.com';

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

describe('Gemini REST in Chrome (invalid key)', () => {
  it('verifyApiKey reports the API message', async () => {
    const res = await verifyApiKey(INVALID_KEY);
    expect(!res.ok && res.error, NETWORK_HINT).toMatch(/API key not valid/);
  });

  it('createInteraction gets the API error, not a CORS failure', async () => {
    const err = await rejection(
      createInteraction(INVALID_KEY, { model: 'gemini-3.5-flash', input: 'hi', store: false }, { retries: 0 }),
    );
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).message, NETWORK_HINT).toMatch(/API key not valid/);
    expect((err as GeminiError).status).toBe(400);
  });

  it('uploadFile gets the API error, not a CORS failure', async () => {
    const blob = new Blob([new Uint8Array(16)], { type: 'audio/webm' });
    const err = await rejection(uploadFile(INVALID_KEY, blob, { mimeType: 'audio/webm', retries: 0 }));
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).message, NETWORK_HINT).toMatch(/API key not valid/);
    expect((err as GeminiError).status).toBe(400);
  });
});
