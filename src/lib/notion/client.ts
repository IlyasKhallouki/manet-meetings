/**
 * Minimal fetch-based Notion REST client.
 *
 * API version 2026-03-11: databases are containers of data sources; pages are created
 * under and queried through a data_source_id; trash status is `in_trash`.
 *
 * Requests on the same token share one throttle (≤ 3 starts per second, the non-Business
 * plan average) and one pause when Notion answers 429/529 with Retry-After. Server
 * errors are retried only for idempotent requests, as Notion recommends, so a retried
 * create never leaves a hidden duplicate page behind.
 *
 * Dependency-free so scripts/notion-setup.ts can import it under Node type stripping.
 */

export const NOTION_VERSION = '2026-03-11';
const API_BASE = 'https://api.notion.com/v1';
const MIN_INTERVAL_MS = 334;
const MAX_RETRIES = 5;
/** Longer waits (workspace-wide limits) fail fast; the caller can retry later. */
const MAX_RETRY_WAIT_MS = 120_000;
/** Notion itself gives up after 60 s; past this the connection is stuck. */
const REQUEST_TIMEOUT_MS = 100_000;

export class NotionError extends Error {
  /** HTTP status, 0 when Notion could not be reached. */
  readonly status: number;
  /** Notion's error code (`unauthorized`, `object_not_found`, `rate_limited`, …). */
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spaces request starts `minIntervalMs` apart; slots are reserved synchronously. */
export class Throttle {
  readonly #minIntervalMs: number;
  #next = 0;

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = minIntervalMs;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.#minIntervalMs;
    if (at > now) await sleep(at - now);
  }

  /** No request starts for the next `ms`. */
  pause(ms: number): void {
    this.#next = Math.max(this.#next, Date.now() + ms);
  }
}

/** Status 0 is a network failure. */
export function isRetryable(status: number, idempotent: boolean): boolean {
  if (status === 429 || status === 529) return true;
  return idempotent && (status === 0 || status === 409 || (status >= 500 && status <= 504));
}

