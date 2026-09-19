import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LENGTH, richText, splitText } from '@lib/notion/richText';

function expectWellFormed(chunks: string[], original: string, max = MAX_TEXT_LENGTH) {
  expect(chunks.join('')).toBe(original);
  for (const c of chunks) {
    expect(c.length).toBeGreaterThan(0);
    expect(c.length).toBeLessThanOrEqual(max);
    // No chunk starts or ends with half of a surrogate pair.
    expect(c.isWellFormed()).toBe(true);
  }
}

describe('splitText', () => {
  it('uses Notion\'s 2000-character limit', () => {
    expect(MAX_TEXT_LENGTH).toBe(2000);
  });

  it('returns nothing for empty text and one chunk for short text', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText('Bonjour à tous')).toEqual(['Bonjour à tous']);
  });

  it('keeps text of exactly 2000 characters in one chunk and splits at 2001', () => {
    const exact = 'a'.repeat(2000);
    expect(splitText(exact)).toEqual([exact]);
    const words = `${'word '.repeat(400)}`; // 2000 chars, ends with a space
    expect(words.length).toBe(2000);
    expect(splitText(words)).toEqual([words]);
    const over = `${words}x`;
    expect(splitText(over)).toEqual([words, 'x']);
  });

  it('splits at the last whitespace so words stay whole', () => {
    const text = Array.from({ length: 900 }, (_, i) => `mot${i}`).join(' ');
    const chunks = splitText(text);
    expectWellFormed(chunks, text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks.slice(0, -1)) expect(c).toMatch(/\s$/);
    for (const c of chunks.slice(1)) expect(c).toMatch(/^mot\d+/);
  });

  it('hard-splits a single word longer than the limit', () => {
    const word = 'x'.repeat(4500);
    const chunks = splitText(`start ${word} end`);
    expectWellFormed(chunks, `start ${word} end`);
    expect(chunks[0]).toBe('start ');
    expect(chunks.some((c) => c.length === 2000)).toBe(true);
  });

  it('never splits a surrogate pair (emoji) or counts past 2000 UTF-16 units', () => {
    const emoji = '😀'.repeat(1500); // 3000 UTF-16 units, no whitespace
    const chunks = splitText(emoji);
    expectWellFormed(chunks, emoji);
    // An odd limit forces the cut to land between the two halves of a pair.
    const odd = splitText('a😀😀😀', 4);
    expectWellFormed(odd, 'a😀😀😀', 4);
    expect(odd[0]).toBe('a😀');
  });

  it('handles accented French text and newlines', () => {
    const text = 'Réunion d’équipe — décisions clés.\n'.repeat(120);
    expectWellFormed(splitText(text), text);
  });

  it('respects a custom limit', () => {
    const chunks = splitText('one two three four five', 8);
    expectWellFormed(chunks, 'one two three four five', 8);
    expect(chunks).toEqual(['one two ', 'three ', 'four ', 'five']);
  });
});

describe('richText', () => {
  it('builds text items no longer than 2000 characters with optional annotations', () => {
    const text = 'z'.repeat(4100);
    const items = richText(text, { bold: true });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.type).toBe('text');
      expect(item.text.content.length).toBeLessThanOrEqual(2000);
      expect(item.annotations).toEqual({ bold: true });
    }
    expect(items.map((i) => i.text.content).join('')).toBe(text);
    expect(richText('plain')).toEqual([{ type: 'text', text: { content: 'plain' } }]);
    expect(richText('')).toEqual([]);
  });
});
