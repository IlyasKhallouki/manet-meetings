/**
 * Minimal Gemini REST client over fetch: Files API resumable upload and the
 * Interactions API. Works in the offscreen document (host permission makes the
 * upload-URL response header readable) and in Node.
 */
import { GEMINI_API_VERSION, GEMINI_BASE_URL } from './models';
import { parseOffsetMs, type Interaction } from './response';

export interface RestOptions {
  signal?: AbortSignal;
  /** Per HTTP request, including reading the body. */
  timeoutMs?: number;
  /** Extra attempts after the first for 429, 5xx and connection failures. */
  retries?: number;
  retryBaseDelayMs?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Request shapes (subset of the Interactions API schema we send)
// ---------------------------------------------------------------------------

export interface VerbatimMode {
  type: 'verbatim';
  timestamp_granularities?: 'word'[];
  diarization_mode?: 'speaker';
}

export interface TranscriptionConfig {
  mode?: VerbatimMode | 'verbatim' | 'smart' | { type: 'smart' };
  language_codes?: string[];
  custom_vocabulary?: string[];
}

export interface AudioInput {
  type: 'audio';
  uri: string;
  mime_type: string;
}

export interface TextResponseFormat {
  type: 'text';
  mime_type: 'application/json' | 'text/plain';
  schema?: Record<string, unknown>;
}

export interface InteractionRequest {
  model: string;
  input: string | (AudioInput | { type: 'text'; text: string })[];
  system_instruction?: string;
  generation_config?: { transcription_config?: TranscriptionConfig; [key: string]: unknown };
  response_format?: TextResponseFormat;
  store?: boolean;
}

export interface GeminiFile {
  /** "files/abc-123" */
  name: string;
  uri: string;
  mimeType?: string;
  displayName?: string;
  sizeBytes?: string;
  state?: 'STATE_UNSPECIFIED' | 'PROCESSING' | 'ACTIVE' | 'FAILED';
  error?: { code?: number; message?: string };
}

// ---------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;
/** Longer Retry-After hints (daily quota) fail fast instead of stalling the job. */
const DEFAULT_MAX_RETRY_AFTER_MS = 90_000;

const INTERACTION_TIMEOUT_MS = 20 * 60_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const SMALL_REQUEST_TIMEOUT_MS = 60_000;
const VERIFY_TIMEOUT_MS = 15_000;

export interface GeminiErrorInit {
  /** HTTP status; 0 when no response arrived (connection failure, timeout). */
  status: number;
  /** Google RPC status, e.g. "INVALID_ARGUMENT", or the interaction status. */
  apiStatus?: string;
  /** The API's own message, suitable for showing to the user. */
  apiMessage?: string;
  retryAfterMs?: number;
  retryable?: boolean;
}

export class GeminiError extends Error {
  readonly status: number;
  readonly apiStatus: string | undefined;
  readonly apiMessage: string;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, init: GeminiErrorInit) {
    super(message);
    this.name = 'GeminiError';
    this.status = init.status;
    this.apiStatus = init.apiStatus;
    this.apiMessage = init.apiMessage ?? message;
    this.retryAfterMs = init.retryAfterMs;
    this.retryable = init.retryable ?? RETRYABLE_STATUS.has(init.status);
  }
}

interface RpcError {
  message?: unknown;
  status?: unknown;
  details?: unknown;
}

function rpcError(body: string): RpcError | undefined {
  try {
    const json: unknown = JSON.parse(body);
    // The interactions endpoint wraps the error in an array.
    const obj = (Array.isArray(json) ? json[0] : json) as { error?: RpcError } | undefined;
    return obj && typeof obj.error === 'object' && obj.error !== null ? obj.error : undefined;
  } catch {
    return undefined;
  }
}

/** Message (and RPC status) from a Google API error body, or the trimmed body itself. */
export function parseApiError(body: string): { message: string; status?: string } {
  const err = rpcError(body);
  if (err && typeof err.message === 'string') {
    return typeof err.status === 'string' ? { message: err.message, status: err.status } : { message: err.message };
  }
  return { message: body.trim().slice(0, 300) };
}

