import { describe, expect, it } from 'vitest';
import type { MeetingPageInput, MeetingSummary, TranscriptTurn } from '@lib/types';
import {
  batchBlocks,
  blockText,
  buildMeetingBody,
  buildTranscriptBlocks,
  formatActionItem,
  MAX_BATCH_BYTES,
  type BlockRequest,
} from '@lib/notion/blocks';
import { richText } from '@lib/notion/richText';
import { formatClock } from '@lib/util/time';

const summary: MeetingSummary = {
  title: 'Point hebdo',
  sections: [
    { title: 'Summary', format: 'paragraph', text: 'We reviewed the launch.\n\nOn a aussi parlé du budget.', items: [] },
    { title: 'Key points', format: 'bullets', text: '', items: ['Launch is on track', 'Budget validé'] },
    { title: 'Decisions', format: 'bullets', text: '', items: ['Ship on Monday'] },
  ],
  actionItems: [
    { task: 'Send the deck', owner: 'Camille', due: '2026-09-22' },
    { task: 'Book the room', owner: 'Ilyas' },
    { task: 'Relire le contrat' },
  ],
};

function input(overrides: Partial<MeetingPageInput> = {}): MeetingPageInput {
  return {
    key: 'abc-defg-hij-2026-09-19',
    title: 'Point hebdo',
    startedAt: Date.UTC(2026, 8, 19, 8, 0),
    durationMs: 30 * 60_000,
    attendees: ['Ilyas', 'Camille'],
    meetCode: 'abc-defg-hij',
    recordedBy: 'Ilyas',
    source: 'audio+captions',
    summary,
    transcript: { turns: [], source: 'audio+captions', notes: [] },
    ...overrides,
  };
}

const types = (blocks: BlockRequest[]) => blocks.map((b) => b.type);
const texts = (blocks: BlockRequest[]) => blocks.map(blockText);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

describe('formatActionItem', () => {
  it('renders "Owner — task (due)" and drops missing parts', () => {
    expect(formatActionItem({ task: 'Send the deck', owner: 'Camille', due: 'Friday' })).toBe('Camille — Send the deck (Friday)');
    expect(formatActionItem({ task: 'Book the room', owner: 'Ilyas' })).toBe('Ilyas — Book the room');
    expect(formatActionItem({ task: 'Relire', due: 'lundi' })).toBe('Relire (lundi)');
    expect(formatActionItem({ task: 'Relire' })).toBe('Relire');
  });
});

describe('buildMeetingBody', () => {
  it('lays out summary, key points, decisions and action items', () => {
    const blocks = buildMeetingBody(input());
    expect(types(blocks)).toEqual([
      'heading_2',
      'paragraph',
      'paragraph',
      'heading_2',
      'bulleted_list_item',
      'bulleted_list_item',
      'heading_2',
      'bulleted_list_item',
      'heading_2',
      'to_do',
      'to_do',
      'to_do',
    ]);
    expect(texts(blocks)).toEqual([
      'Summary',
      'We reviewed the launch.',
      'On a aussi parlé du budget.',
      'Key points',
      'Launch is on track',
      'Budget validé',
      'Decisions',
      'Ship on Monday',
      'Action items',
      'Camille — Send the deck (2026-09-22)',
      'Ilyas — Book the room',
      'Relire le contrat',
    ]);
    const todo = blocks[9];
    if (todo?.type !== 'to_do') throw new Error('expected a to_do block');
    expect(todo.to_do.checked).toBe(false);
  });

  it('starts with a callout listing degradation notes when there are any', () => {
    const blocks = buildMeetingBody(
      input({
        transcript: {
          turns: [],
          source: 'captions-only',
          notes: ['Timing pass failed: 503', 'Text pass failed: timeout'],
        },
      }),
    );
    expect(blocks[0]?.type).toBe('callout');
    expect(blockText(blocks[0]!)).toBe('Timing pass failed: 503\nText pass failed: timeout');
    expect(blocks[1]?.type).toBe('heading_2');
  });

  it('says the summary is unavailable when there is none', () => {
    const blocks = buildMeetingBody(input({ summary: null }));
    expect(types(blocks)).toEqual(['heading_2', 'paragraph']);
    expect(blockText(blocks[1]!)).toMatch(/summary is unavailable/i);
  });

  it('marks empty sections instead of leaving a bare heading', () => {
    const blocks = buildMeetingBody(
      input({
        summary: {
          ...summary,
          sections: [
            { title: 'Summary', format: 'paragraph', text: 'We reviewed the launch.\n\nOn a aussi parlé du budget.', items: [] },
            { title: 'Key points', format: 'bullets', text: '', items: [] },
            { title: 'Decisions', format: 'bullets', text: '', items: [] },
          ],
          actionItems: [],
        },
      }),
    );
    expect(texts(blocks).slice(3)).toEqual(['Key points', 'None.', 'Decisions', 'None.', 'Action items', 'None.']);
  });

  it('splits long summary text across rich text items of ≤ 2000 characters', () => {
    const long = 'palabre '.repeat(700).trim(); // ~5600 chars, one paragraph
    const blocks = buildMeetingBody(
      input({ summary: { ...summary, sections: [{ ...summary.sections[0]!, text: long }, ...summary.sections.slice(1)] } }),
    );
    const para = blocks[1];
    expect(para?.type).toBe('paragraph');
    if (para?.type !== 'paragraph') return;
    expect(para.paragraph.rich_text.length).toBe(3);
    for (const item of para.paragraph.rich_text) expect(item.text.content.length).toBeLessThanOrEqual(2000);
    expect(blockText(para)).toBe(long);
  });

  it('writes each section in order, then the action items', () => {
    const summary = {
      title: 'Pricing call',
      sections: [
        { title: 'Client needs', format: 'bullets' as const, text: '', items: ['A PDF export', 'SSO'] },
        { title: 'Pricing', format: 'paragraph' as const, text: 'About 40k a year.\n\nPilot is separate.', items: [] },
        { title: 'Objections', format: 'bullets' as const, text: '', items: [] },
      ],
      actionItems: [{ task: 'Send the quote', owner: 'Marie', due: 'Friday' }],
    };
    const blocks = buildMeetingBody({ ...input(), transcript: { ...input().transcript, notes: [] }, summary });
    expect(blocks.map((b) => [b.type, blockText(b)])).toEqual([
      ['heading_2', 'Client needs'],
      ['bulleted_list_item', 'A PDF export'],
      ['bulleted_list_item', 'SSO'],
      ['heading_2', 'Pricing'],
      ['paragraph', 'About 40k a year.'],
      ['paragraph', 'Pilot is separate.'],
      ['heading_2', 'Objections'],
      ['paragraph', 'None.'],
      ['heading_2', 'Action items'],
      ['to_do', 'Marie — Send the quote (Friday)'],
    ]);
  });
});

