import { describe, expect, it } from 'vitest';
import type { MeetingPageInput } from '@lib/types';
import {
  buildMeetingProperties,
  durationMinutes,
  isoWithOffset,
  sanitizeMultiSelect,
} from '@lib/notion/properties';
import { databaseSchemaPayload, MEETING_DB_SCHEMA, MEETING_PROPS, SOURCE_OPTIONS } from '@lib/notion/schema';

function input(overrides: Partial<MeetingPageInput> = {}): MeetingPageInput {
  return {
    key: 'abc-defg-hij-2026-09-19',
    title: 'Point hebdo produit',
    startedAt: Date.UTC(2026, 8, 19, 8, 15, 30),
    durationMs: 47 * 60_000 + 33_000,
    attendees: ['Ilyas', 'Camille Martin'],
    meetCode: 'abc-defg-hij',
    recordedBy: 'Ilyas',
    source: 'audio+captions',
    summary: null,
    transcript: { turns: [], source: 'audio+captions', notes: [] },
    ...overrides,
  };
}

describe('database schema', () => {
  it('names every property with its Notion type', () => {
    expect(MEETING_DB_SCHEMA).toEqual({
      Name: 'title',
      Date: 'date',
      Duration: 'number',
      Attendees: 'multi_select',
      'Meet code': 'rich_text',
      'Recorded by': 'rich_text',
      Source: 'select',
      Key: 'rich_text',
    });
    expect(MEETING_PROPS.key).toBe('Key');
    expect(SOURCE_OPTIONS).toEqual(['audio+captions', 'audio-only', 'captions-only']);
  });

  it('builds a create-database payload with one config per property', () => {
    const payload = databaseSchemaPayload();
    expect(Object.keys(payload).sort()).toEqual(Object.keys(MEETING_DB_SCHEMA).sort());
    expect(payload.Name).toEqual({ type: 'title', title: {} });
    expect(payload.Duration).toEqual({ type: 'number', number: { format: 'number' } });
    expect(payload.Source).toMatchObject({
      type: 'select',
      select: { options: SOURCE_OPTIONS.map((name) => expect.objectContaining({ name })) },
    });
    expect(payload.Key).toEqual({ type: 'rich_text', rich_text: {} });
  });
});

describe('isoWithOffset', () => {
  const t = Date.UTC(2026, 8, 19, 8, 15, 30, 250);

  it('renders local wall time with the numeric offset', () => {
    expect(isoWithOffset(t, 120)).toBe('2026-09-19T10:15:30+02:00');
    expect(isoWithOffset(t, 0)).toBe('2026-09-19T08:15:30+00:00');
    expect(isoWithOffset(t, -270)).toBe('2026-09-19T03:45:30-04:30');
    expect(isoWithOffset(Date.UTC(2026, 0, 1, 23, 30), 60)).toBe('2026-01-02T00:30:00+01:00');
  });

  it('defaults to the runtime time zone and denotes the same instant', () => {
    const iso = isoWithOffset(t);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(Date.parse(iso)).toBe(Math.floor(t / 1000) * 1000);
  });
});

describe('durationMinutes', () => {
  it('rounds to one decimal', () => {
    expect(durationMinutes(47 * 60_000 + 33_000)).toBe(47.6);
    expect(durationMinutes(90_000)).toBe(1.5);
    expect(durationMinutes(0)).toBe(0);
    expect(durationMinutes(-5)).toBe(0);
  });
});

describe('sanitizeMultiSelect', () => {
  it('removes commas, collapses whitespace and drops empties', () => {
    expect(sanitizeMultiSelect(['Martin, Camille', '  Jean   Dupont ', '', ' , '])).toEqual([
      'Martin Camille',
      'Jean Dupont',
    ]);
  });

  it('dedupes case-insensitively and across Unicode normalization forms', () => {
    expect(sanitizeMultiSelect(['Zoé', 'zoé', 'Zoé', 'ZOÉ', 'Ilyas'])).toEqual(['Zoé', 'Ilyas']);
  });

  it('truncates names to 100 characters without splitting a surrogate pair', () => {
    const long = `${'a'.repeat(99)}😀tail`;
    const [name] = sanitizeMultiSelect([long]);
    expect(name).toBe('a'.repeat(99));
    expect(sanitizeMultiSelect(['b'.repeat(250)])[0]).toHaveLength(100);
  });

  it('keeps at most 100 options', () => {
    const many = Array.from({ length: 150 }, (_, i) => `Person ${i}`);
    expect(sanitizeMultiSelect(many)).toHaveLength(100);
  });
});

describe('buildMeetingProperties', () => {
  it('fills every schema property', () => {
    const props = buildMeetingProperties(input({ attendees: ['Ilyas', 'Martin, Camille', 'ilyas'] }), 'Name', 120);
    expect(props).toEqual({
      Name: { title: [{ type: 'text', text: { content: 'Point hebdo produit' } }] },
      Date: { date: { start: '2026-09-19T10:15:30+02:00' } },
      Duration: { number: 47.6 },
      Attendees: { multi_select: [{ name: 'Ilyas' }, { name: 'Martin Camille' }] },
      'Meet code': { rich_text: [{ type: 'text', text: { content: 'abc-defg-hij' } }] },
      'Recorded by': { rich_text: [{ type: 'text', text: { content: 'Ilyas' } }] },
      Source: { select: { name: 'audio+captions' } },
      Key: { rich_text: [{ type: 'text', text: { content: 'abc-defg-hij-2026-09-19' } }] },
    });
  });

  it('writes the title under the database\'s own title property name', () => {
    const props = buildMeetingProperties(input(), 'Nom', 0);
    expect(props.Nom).toBeDefined();
    expect(props.Name).toBeUndefined();
  });

  it('falls back to a dated title and chunks long text values', () => {
    const blank = buildMeetingProperties(input({ title: '   ' }), 'Name', 0) as Record<string, { title: unknown[] }>;
    expect(blank.Name?.title).toEqual([{ type: 'text', text: { content: 'Meeting abc-defg-hij 2026-09-19' } }]);
    const long = buildMeetingProperties(input({ title: 'x'.repeat(2500) }), 'Name', 0) as Record<
      string,
      { title: Array<{ text: { content: string } }> }
    >;
    expect(long.Name?.title.map((t) => t.text.content.length)).toEqual([2000, 500]);
  });
});
