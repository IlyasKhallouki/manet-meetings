/**
 * Block payloads for the meeting page and its "Transcript" child page.
 *
 * Limits honoured here: ≤ 2000 characters per text item (richText), ≤ 100 items per
 * rich_text array, ≤ 100 blocks per children array, ≤ 500 KB per request body.
 */
import type { ActionItem, MeetingPageInput, TranscriptTurn } from '../types';
import { formatClock } from '../util/time';
import { MAX_RICH_TEXT_ITEMS, MAX_TEXT_LENGTH, richText, type RichTextItem } from './richText';

/**
 * Items per block. Half the API's 100 so one block stays ≤ ~300 KB of JSON even for
 * 3-byte characters, and always fits in a single request.
 */
const MAX_ITEMS_PER_BLOCK = 50;
export const MAX_BLOCKS_PER_REQUEST = 100;
/** Under Notion's 500 KB request cap, leaving room for page properties. */
export const MAX_BATCH_BYTES = 400_000;

interface RichBody {
  rich_text: RichTextItem[];
  color?: string;
}

export type BlockRequest =
  | { object: 'block'; type: 'paragraph'; paragraph: RichBody }
  | { object: 'block'; type: 'heading_2'; heading_2: RichBody }
  | { object: 'block'; type: 'bulleted_list_item'; bulleted_list_item: RichBody }
  | { object: 'block'; type: 'to_do'; to_do: RichBody & { checked: boolean } }
  | { object: 'block'; type: 'callout'; callout: RichBody & { icon: { type: 'emoji'; emoji: string } } };

type SimpleType = 'paragraph' | 'heading_2' | 'bulleted_list_item';

function chunkItems(items: RichTextItem[]): RichTextItem[][] {
  if (items.length === 0) return [[]];
  const groups: RichTextItem[][] = [];
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_BLOCK) groups.push(items.slice(i, i + MAX_ITEMS_PER_BLOCK));
  return groups;
}

function simple(type: SimpleType, items: RichTextItem[]): BlockRequest[] {
  return chunkItems(items).map((rich_text): BlockRequest => {
    switch (type) {
      case 'paragraph':
        return { object: 'block', type, paragraph: { rich_text } };
      case 'heading_2':
        return { object: 'block', type, heading_2: { rich_text } };
      case 'bulleted_list_item':
        return { object: 'block', type, bulleted_list_item: { rich_text } };
    }
  });
}

function todos(text: string): BlockRequest[] {
  return chunkItems(richText(text)).map((rich_text): BlockRequest => ({
    object: 'block',
    type: 'to_do',
    to_do: { rich_text, checked: false },
  }));
}

function muted(text: string): BlockRequest[] {
  return simple('paragraph', richText(text, { italic: true, color: 'gray' }));
}

/** Concatenated text of a block's rich_text. */
export function blockText(block: BlockRequest): string {
  return richTextOf(block).map((i) => i.text.content).join('');
}

function richTextOf(block: BlockRequest): RichTextItem[] {
  switch (block.type) {
    case 'paragraph':
      return block.paragraph.rich_text;
    case 'heading_2':
      return block.heading_2.rich_text;
    case 'bulleted_list_item':
      return block.bulleted_list_item.rich_text;
    case 'to_do':
      return block.to_do.rich_text;
    case 'callout':
      return block.callout.rich_text;
  }
}

/** "Owner — task (due)", leaving out whatever is missing. */
export function formatActionItem(item: ActionItem): string {
  const owner = item.owner?.trim();
  const due = item.due?.trim();
  return `${owner ? `${owner} — ` : ''}${item.task.trim()}${due ? ` (${due})` : ''}`;
}

function section(heading: string, entries: string[], render: (text: string) => BlockRequest[]): BlockRequest[] {
  const items = entries.map((e) => e.trim()).filter(Boolean);
  return [
    ...simple('heading_2', richText(heading)),
    ...(items.length ? items.flatMap(render) : muted('None.')),
  ];
}