/** Retry-After (seconds or HTTP date) when present, else 1 s, 2 s, 4 s … capped at 30 s. */
export function retryDelayMs(retryAfter: string | null | undefined, attempt: number): number {
  if (retryAfter != null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface NotionRequestInit {
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** Safe to repeat after a server error. Defaults to true for GET and DELETE. */
  idempotent?: boolean;
}

export interface NotionClientOptions {
  baseUrl?: string;
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

// Response shapes, reduced to the fields this extension reads. Notion adds fields
// without a version bump, so nothing here is exhaustive.
export interface NotionRichText {
  type: string;
  plain_text: string;
  text?: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; color?: string };
}

export interface NotionPropertyValue {
  id?: string;
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  date?: { start: string; end?: string | null } | null;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
}

export interface NotionPage {
  object: 'page';
  id: string;
  url: string;
  created_time: string;
  in_trash?: boolean;
  is_archived?: boolean;
  properties: Record<string, NotionPropertyValue>;
}

export interface NotionDatabase {
  object: 'database';
  id: string;
  title: NotionRichText[];
  data_sources?: Array<{ id: string; name: string }>;
  in_trash?: boolean;
}

export interface NotionDataSource {
  object: 'data_source';
  id: string;
  title: NotionRichText[];
  properties: Record<string, { id: string; name: string; type: string }>;
  parent?: { type: string; database_id?: string };
  in_trash?: boolean;
}

export interface NotionBlock {
  object: 'block';
  id: string;
  type: string;
  has_children: boolean;
  in_trash?: boolean;
  [type: string]: unknown;
}

export interface NotionList<T> {
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
}

interface ErrorBody {
  code?: string;
  message?: string;
  request_id?: string;
  additional_data?: { retry_after?: string };
}

const throttles = new Map<string, Throttle>();

export class NotionClient {
  readonly #token: string;
  readonly #base: string;
  readonly #throttle: Throttle;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(token: string, options: NotionClientOptions = {}) {
    this.#token = token.trim();
    this.#base = options.baseUrl ?? API_BASE;
    this.#maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const interval = options.minIntervalMs ?? MIN_INTERVAL_MS;
    const key = `${this.#base}\n${this.#token}\n${interval}`;
    let throttle = throttles.get(key);
    if (!throttle) {
      throttle = new Throttle(interval);
      throttles.set(key, throttle);
    }
    this.#throttle = throttle;
  }

  async request<T>(method: HttpMethod, path: string, init: NotionRequestInit = {}): Promise<T> {
    if (!this.#token) throw new NotionError(401, 'missing_token', 'No Notion integration token is set.');
    const idempotent = init.idempotent ?? (method === 'GET' || method === 'DELETE');
    const url = new URL(this.#base + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#token}`,
      'Notion-Version': NOTION_VERSION,
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }

    for (let attempt = 0; ; attempt++) {
      await this.#throttle.wait();
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (err) {
        const error =
          (err as Error)?.name === 'TimeoutError'
            ? new NotionError(0, 'timeout', `Notion did not answer within ${Math.round(this.#timeoutMs / 1000)} s.`)
            : new NotionError(0, 'network_error', `Could not reach Notion: ${String((err as Error)?.message ?? err)}`);
        if (!isRetryable(0, idempotent) || attempt >= this.#maxRetries) throw error;
        await sleep(retryDelayMs(null, attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;

      const { error, retryAfter } = await toNotionError(res);
      if (!isRetryable(res.status, idempotent) || attempt >= this.#maxRetries) throw error;
      const wait = retryDelayMs(retryAfter, attempt) + Math.random() * 250;
      if (wait > MAX_RETRY_WAIT_MS) throw error;
      if (res.status === 429 || res.status === 529) this.#throttle.pause(wait);
      else await sleep(wait);
    }
  }

  retrieveDatabase(databaseId: string): Promise<NotionDatabase> {
    return this.request('GET', `/databases/${databaseId}`);
  }

  retrieveDataSource(dataSourceId: string): Promise<NotionDataSource> {
    return this.request('GET', `/data_sources/${dataSourceId}`);
  }

  /** Every page matching `body.filter`/`body.sorts`, following cursors. */
  async queryDataSource(dataSourceId: string, body: Record<string, unknown>): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<NotionList<NotionPage>>('POST', `/data_sources/${dataSourceId}/query`, {
        body: { ...body, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
        idempotent: true,
      });
      pages.push(...res.results.filter((r) => r.object === 'page'));
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    return pages;
  }

  createPage(body: Record<string, unknown>): Promise<NotionPage> {
    return this.request('POST', '/pages', { body });
  }

  updatePage(pageId: string, body: Record<string, unknown>, idempotent = true): Promise<NotionPage> {
    return this.request('PATCH', `/pages/${pageId}`, { body, idempotent });
  }

  appendBlockChildren(blockId: string, children: unknown[]): Promise<NotionList<NotionBlock>> {
    return this.request('PATCH', `/blocks/${blockId}/children`, { body: { children } });
  }

  /** Every first-level child block, following cursors. */
  async listBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<NotionList<NotionBlock>>('GET', `/blocks/${blockId}/children`, {
        query: { page_size: '100', start_cursor: cursor },
      });
      blocks.push(...res.results);
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    return blocks;
  }
}

async function toNotionError(res: Response): Promise<{ error: NotionError; retryAfter: string | null }> {
  let parsed: ErrorBody = {};
  try {
    parsed = (await res.json()) as ErrorBody;
  } catch {
    // Proxies answer some 5xx with HTML.
  }
  const error = new NotionError(
    res.status,
    parsed.code ?? `http_${res.status}`,
    parsed.message ?? `Notion request failed (${res.status} ${res.statusText}).`,
    parsed.request_id ?? res.headers.get('x-notion-request-id') ?? undefined,
  );
  return { error, retryAfter: res.headers.get('retry-after') ?? parsed.additional_data?.retry_after ?? null };
}
