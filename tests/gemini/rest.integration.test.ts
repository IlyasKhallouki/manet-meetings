import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRANSCRIBE_MODEL } from '@lib/gemini/models';
import {
  createInteraction,
  deleteFile,
  GeminiError,
  getFile,
  uploadFile,
  verifyApiKey,
  type GeminiFile,
} from '@lib/gemini/rest';

// Real network. The invalid-key and unreachable-server tests need no secret and
// always run; the rest needs GOOGLE_API_KEY.
const INVALID_KEY = 'manet-test-invalid-key';
const NETWORK_HINT = 'needs network access to generativelanguage.googleapis.com';
const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const FIXTURE = fileURLToPath(new URL('../fixtures/audio/speech-en.webm', import.meta.url));

/** Real fetch that counts calls, to observe retry behaviour against the real API. */
function countingFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      n++;
      return fetch(input, init);
    },
    calls: () => n,
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

describe('Gemini REST against the real API with an invalid key', () => {
  it('verifyApiKey reports the API message', async () => {
    const res = await verifyApiKey(INVALID_KEY);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error, NETWORK_HINT).toMatch(/API key not valid/);
  });

  it('verifyApiKey refuses an empty key without calling the API', async () => {
    const counter = countingFetch();
    const res = await verifyApiKey('  ', { fetch: counter.fetch });
    expect(res).toEqual({ ok: false, error: 'No API key entered.' });
    expect(counter.calls()).toBe(0);
  });

  it('createInteraction throws a GeminiError with status and message, without retrying a 400', async () => {
    const counter = countingFetch();
    const err = await rejection(
      createInteraction(INVALID_KEY, { model: 'gemini-3.5-flash', input: 'hi', store: false }, { fetch: counter.fetch }),
    );
    expect(err, NETWORK_HINT).toBeInstanceOf(GeminiError);
    const e = err as GeminiError;
    expect(e.status).toBe(400);
    expect(e.apiStatus).toBe('INVALID_ARGUMENT');
    expect(e.apiMessage).toBe('API key not valid. Please pass a valid API key.');
    expect(e.message).toContain('API key not valid');
    expect(counter.calls()).toBe(1);
  });

  it('uploadFile surfaces the upload endpoint error', async () => {
    const counter = countingFetch();
    const blob = new Blob([new Uint8Array(16)], { type: 'audio/webm' });
    const err = await rejection(uploadFile(INVALID_KEY, blob, { mimeType: 'audio/webm', fetch: counter.fetch }));
    expect(err, NETWORK_HINT).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBe(400);
    expect((err as GeminiError).apiMessage).toMatch(/API key not valid/);
    expect(counter.calls()).toBe(1);
  });

  it('deleteFile is best effort and never throws', async () => {
    await expect(deleteFile(INVALID_KEY, 'files/does-not-exist')).resolves.toBe(false);
  });

  it('reports a timeout as a non-retryable GeminiError', async () => {
    const counter = countingFetch();
    const err = await rejection(
      createInteraction(INVALID_KEY, { model: 'gemini-3.5-flash', input: 'hi' }, { fetch: counter.fetch, timeoutMs: 1 }),
    );
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBe(0);
    expect((err as GeminiError).message).toMatch(/timed out/);
    expect(counter.calls()).toBe(1);
  });

  it('rejects with the abort reason when the caller aborts', async () => {
    const counter = countingFetch();
    const ctrl = new AbortController();
    ctrl.abort(new DOMException('user cancelled', 'AbortError'));
    const err = await rejection(
      createInteraction(INVALID_KEY, { model: 'gemini-3.5-flash', input: 'hi' }, { fetch: counter.fetch, signal: ctrl.signal }),
    );
    expect((err as DOMException).name).toBe('AbortError');
    expect(counter.calls()).toBe(0);
  });
});

describe('Gemini REST when the server is unreachable', () => {
  // Port 9 (discard) on loopback refuses connections: a real network failure.
  const unreachable = { baseUrl: 'http://127.0.0.1:9' };

  it('verifyApiKey explains that Gemini could not be reached', async () => {
    const res = await verifyApiKey('some-key', unreachable);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/Could not reach Gemini/);
  });

  it('createInteraction retries connection failures before giving up', async () => {
    const counter = countingFetch();
    const err = await rejection(
      createInteraction('some-key', { model: 'x', input: 'hi' }, {
        ...unreachable,
        fetch: counter.fetch,
        retries: 2,
        retryBaseDelayMs: 1,
      }),
    );
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBe(0);
    expect((err as GeminiError).retryable).toBe(true);
    expect(counter.calls()).toBe(3);
  });
});

describe.skipIf(!API_KEY)('Gemini REST with a real key (needs GOOGLE_API_KEY)', () => {
  it('verifyApiKey accepts the key', async () => {
    await expect(verifyApiKey(API_KEY)).resolves.toEqual({ ok: true });
  });

  it('uploads audio, finds it ACTIVE, and deletes it', async () => {
    const blob = new Blob([new Uint8Array(readFileSync(FIXTURE))], { type: 'audio/webm' });
    let file: GeminiFile | undefined;
    try {
      file = await uploadFile(API_KEY, blob, { mimeType: 'audio/webm', displayName: 'manet-rest-test' });
      expect(file.name).toMatch(/^files\//);
      expect(file.uri).toMatch(/^https:\/\//);
      // uploadFile waits out PROCESSING; audio may come back ACTIVE or without a state.
      expect(['ACTIVE', undefined]).toContain(file.state);
      expect(Number(file.sizeBytes)).toBe(blob.size);
      expect((await getFile(API_KEY, file.name)).uri).toBe(file.uri);
    } finally {
      if (file) await expect(deleteFile(API_KEY, file.name)).resolves.toBe(true);
    }
    await expect(getFile(API_KEY, file!.name, { retries: 0 })).rejects.toBeInstanceOf(GeminiError);
  }, 120_000);

  it('does not retry a 4xx from a real request (unknown model)', async () => {
    const counter = countingFetch();
    const err = await rejection(
      createInteraction(API_KEY, { model: 'manet-no-such-model', input: 'hi', store: false }, { fetch: counter.fetch }),
    );
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).status).toBeGreaterThanOrEqual(400);
    expect((err as GeminiError).status).toBeLessThan(500);
    expect(counter.calls()).toBe(1);
  });

  it('confirms the API refuses custom_vocabulary together with word timestamps', async () => {
    const blob = new Blob([new Uint8Array(readFileSync(FIXTURE))], { type: 'audio/webm' });
    const file = await uploadFile(API_KEY, blob, { mimeType: 'audio/webm' });
    try {
      // Built by hand on purpose: the request builders refuse this combination.
      const err = await rejection(
        createInteraction(API_KEY, {
          model: TRANSCRIBE_MODEL,
          input: [{ type: 'audio', uri: file.uri, mime_type: 'audio/webm' }],
          generation_config: {
            transcription_config: {
              custom_vocabulary: ['Sherlock Holmes'],
              mode: { type: 'verbatim', timestamp_granularities: ['word'] },
            },
          },
          store: false,
        }),
      );
      expect(err).toBeInstanceOf(GeminiError);
      expect((err as GeminiError).status).toBe(400);
    } finally {
      await deleteFile(API_KEY, file.name);
    }
  }, 120_000);
});
