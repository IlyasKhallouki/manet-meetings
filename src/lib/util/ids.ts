/** Local calendar date of an epoch-ms timestamp as YYYY-MM-DD. */
export function localDate(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Notion dedupe key shared by every teammate who records the same meeting that day. */
export function idempotencyKey(meetCode: string, startedAt: number): string {
  return `${meetCode}-${localDate(startedAt)}`;
}

/** Session id, also the OPFS directory name: `abc-defg-hij_20260919T101500Z`. */
export function sessionId(meetCode: string, startedAt: number): string {
  const iso = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${meetCode}_${iso}`;
}
