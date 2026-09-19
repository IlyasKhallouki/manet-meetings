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
  waitUntilActive,
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

/** Real fetch that records "METHOD path" of every request. */
function observingFetch(): { fetch: typeof fetch; seen: string[] } {
  const seen: string[] = [];
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname.replace(/^\/v1beta\//, '')}`);
      return fetch(input, init);
    },
    seen,
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
    // Not retried in place, but worth another run of the job later.
    expect((err as GeminiError).transient).toBe(true);
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

describe('waitUntilActive against the real API (invalid key)', () => {
  const file = (state?: GeminiFile['state']): GeminiFile => ({
    name: 'files/manet-wait-test',
    uri: 'https://generativelanguage.googleapis.com/v1beta/files/manet-wait-test',
    ...(state ? { state } : {}),
  });

  it('returns an ACTIVE file without a request', async () => {
    const { fetch, seen } = observingFetch();
    await expect(waitUntilActive(INVALID_KEY, file('ACTIVE'), { fetch })).resolves.toEqual(file('ACTIVE'));
    expect(seen).toEqual([]);
  });

  for (const state of [undefined, 'STATE_UNSPECIFIED', 'PROCESSING'] as const) {
    it(`treats ${state ?? 'a missing state'} as still processing, and deletes the file when polling fails`, async () => {
      const { fetch, seen } = observingFetch();
      const err = await rejection(
        waitUntilActive(INVALID_KEY, file(state), { fetch, pollIntervalMs: 1, retries: 0 }),
      );
      expect(err, NETWORK_HINT).toBeInstanceOf(GeminiError);
      expect((err as GeminiError).apiMessage).toMatch(/API key not valid/);
      expect(seen).toEqual(['GET files/manet-wait-test', 'DELETE files/manet-wait-test']);
    });
  }

  it('deletes a FAILED file before throwing', async () => {
    const { fetch, seen } = observingFetch();
    const failed = { ...file('FAILED'), error: { message: 'Unsupported audio' } };
    const err = await rejection(waitUntilActive(INVALID_KEY, failed, { fetch }));
    expect((err as GeminiError).apiStatus).toBe('FAILED');
    expect((err as GeminiError).message).toMatch(/Unsupported audio/);
    expect((err as GeminiError).transient).toBe(false);
    expect(seen).toEqual(['DELETE files/manet-wait-test']);
  });

  it('deletes a file still processing at the deadline, as a transient failure', async () => {
    const { fetch, seen } = observingFetch();
    const err = await rejection(waitUntilActive(INVALID_KEY, file('PROCESSING'), { fetch, activeTimeoutMs: -1 }));
    expect((err as GeminiError).message).toMatch(/still processing/);
    expect((err as GeminiError).transient).toBe(true);
    expect(seen).toEqual(['DELETE files/manet-wait-test']);
  });

  it('still deletes the file when the caller aborts the wait', async () => {
    const { fetch, seen } = observingFetch();
    const ctrl = new AbortController();
    const waiting = waitUntilActive(INVALID_KEY, file('PROCESSING'), { fetch, signal: ctrl.signal, pollIntervalMs: 60_000 });
    ctrl.abort(new DOMException('user cancelled', 'AbortError'));
    const err = await rejection(waiting);
    expect((err as DOMException).name).toBe('AbortError');
    expect(seen).toEqual(['DELETE files/manet-wait-test']);
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
      // The name uploadFile chose, so a lost attempt can be deleted.
      expect(file.name).toMatch(/^files\/manet-[0-9a-f]{32}$/);
      expect(file.uri).toMatch(/^https:\/\//);
      expect(file.state).toBe('ACTIVE');
      expect(Number(file.sizeBytes)).toBe(blob.size);
      expect((await getFile(API_KEY, file.name)).uri).toBe(file.uri);
    } finally {
      if (file) await expect(deleteFile(API_KEY, file.name)).resolves.toBe(true);
    }
    await expect(getFile(API_KEY, file!.name, { retries: 0 })).rejects.toBeInstanceOf(GeminiError);
  }, 120_000);

  it('deletes the file of an attempt whose finalize response was lost', async () => {
    const blob = new Blob([new Uint8Array(readFileSync(FIXTURE))], { type: 'audio/webm' });
    const names: string[] = [];
    let dropped = false;
    // Real requests; the first finalize reaches Gemini, then its response is thrown away.
    const lossy: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const command = new Headers(init?.headers).get('x-goog-upload-command') ?? '';
      if (command === 'start') names.push((JSON.parse(String(init?.body)) as { file: { name: string } }).file.name);
      const res = await fetch(input, init);
      if (command.includes('finalize') && !dropped) {
        dropped = true;
        await res.text();
        throw new TypeError('fetch failed');
      }
      return res;
    };
    const file = await uploadFile(API_KEY, blob, { mimeType: 'audio/webm', fetch: lossy, retries: 1, retryBaseDelayMs: 1 });
    try {
      expect(names).toHaveLength(2);
      expect(file.name).toBe(names[1]);
      await expect(getFile(API_KEY, names[0]!, { retries: 0 })).rejects.toBeInstanceOf(GeminiError);
    } finally {
      await deleteFile(API_KEY, file.name);
    }
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
