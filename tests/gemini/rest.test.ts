import { describe, expect, it } from 'vitest';
import { GeminiError, isTransientError, parseApiError, retryAfterMs, withRetry } from '@lib/gemini/rest';

// Bodies captured from the real API with an invalid key (September 2026). The
// interactions endpoint wraps the error object in an array; the others do not.
const INTERACTIONS_BAD_KEY = `[{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT",
    "details": [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID", "domain": "googleapis.com" }
    ]
  }
}
]`;
const FILES_BAD_KEY = `{
  "error": {
    "code": 400,
    "message": "API key not valid. Please pass a valid API key.",
    "status": "INVALID_ARGUMENT"
  }
}`;
const RATE_LIMITED = JSON.stringify({
  error: {
    code: 429,
    message: 'Resource has been exhausted (e.g. check quota).',
    status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }],
  },
});

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject');
}

describe('parseApiError', () => {
  it('reads the array-wrapped error of the interactions endpoint', () => {
    expect(parseApiError(INTERACTIONS_BAD_KEY)).toEqual({
      message: 'API key not valid. Please pass a valid API key.',
      status: 'INVALID_ARGUMENT',
    });
  });

  it('reads the plain error object of the files endpoints', () => {
    expect(parseApiError(FILES_BAD_KEY).message).toBe('API key not valid. Please pass a valid API key.');
  });

  it('falls back to a trimmed body for non-JSON errors', () => {
    expect(parseApiError('<html>Bad gateway</html>')).toEqual({ message: '<html>Bad gateway</html>' });
    expect(parseApiError('x'.repeat(1000)).message.length).toBeLessThanOrEqual(300);
    expect(parseApiError('')).toEqual({ message: '' });
  });
});

describe('retryAfterMs', () => {
  it('honours Retry-After seconds and HTTP dates', () => {
    expect(retryAfterMs('5', '', 0)).toBe(5000);
    const now = Date.parse('2026-09-19T10:00:00Z');
    expect(retryAfterMs('Sat, 19 Sep 2026 10:00:30 GMT', '', now)).toBe(30_000);
  });

  it('falls back to RetryInfo in the error body', () => {
    expect(retryAfterMs(null, RATE_LIMITED, 0)).toBe(17_000);
  });

  it('is undefined when the server gives no hint', () => {
    expect(retryAfterMs(null, FILES_BAD_KEY, 0)).toBeUndefined();
    expect(retryAfterMs('soon', 'not json', 0)).toBeUndefined();
  });
});

describe('GeminiError', () => {
  it('marks 408, 429 and 5xx as retryable and other 4xx as final', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(new GeminiError('x', { status }).retryable, String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 413]) {
      expect(new GeminiError('x', { status }).retryable, String(status)).toBe(false);
    }
  });

  it('is transient when retryable unless told otherwise', () => {
    expect(new GeminiError('x', { status: 503 }).transient).toBe(true);
    expect(new GeminiError('x', { status: 0, retryable: true }).transient).toBe(true);
    expect(new GeminiError('x', { status: 400 }).transient).toBe(false);
    // A timeout is not retried in place but may work later.
    expect(new GeminiError('timed out', { status: 0, retryable: false, transient: true }).transient).toBe(true);
    expect(new GeminiError('failed', { status: 200, apiStatus: 'failed', retryable: false }).transient).toBe(false);
  });

  it('isTransientError is true only for transient GeminiErrors', () => {
    expect(isTransientError(new GeminiError('x', { status: 429 }))).toBe(true);
    expect(isTransientError(new GeminiError('x', { status: 401 }))).toBe(false);
    expect(isTransientError(new Error('bug'))).toBe(false);
    expect(isTransientError(new DOMException('stop', 'AbortError'))).toBe(false);
  });
});

describe('withRetry', () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 5 };

  it('retries retryable failures, then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new GeminiError('busy', { status: 503 });
      return 'ok';
    }, { retries: 4, ...fast });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('retries a 408 request timeout', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) throw new GeminiError('Request Timeout', { status: 408 });
      return 'ok';
    }, { retries: 2, ...fast });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  it('never retries other 4xx', async () => {
    let attempts = 0;
    const err = await rejection(
      withRetry(async () => {
        attempts++;
        throw new GeminiError('bad request', { status: 400 });
      }, { retries: 4, ...fast }),
    );
    expect(err).toBeInstanceOf(GeminiError);
    expect(attempts).toBe(1);
  });

  it('gives up after the retry budget and surfaces the last error', async () => {
    let attempts = 0;
    const err = await rejection(
      withRetry(async () => {
        attempts++;
        throw new GeminiError(`busy ${attempts}`, { status: 429 });
      }, { retries: 2, ...fast }),
    );
    expect(attempts).toBe(3);
    expect((err as GeminiError).message).toBe('busy 3');
  });

  it('waits as long as the server asks', async () => {
    let attempts = 0;
    const t0 = performance.now();
    await withRetry(async () => {
      attempts++;
      if (attempts === 1) throw new GeminiError('slow down', { status: 429, retryAfterMs: 120 });
      return 'ok';
    }, { retries: 1, ...fast });
    expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
  });

  it('does not sleep through a Retry-After longer than it is willing to wait', async () => {
    let attempts = 0;
    const err = await rejection(
      withRetry(async () => {
        attempts++;
        throw new GeminiError('daily quota', { status: 429, retryAfterMs: 3_600_000 });
      }, { retries: 3, maxRetryAfterMs: 60_000, ...fast }),
    );
    expect(attempts).toBe(1);
    expect((err as Error).message).toBe('daily quota');
  });

  it('stops when the signal aborts', async () => {
    const ctrl = new AbortController();
    let attempts = 0;
    const err = await rejection(
      withRetry(async () => {
        attempts++;
        ctrl.abort(new DOMException('stop', 'AbortError'));
        throw new GeminiError('busy', { status: 503 });
      }, { retries: 3, signal: ctrl.signal, ...fast }),
    );
    expect(attempts).toBe(1);
    expect((err as DOMException).name).toBe('AbortError');
  });
});
