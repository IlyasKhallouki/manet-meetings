/**
 * Page property values for a meeting row.
 */
import type { MeetingPageInput } from '../types';
import { richText } from './richText';
import { MEETING_PROPS, OPTIONAL_PROPS } from './schema';

const MAX_OPTION_LENGTH = 100;
const MAX_OPTIONS = 100;

/**
 * Local wall time of `epochMs` with its numeric UTC offset, second precision:
 * "2026-09-19T10:15:30+02:00". `offsetMinutes` is east of UTC (Paris summer = 120).
 */
export function isoWithOffset(epochMs: number, offsetMinutes: number = -new Date(epochMs).getTimezoneOffset()): string {
  const wall = new Date(Math.floor(epochMs / 1000) * 1000 + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${wall}${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Minutes with one decimal. */
export function durationMinutes(ms: number): number {
  return Math.max(0, Math.round(ms / 6000) / 10);
}

/**
 * Makes names valid multi-select options: no commas (Notion rejects them), trimmed,
 * ≤ 100 characters, unique ignoring case (Notion matches options case-insensitively),
 * at most 100 of them.
 */
export function sanitizeMultiSelect(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    let name = raw.normalize('NFC').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (name.length > MAX_OPTION_LENGTH) {
      let cut = MAX_OPTION_LENGTH;
      const c = name.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
      name = name.slice(0, cut).trim();
    }
    const folded = name.toLowerCase();
    if (!name || seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

/**
 * `properties` for POST /v1/pages under the meetings data source, all but the Key
 * (see keyProperty). `titleProperty` is the data source's actual title property name
 * (a French workspace calls it "Nom").
 */
export function buildMeetingProperties(
  input: MeetingPageInput,
  titleProperty: string = MEETING_PROPS.title,
  offsetMinutes?: number,
): Record<string, unknown> {
  const start = isoWithOffset(input.startedAt, offsetMinutes);
  const title = input.title.trim() || `Meeting ${input.meetCode} ${start.slice(0, 10)}`;
  return {
    [titleProperty]: { title: richText(title) },
    [MEETING_PROPS.date]: { date: { start } },
    [MEETING_PROPS.duration]: { number: durationMinutes(input.durationMs) },
    [MEETING_PROPS.attendees]: { multi_select: sanitizeMultiSelect(input.attendees).map((name) => ({ name })) },
    [MEETING_PROPS.meetCode]: { rich_text: richText(input.meetCode) },
    [MEETING_PROPS.recordedBy]: { rich_text: richText(input.recordedBy) },
    [MEETING_PROPS.source]: { select: { name: input.source } },
  };
}

/** The optional Profile select. Nothing for a blank name. */
export function profileProperty(name: string): Record<string, unknown> {
  const [option] = sanitizeMultiSelect([name]);
  return option ? { [OPTIONAL_PROPS.profile]: { select: { name: option } } } : {};
}

/**
 * The idempotency Key, written by a PATCH once the body and transcript are in place:
 * findByKey only matches keyed pages, so a save that dies half-way leaves nothing a
 * retry or a teammate would take for the saved meeting.
 */
export function keyProperty(key: string): Record<string, unknown> {
  return { [MEETING_PROPS.key]: { rich_text: richText(key) } };
}
