import { describe, expect, it } from 'vitest';
import { estimateLags, estimateLagsFromTiming } from '@lib/merge/lag';
import { prepareSegments } from '@lib/merge/segments';
import { build, garble, rng, type Line } from './scenario';

const lines: Line[] = [
  { speaker: 'Camille', text: 'Bonjour à tous, on commence par le point sur Lumind.' },
  { speaker: 'David', text: 'Yes, the onboarding flow shipped on Monday.' },
  { speaker: 'Camille', text: 'Super, et les retours des premiers utilisateurs?' },
  { speaker: 'David', text: 'Mostly positive, but the export to Notion is still slow.' },
  { speaker: 'Camille', text: "D'accord, il faut regarder ça cette semaine." },
  { speaker: 'David', text: "I can take it, I'll pair with Sophie tomorrow." },
];

describe('estimateLags', () => {
  it('recovers separate start and end lags from readable captions', () => {
    const s = build(lines, { startLag: 2500, endLag: 3100, jitter: 200, seed: 5 });
    const lags = estimateLags(s.words, prepareSegments(s.captions, ''));

    expect(lags.start).not.toBeNull();
    expect(lags.end).not.toBeNull();
    expect(Math.abs(lags.start! - 2500)).toBeLessThanOrEqual(200);
    expect(Math.abs(lags.end! - 3100)).toBeLessThanOrEqual(200);
  });

  it('handles captions that appear slightly before the audio clock (negative lag)', () => {
    const s = build(lines, { startLag: -400, endLag: -200, seed: 6 });
    const lags = estimateLags(s.words, prepareSegments(s.captions, ''));
    expect(lags.start).toBe(-400);
    expect(lags.end).toBe(-200);
  });

  it('gives up when caption text does not match the audio', () => {
    const s = build(
      lines.map((l, k) => ({ ...l, caption: garble(l.text, k + 1) })),
      { startLag: 1500, endLag: 1500, seed: 7 },
    );
    expect(estimateLags(s.words, prepareSegments(s.captions, ''))).toEqual({ start: null, end: null });
  });

  it('gives up with too few readable blocks', () => {
    const s = build(lines.slice(0, 2), { seed: 8 });
    expect(estimateLags(s.words, prepareSegments(s.captions, ''))).toEqual({ start: null, end: null });
  });
});

describe('estimateLagsFromTiming', () => {
  // A French meeting captioned in English: no caption word is usable.
  const meeting = (n: number, seed: number): Line[] => {
    const rand = rng(seed);
    const out: Line[] = [];
    for (let k = 0; k < n; k++) {
      const text = lines[Math.floor(rand() * lines.length)]!.text;
      out.push({
        speaker: k % 2 ? 'David' : 'Camille',
        text,
        caption: garble(text, k + 1),
        gap: 150 + Math.floor(rand() * 900),
      });
    }
    return out;
  };

  it('finds start and end lags from where caption blocks begin and end', () => {
    for (const [startLag, endLag] of [
      [1000, 1500],
      [2500, 3500],
      [400, 2200],
    ] as const) {
      const s = build(meeting(40, startLag), { startLag, endLag, jitter: 300, seed: 3 });
      const lags = estimateLagsFromTiming(s.words, prepareSegments(s.captions, ''));
      expect(Math.abs(lags.start! - startLag), `start ${startLag}`).toBeLessThanOrEqual(300);
      expect(Math.abs(lags.end! - endLag), `end ${endLag}`).toBeLessThanOrEqual(300);
    }
  });

  it('gives up with too few caption blocks', () => {
    const s = build(meeting(3, 1), { startLag: 1500, endLag: 1500 });
    expect(estimateLagsFromTiming(s.words, prepareSegments(s.captions, ''))).toEqual({ start: null, end: null });
  });

  it('gives up when speech has no pauses to anchor on', () => {
    // One unbroken stream of words; blocks cut it at arbitrary points.
    const s = build(meeting(30, 2).map((l) => ({ ...l, gap: 60 })), { startLag: 1500, endLag: 1500, seed: 4 });
    const words = s.words.map((w, i) => ({ ...w, start: i * 300, end: i * 300 + 300 }));
    const lags = estimateLagsFromTiming(words, prepareSegments(s.captions, ''));
    expect(lags).toEqual({ start: null, end: null });
  });
});