/** Delay the server asked for: Retry-After (seconds or HTTP date), else RetryInfo in the body. */
export function retryAfterMs(header: string | null, body: string, nowMs = Date.now()): number | undefined {
  if (header) {
    const trimmed = header.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
    const date = Date.parse(trimmed);
    if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  }
  const details = rpcError(body)?.details;
  if (Array.isArray(details)) {
    for (const d of details as ({ '@type'?: unknown; retryDelay?: unknown } | null)[]) {
      const type = d?.['@type'];
      const delay = d?.retryDelay;
      if (typeof type === 'string' && type.endsWith('RetryInfo') && typeof delay === 'string') return parseOffsetMs(delay);
    }
  }
  return undefined;
}

export interface RetryOptions {
  retries?: number;
  signal?: AbortSignal;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetryAfterMs?: number;
}

/**
 * Runs `fn` until it succeeds, retrying only retryable GeminiErrors with exponential
 * backoff (or the server's Retry-After). Aborting the signal stops immediately.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxRetryAfter = opts.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  for (let attempt = 0; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (!(err instanceof GeminiError) || !err.retryable || attempt >= retries) throw err;
      if (err.retryAfterMs !== undefined && err.retryAfterMs > maxRetryAfter) throw err;
      const backoff = Math.min(max, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      await sleep(err.retryAfterMs ?? backoff, opts.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Node's fetch hides the reason (ECONNREFUSED, ENOTFOUND…) in `cause`.
  const cause = err.cause as { code?: unknown; message?: unknown } | null | undefined;
  const code = cause?.code;
  const message = cause?.message;
  const detail = typeof code === 'string' ? code : typeof message === 'string' ? message : '';
  return detail ? `${err.message}: ${detail}` : err.message;
}

/**
 * One HTTP exchange: fetch, error mapping and body parsing under a single timeout.
 * Returns the parsed JSON body (or null for an empty body) plus the response headers.
 */
async function exchange(
  url: string,
  init: RequestInit,
  opts: RestOptions,
  defaultTimeoutMs: number,
): Promise<{ json: unknown; headers: Headers }> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let status = 0;
  try {
    const res = await doFetch(url, { ...init, signal });
    status = res.status;
    const body = await res.text();
    if (!res.ok) {
      const { message, status: apiStatus } = parseApiError(body);
      const apiMessage = message || res.statusText || 'no details';
      throw new GeminiError(`Gemini API error ${res.status}${apiStatus ? ` ${apiStatus}` : ''}: ${apiMessage}`, {
        status: res.status,
        apiMessage,
        ...(apiStatus ? { apiStatus } : {}),
        ...(retryAfterHint(res.headers.get('retry-after'), body)),
      });
    }
    if (!body) return { json: null, headers: res.headers };
    try {
      return { json: JSON.parse(body) as unknown, headers: res.headers };
    } catch {
      throw new GeminiError(`Gemini returned a response that is not JSON: ${body.slice(0, 200)}`, {
        status: res.status,
        retryable: false,
      });
    }
  } catch (err) {
    if (err instanceof GeminiError) throw err;
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (timeout.aborted) {
      throw new GeminiError(`Gemini request timed out after ${Math.round(timeoutMs / 1000)} s`, {
        status,
        retryable: false,
      });
    }
    throw new GeminiError(`Could not reach Gemini (${describeNetworkError(err)})`, { status: 0, retryable: true });
  }
}

function retryAfterHint(header: string | null, body: string): { retryAfterMs?: number } {
  const ms = retryAfterMs(header, body);
  return ms === undefined ? {} : { retryAfterMs: ms };
}

function apiUrl(opts: RestOptions, path: string): string {
  return `${opts.baseUrl ?? GEMINI_BASE_URL}/${path}`;
}