describe('buildTranscriptBlocks', () => {
  const turns: TranscriptTurn[] = [
    { speaker: 'Ilyas', start: 0, end: 4_000, text: 'Bonjour à tous.' },
    { speaker: 'Camille', start: 3_723_000, end: 3_730_000, text: 'Hi everyone, quick update.' },
  ];

  it('packs consecutive turns into one paragraph, each with a bold "[hh:mm:ss] Speaker:" label', () => {
    const blocks = buildTranscriptBlocks(turns);
    expect(types(blocks)).toEqual(['paragraph']);
    const first = blocks[0];
    if (first?.type !== 'paragraph') throw new Error('expected paragraph');
    expect(first.paragraph.rich_text[0]).toEqual({
      type: 'text',
      text: { content: '[00:00:00] Ilyas:' },
      annotations: { bold: true },
    });
    expect(first.paragraph.rich_text[2]).toEqual({
      type: 'text',
      text: { content: '\n\n[01:02:03] Camille:' },
      annotations: { bold: true },
    });
    expect(texts(blocks)).toEqual(['[00:00:00] Ilyas: Bonjour à tous.\n\n[01:02:03] Camille: Hi everyone, quick update.']);
  });

  it('keeps an hour-long meeting to a handful of blocks (Free workspaces cap lifetime blocks)', () => {
    const hour: TranscriptTurn[] = Array.from({ length: 400 }, (_, i) => ({
      speaker: i % 2 ? 'Camille' : 'Ilyas',
      start: i * 9_000,
      end: i * 9_000 + 8_000,
      text: 'on avance sur le projet et the roadmap looks good '.repeat(4).trim(),
    }));
    const blocks = buildTranscriptBlocks(hour);
    expect(blocks.length).toBeLessThanOrEqual(12);
    for (const b of blocks) {
      if (b.type !== 'paragraph') throw new Error('expected paragraph');
      expect(b.paragraph.rich_text.length).toBeLessThanOrEqual(100);
      for (const item of b.paragraph.rich_text) expect(item.text.content.length).toBeLessThanOrEqual(2000);
    }
    const all = texts(blocks).join('\n\n');
    for (const t of hour) expect(all).toContain(`[${formatClock(t.start)}] ${t.speaker}: ${t.text}`);
  });

  it('says so when there are no turns', () => {
    const blocks = buildTranscriptBlocks([]);
    expect(blocks).toHaveLength(1);
    expect(blockText(blocks[0]!)).toMatch(/no speech/i);
  });

  it('splits a very long turn into several paragraphs, each within the item limits', () => {
    const text = 'lorem ipsum dolor sit amet '.repeat(8000).trim(); // 216k chars
    const blocks = buildTranscriptBlocks([{ speaker: 'Camille', start: 0, end: 1, text }]);
    expect(blocks.length).toBeGreaterThan(1);
    for (const b of blocks) {
      if (b.type !== 'paragraph') throw new Error('expected paragraph');
      expect(b.paragraph.rich_text.length).toBeLessThanOrEqual(100);
      for (const item of b.paragraph.rich_text) expect(item.text.content.length).toBeLessThanOrEqual(2000);
      expect(bytes(b)).toBeLessThan(MAX_BATCH_BYTES);
    }
    expect(texts(blocks).join('') === `[00:00:00] Camille: ${text}`).toBe(true);
  });
});

describe('batchBlocks', () => {
  const paragraph = (text: string): BlockRequest => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(text) } });

  it('batches at most 100 blocks per request', () => {
    const blocks = Array.from({ length: 250 }, (_, i) => paragraph(`turn ${i}`));
    const batches = batchBlocks(blocks);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(blocks);
    expect(batchBlocks([])).toEqual([]);
  });

  it('also caps the request body size', () => {
    const text = 'é'.repeat(1999);
    const blocks = Array.from({ length: 100 }, () => paragraph(`${text} ${text} ${text}`));
    const batches = batchBlocks(blocks, 100, 200_000);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) expect(bytes({ children: batch })).toBeLessThanOrEqual(200_000);
    expect(batches.flat()).toEqual(blocks);
  });
});
