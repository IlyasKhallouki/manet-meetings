/**
 * The meetings database schema. The README documents it; verifyDatabase checks it;
 * scripts/notion-setup.ts creates it. Dependency-free (type-only imports) so the
 * setup script can import it under Node type stripping.
 */
import type { TranscriptSource } from '../types';

export type NotionPropertyType = 'title' | 'date' | 'number' | 'multi_select' | 'rich_text' | 'select';

export const MEETING_PROPS = {
  title: 'Name',
  date: 'Date',
  duration: 'Duration',
  attendees: 'Attendees',
  meetCode: 'Meet code',
  recordedBy: 'Recorded by',
  source: 'Source',
  key: 'Key',
} as const;

/**
 * Property name → type. Name: meeting title. Date: recording start with offset.
 * Duration: minutes, one decimal. Attendees: caption speaker names. Meet code: e.g.
 * abc-defg-hij. Recorded by: the teammate whose extension saved it. Source: which
 * inputs the transcript came from. Key: idempotency key `${meetCode}-${YYYY-MM-DD}`.
 */
export const MEETING_DB_SCHEMA = {
  [MEETING_PROPS.title]: 'title',
  [MEETING_PROPS.date]: 'date',
  [MEETING_PROPS.duration]: 'number',
  [MEETING_PROPS.attendees]: 'multi_select',
  [MEETING_PROPS.meetCode]: 'rich_text',
  [MEETING_PROPS.recordedBy]: 'rich_text',
  [MEETING_PROPS.source]: 'select',
  [MEETING_PROPS.key]: 'rich_text',
} as const satisfies Record<string, NotionPropertyType>;

export const SOURCE_OPTIONS: readonly TranscriptSource[] = ['audio+captions', 'audio-only', 'captions-only'];

const SOURCE_COLORS: Record<TranscriptSource, string> = {
  'audio+captions': 'green',
  'audio-only': 'blue',
  'captions-only': 'orange',
};

/** `initial_data_source.properties` for POST /v1/databases. */
export function databaseSchemaPayload(): Record<string, Record<string, unknown>> {
  return {
    [MEETING_PROPS.title]: { type: 'title', title: {} },
    [MEETING_PROPS.date]: { type: 'date', date: {} },
    [MEETING_PROPS.duration]: { type: 'number', number: { format: 'number' } },
    [MEETING_PROPS.attendees]: { type: 'multi_select', multi_select: { options: [] } },
    [MEETING_PROPS.meetCode]: { type: 'rich_text', rich_text: {} },
    [MEETING_PROPS.recordedBy]: { type: 'rich_text', rich_text: {} },
    [MEETING_PROPS.source]: {
      type: 'select',
      select: { options: SOURCE_OPTIONS.map((name) => ({ name, color: SOURCE_COLORS[name] })) },
    },
    [MEETING_PROPS.key]: { type: 'rich_text', rich_text: {} },
  };
}