function retryOptions(opts: RestOptions): RetryOptions {
  return {
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.retryBaseDelayMs !== undefined ? { baseDelayMs: opts.retryBaseDelayMs } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

/**
 * POST /v1beta/interactions. Resolves with the interaction when it completed (or is
 * `incomplete`, whose partial output is still usable); throws a GeminiError otherwise.
 */
export async function createInteraction(
  apiKey: string,
  body: InteractionRequest,
  opts: RestOptions = {},
): Promise<Interaction> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
  const { json } = await withRetry(
    () => exchange(apiUrl(opts, `${GEMINI_API_VERSION}/interactions`), init, opts, INTERACTION_TIMEOUT_MS),
    retryOptions(opts),
  );
  const interaction = (json ?? {}) as Interaction;
  const status = interaction.status;
  if (status && status !== 'completed' && status !== 'incomplete') {
    const detail = (interaction.errors ?? [])
      .map((e) => e.message)
      .filter(Boolean)
      .join('; ');
    const apiMessage = detail || `interaction ended with status "${status}"`;
    throw new GeminiError(`Gemini interaction ${status}: ${apiMessage}`, {
      status: 200,
      apiStatus: status,
      apiMessage,
      retryable: false,
    });
  }
  return interaction;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface UploadOptions extends RestOptions {
  /** Plain MIME type without parameters, e.g. "audio/webm". */
  mimeType: string;
  displayName?: string;
  pollIntervalMs?: number;
  /** How long to wait for a PROCESSING file to become ACTIVE. */
  activeTimeoutMs?: number;
}

function asFile(json: unknown, what: string): GeminiFile {
  const file = (json as { file?: GeminiFile } | null)?.file ?? (json as GeminiFile | null);
  if (!file || typeof file.name !== 'string' || typeof file.uri !== 'string') {
    throw new GeminiError(`Gemini ${what} returned no file`, { status: 200, retryable: false });
  }
  return file;
}

/**
 * Uploads with the Files API resumable protocol (start, then upload+finalize in one
 * request) and waits until the file is ACTIVE. Files expire after 48 hours.
 */
export async function uploadFile(apiKey: string, blob: Blob, opts: UploadOptions): Promise<GeminiFile> {
  const uploadOnce = async (): Promise<GeminiFile> => {
    const start = await exchange(
      apiUrl(opts, `upload/${GEMINI_API_VERSION}/files`),
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(blob.size),
          'X-Goog-Upload-Header-Content-Type': opts.mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: opts.displayName ?? 'manet-audio' } }),
      },
      opts,
      SMALL_REQUEST_TIMEOUT_MS,
    );
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new GeminiError('Gemini upload did not return an upload URL', { status: 200, retryable: true });
    }
    const done = await exchange(
      uploadUrl,
      {
        method: 'POST',
        headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
        body: blob,
      },
      opts,
      UPLOAD_TIMEOUT_MS,
    );
    return asFile(done.json, 'upload');
  };

  let file = await withRetry(uploadOnce, retryOptions(opts));
  const deadline = Date.now() + (opts.activeTimeoutMs ?? 5 * 60_000);
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) {
      throw new GeminiError(`Gemini file ${file.name} is still processing`, { status: 0, retryable: false });
    }
    await sleep(opts.pollIntervalMs ?? 1000, opts.signal);
    file = await getFile(apiKey, file.name, opts);
  }
  if (file.state === 'FAILED') {
    const apiMessage = file.error?.message ?? 'processing failed';
    throw new GeminiError(`Gemini could not process the uploaded audio: ${apiMessage}`, {
      status: 200,
      apiStatus: 'FAILED',
      apiMessage,
      retryable: false,
    });
  }
  return file;
}

export async function getFile(apiKey: string, name: string, opts: RestOptions = {}): Promise<GeminiFile> {
  const { json } = await withRetry(
    () =>
      exchange(
        apiUrl(opts, `${GEMINI_API_VERSION}/${name}`),
        { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
        opts,
        SMALL_REQUEST_TIMEOUT_MS,
      ),
    retryOptions(opts),
  );
  return asFile(json, 'file lookup');
}

/** Best effort: resolves false instead of throwing (files expire after 48 h anyway). */
export async function deleteFile(apiKey: string, name: string, opts: RestOptions = {}): Promise<boolean> {
  try {
    await exchange(
      apiUrl(opts, `${GEMINI_API_VERSION}/${name}`),
      { method: 'DELETE', headers: { 'x-goog-api-key': apiKey } },
      opts,
      SMALL_REQUEST_TIMEOUT_MS,
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key check for the options page
// ---------------------------------------------------------------------------

/** Cheap authenticated call (list one model). The error is the API's own message. */
export async function verifyApiKey(
  apiKey: string,
  opts: RestOptions = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const key = apiKey.trim();
  if (!key) return { ok: false, error: 'No API key entered.' };
  try {
    await exchange(
      apiUrl(opts, `${GEMINI_API_VERSION}/models?pageSize=1`),
      { method: 'GET', headers: { 'x-goog-api-key': key } },
      opts,
      VERIFY_TIMEOUT_MS,
    );
    return { ok: true };
  } catch (err) {
    if (err instanceof GeminiError) return { ok: false, error: err.status === 0 ? err.message : err.apiMessage };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