/** Body of the meeting page (the transcript goes in a child page). */
export function buildMeetingBody(input: MeetingPageInput): BlockRequest[] {
  const blocks: BlockRequest[] = [];
  const notes = input.transcript.notes.map((n) => n.trim()).filter(Boolean);
  if (notes.length) {
    for (const rich_text of chunkItems(richText(notes.join('\n')))) {
      blocks.push({
        object: 'block',
        type: 'callout',
        // Single-code-point emoji: Notion validates emoji strings, variation selectors are a gamble.
        callout: { rich_text, icon: { type: 'emoji', emoji: '❗' }, color: 'yellow_background' },
      });
    }
  }

  const { summary } = input;
  if (!summary) {
    blocks.push(...simple('heading_2', richText('Summary')));
    blocks.push(...muted('The summary is unavailable for this meeting. The full transcript is below.'));
    return blocks;
  }
  for (const s of summary.sections) {
    if (s.format === 'paragraph') {
      const paragraphs = s.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      blocks.push(...simple('heading_2', richText(s.title)));
      blocks.push(...(paragraphs.length ? paragraphs.flatMap((p) => simple('paragraph', richText(p))) : muted('None.')));
    } else {
      blocks.push(...section(s.title, s.items, (t) => simple('bulleted_list_item', richText(t))));
    }
  }
  blocks.push(...section('Action items', summary.actionItems.filter((a) => a.task.trim()).map(formatActionItem), todos));
  return blocks;
}

/**
 * Characters per transcript paragraph. Many turns share a paragraph because Free
 * workspaces with several members cap internal integrations at 1,000 lifetime blocks,
 * and one block per turn would use that up within a few meetings.
 */
const MAX_TRANSCRIPT_BLOCK_CHARS = 12_000;

/**
 * Turns packed into paragraphs, each turn a bold "[hh:mm:ss] Speaker:" label and its
 * text, separated by blank lines. A turn too long for one paragraph spills into more.
 */
export function buildTranscriptBlocks(turns: readonly TranscriptTurn[]): BlockRequest[] {
  if (turns.length === 0) return muted('No speech was captured in this meeting.');
  const blocks: BlockRequest[] = [];
  let items: RichTextItem[] = [];
  let chars = 0;
  const flush = () => {
    // Packed paragraphs are bounded by the character cap, so they may use the API's full
    // item limit; only a single oversized turn goes through the generic splitter.
    if (items.length && items.length <= MAX_RICH_TEXT_ITEMS && chars <= MAX_TRANSCRIPT_BLOCK_CHARS) {
      blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: items } });
    } else if (items.length) {
      blocks.push(...simple('paragraph', items));
    }
    items = [];
    chars = 0;
  };
  for (const turn of turns) {
    const label = `[${formatClock(turn.start)}] ${turn.speaker}:`;
    const text = turn.text.trim();
    const turnItems = [...richText(label, { bold: true }), ...(text ? richText(` ${text}`) : [])];
    const turnChars = label.length + text.length + 3;
    if (items.length && (items.length + turnItems.length + 1 > MAX_RICH_TEXT_ITEMS || chars + turnChars > MAX_TRANSCRIPT_BLOCK_CHARS)) {
      flush();
    }
    if (items.length) {
      const first = turnItems[0]!;
      if (first.text.content.length + 2 <= MAX_TEXT_LENGTH) first.text.content = `\n\n${first.text.content}`;
      else turnItems.unshift(...richText('\n\n'));
    }
    items.push(...turnItems);
    chars += turnChars;
  }
  flush();
  return blocks;
}

/**
 * Groups blocks into request-sized batches: ≤ `maxBlocks` blocks and ≤ `maxBytes`
 * of JSON each. Order is preserved.
 */
export function batchBlocks(
  blocks: readonly BlockRequest[],
  maxBlocks: number = MAX_BLOCKS_PER_REQUEST,
  maxBytes: number = MAX_BATCH_BYTES,
): BlockRequest[][] {
  const encoder = new TextEncoder();
  const envelope = encoder.encode(JSON.stringify({ children: [] })).length;
  const batches: BlockRequest[][] = [];
  let current: BlockRequest[] = [];
  let size = envelope;
  for (const block of blocks) {
    const blockBytes = encoder.encode(JSON.stringify(block)).length + 1;
    if (current.length > 0 && (current.length >= maxBlocks || size + blockBytes > maxBytes)) {
      batches.push(current);
      current = [];
      size = envelope;
    }
    current.push(block);
    size += blockBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}
