/**
 * Network helpers for integration tests. Nothing here intercepts or fakes a
 * response: every request goes to the real service.
 */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The real fetch, counting what the Gemini client sends. */
export function countingFetch() {
  const counts = { requests: 0, uploads: 0, interactions: 0 };
  const counted: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    counts.requests++;
    const url = input instanceof Request ? input.url : String(input);
    if (new Headers(init?.headers).get('x-goog-upload-command') === 'start') counts.uploads++;
    if (/\/interactions(\?|$)/.test(url)) counts.interactions++;
    return fetch(input, init);
  };
  return { fetch: counted, counts };
}

/** Polls `read` until `done` or the timeout; Notion's query index lags writes by seconds. */
export async function eventually<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await sleep(1000);
  }
}
