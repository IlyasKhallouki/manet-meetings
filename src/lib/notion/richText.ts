/**
 * Notion rich text limits: text.content ≤ 2000 characters (counted in UTF-16 code
 * units, as JavaScript does) and ≤ 100 rich text items per array.
 */

export const MAX_TEXT_LENGTH = 2000;
export const MAX_RICH_TEXT_ITEMS = 100;

export interface Annotations {
  bold?: boolean;
  italic?: boolean;
  color?: string;
}

export interface RichTextItem {
  type: 'text';
  text: { content: string };
  annotations?: Annotations;
}

/**
 * Splits text into chunks of at most `max` UTF-16 units whose concatenation is the
 * original text. Cuts after the last whitespace that fits, so words stay whole;
 * a word longer than `max` is cut hard, never between the halves of a surrogate pair.
 */
export function splitText(text: string, max: number = MAX_TEXT_LENGTH): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = 0;
    for (let i = max - 1; i > 0; i--) {
      if (/\s/.test(rest.charAt(i))) {
        cut = i + 1;
        break;
      }
    }
    if (cut === 0) {
      cut = max;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function richText(text: string, annotations?: Annotations): RichTextItem[] {
  return splitText(text).map((content) =>
    annotations ? { type: 'text', text: { content }, annotations } : { type: 'text', text: { content } },
  );
}

/** Concatenated plain text of a rich text array as the API returns it. */
export function plainText(items: ReadonlyArray<{ plain_text?: string; text?: { content: string } }> | undefined): string {
  return (items ?? []).map((i) => i.plain_text ?? i.text?.content ?? '').join('');
}
