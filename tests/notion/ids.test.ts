import { describe, expect, it } from 'vitest';
import { compactId, parseNotionId, sameNotionId } from '@lib/notion/ids';

const HEX = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

describe('parseNotionId', () => {
  it('accepts a bare id with or without dashes, any case, trimmed', () => {
    expect(parseNotionId(HEX)).toBe(UUID);
    expect(parseNotionId(UUID)).toBe(UUID);
    expect(parseNotionId(`  ${HEX.toUpperCase()}\n`)).toBe(UUID);
  });

  it('accepts a title-slug id as Notion shows it in links', () => {
    expect(parseNotionId(`Meetings-${HEX}`)).toBe(UUID);
  });

  it('extracts the database id from Notion URLs and ignores the view id', () => {
    const view = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
    expect(parseNotionId(`https://www.notion.so/lumind/Meetings-${HEX}?v=${view}&pvs=4`)).toBe(UUID);
    expect(parseNotionId(`https://www.notion.so/${HEX}?v=${view}`)).toBe(UUID);
    expect(parseNotionId(`https://app.notion.com/p/${HEX}`)).toBe(UUID);
    expect(parseNotionId(`https://notion.so/lumind/${UUID}#section`)).toBe(UUID);
    expect(parseNotionId(`https://lumind.notion.site/Team-Meetings-${HEX}`)).toBe(UUID);
  });

  it('rejects input without a 32-hex id', () => {
    expect(parseNotionId('')).toBeNull();
    expect(parseNotionId('meetings')).toBeNull();
    expect(parseNotionId(HEX.slice(1))).toBeNull();
    expect(parseNotionId(`${HEX}0`)).toBeNull();
    expect(parseNotionId('https://www.notion.so/lumind/Meetings')).toBeNull();
    // The only id is the view id in the query string: that is not a database.
    expect(parseNotionId(`https://www.notion.so/lumind?v=${HEX}`)).toBeNull();
  });
});

describe('id comparison', () => {
  it('compares ids regardless of dashes and case', () => {
    expect(compactId(UUID)).toBe(HEX);
    expect(sameNotionId(UUID, HEX.toUpperCase())).toBe(true);
    expect(sameNotionId(UUID, 'ffffffffffffffffffffffffffffffff')).toBe(false);
  });
});
