import { describe, expect, it } from 'vitest';
import { isRetryable, NOTION_VERSION, NotionClient, NotionError, retryDelayMs, Throttle } from '@lib/notion/client';

describe('NOTION_VERSION', () => {
  it('pins the current API version (data sources, in_trash)', () => {
    expect(NOTION_VERSION).toBe('2026-03-11');
  });
});

describe('Throttle', () => {
  it('spaces request starts, including concurrent callers', async () => {
    const throttle = new Throttle(80);
    const t0 = performance.now();
    const starts = await Promise.all(
      Array.from({ length: 4 }, async () => {
        await throttle.wait();
        return performance.now() - t0;
      }),
    );
    starts.sort((a, b) => a - b);
    expect(starts[0]).toBeLessThan(40);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(75);
  });

  it('holds every caller during a pause (Retry-After)', async () => {
    const throttle = new Throttle(10);
    await throttle.wait();
    throttle.pause(200);
    const t0 = performance.now();
    await throttle.wait();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(190);
  });
});

describe('retry policy', () => {
  it('always retries rate limiting and overload', () => {
    expect(isRetryable(429, false)).toBe(true);
    expect(isRetryable(529, false)).toBe(true);
  });

  it('retries server errors only for idempotent requests', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isRetryable(status, true)).toBe(true);
      expect(isRetryable(status, false)).toBe(false);
    }
    expect(isRetryable(0, true)).toBe(true);
    expect(isRetryable(0, false)).toBe(false);
  });

  it('never retries client errors', () => {
    for (const status of [400, 401, 403, 404]) expect(isRetryable(status, true)).toBe(false);
  });

  it('honours Retry-After seconds or HTTP dates, else backs off exponentially', () => {
    expect(retryDelayMs('2', 0)).toBe(2000);
    expect(retryDelayMs('0', 3)).toBe(0);
    const at = new Date(Date.now() + 5000).toUTCString();
    expect(retryDelayMs(at, 0)).toBeGreaterThan(3000);
    expect(retryDelayMs(at, 0)).toBeLessThanOrEqual(5000);
    expect(retryDelayMs(null, 0)).toBe(1000);
    expect(retryDelayMs(null, 2)).toBe(4000);
    expect(retryDelayMs('soon', 10)).toBe(30_000);
  });
});

describe('NotionError', () => {
  it('carries status, code and request id', () => {
    const e = new NotionError(404, 'object_not_found', 'Could not find database.', 'req-1');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('NotionError');
    expect(e.status).toBe(404);
    expect(e.code).toBe('object_not_found');
    expect(e.message).toBe('Could not find database.');
    expect(e.requestId).toBe('req-1');
  });
});

// Real network, no secret needed: Notion's actual rejection of a bad token.
describe('NotionClient against the real API', () => {
  it('turns a 401 into a clean NotionError', async () => {
    const client = new NotionClient('ntn_this_token_is_not_valid');
    const error = await client.request('GET', '/users/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    const e = error as NotionError;
    expect(e.status).toBe(401);
    expect(e.code).toBe('unauthorized');
    expect(e.message).toMatch(/token/i);
    expect(e.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects an empty token without calling the API', async () => {
    const error = await new NotionClient('  ').request('GET', '/users/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).code).toBe('missing_token');
  });

  it('gives up on a request that never answers', async () => {
    // A local listener that accepts the connection but never responds.
    const { createServer } = await import('node:net');
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const client = new NotionClient('ntn_x', { baseUrl: `http://127.0.0.1:${port}/v1`, maxRetries: 0, timeoutMs: 300 });
      const error = await client.request('GET', '/users/me').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotionError);
      expect((error as NotionError).code).toBe('timeout');
    } finally {
      server.close();
    }
  });

  it('reports an unreachable host as a network error', async () => {
    const client = new NotionClient('ntn_x', { baseUrl: 'http://127.0.0.1:9/v1', maxRetries: 0 });
    const error = await client.request('GET', '/users/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotionError);
    expect((error as NotionError).status).toBe(0);
    expect((error as NotionError).code).toBe('network_error');
  });
});
