import { describe, expect, it } from 'vitest';
import { alignTokens, normalizeToken, splitWords, transferTimes } from '@lib/align/sequence';
import type { TimedWord } from '@lib/types';

const words = (s: string) => splitWords(s).map(normalizeToken);

describe('normalizeToken', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeToken('Réunion,')).toBe('reunion');
    expect(normalizeToken("C'est")).toBe('cest');
    expect(normalizeToken('"OK."')).toBe('ok');
    expect(normalizeToken('26M$')).toBe('26m');
    expect(normalizeToken('—')).toBe('');
  });
});

describe('alignTokens', () => {
  it('matches identical sequences one to one', () => {
    const a = words('the quick brown fox');
    expect(alignTokens(a, a)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('skips insertions and substitutions on either side', () => {
    const a = words('we ship Lumind on Monday next week');
    const b = words('uh we ship lumen on Monday week');
    const pairs = alignTokens(a, b);
    const matched = pairs.map(([i, j]) => [a[i], b[j]]);
    expect(matched).toEqual([
      ['we', 'we'],
      ['ship', 'ship'],
      ['on', 'on'],
      ['monday', 'monday'],
      ['week', 'week'],
    ]);
  });

  it('returns strictly increasing pairs for repetitive text', () => {
    const a = words('yes yes no yes no no yes');
    const b = words('yes no yes yes no yes');
    const pairs = alignTokens(a, b);
    for (let k = 1; k < pairs.length; k++) {
      expect(pairs[k]![0]).toBeGreaterThan(pairs[k - 1]![0]);
      expect(pairs[k]![1]).toBeGreaterThan(pairs[k - 1]![1]);
    }
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
    expect(pairs.length).toBe(5); // LCS length
  });

  it('never matches empty tokens', () => {
    expect(alignTokens(['', 'a'], ['', 'a'])).toEqual([[1, 1]]);
  });

  it('stays fast and accurate on hour-long transcripts', () => {
    const vocab = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi'.split(' ');
    // Deterministic pseudo-random text with lots of repetition.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const a = Array.from({ length: 12_000 }, () => vocab[Math.floor(rnd() * vocab.length)]!);
    // b = a with ~5% deletions and ~5% insertions.
    const b: string[] = [];
    for (const w of a) {
      const r = rnd();
      if (r < 0.05) continue;
      b.push(w);
      if (r > 0.95) b.push('noise');
    }
    const t0 = performance.now();
    const pairs = alignTokens(a, b);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(3000);
    expect(pairs.length).toBeGreaterThan(a.length * 0.9);
  });
});

describe('transferTimes', () => {
  const timed = (s: string, stepMs = 500): TimedWord[] =>
    splitWords(s).map((text, i) => ({ text, start: i * stepMs, end: i * stepMs + 400 }));

  it('copies times for matched words and keeps source spelling', () => {
    const out = transferTimes(splitWords('Hello Lumind team'), timed('hello lumind team'));
    expect(out).toEqual([
      { text: 'Hello', start: 0, end: 400 },
      { text: 'Lumind', start: 500, end: 900 },
      { text: 'team', start: 1000, end: 1400 },
    ]);
  });

  it('interpolates unmatched words between matched neighbours', () => {
    const out = transferTimes(splitWords('we ship Lumind today'), timed('we ship lumen today'));
    expect(out[2]).toMatchObject({ text: 'Lumind', approx: true });
    expect(out[2]!.start).toBeGreaterThanOrEqual(out[1]!.end);
    expect(out[2]!.end).toBeLessThanOrEqual(out[3]!.start);
  });

  it('keeps output sorted and within the target span when edges are unmatched', () => {
    const out = transferTimes(splitWords('so um we ship it right'), timed('we ship it'));
    for (let k = 1; k < out.length; k++) expect(out[k]!.start).toBeGreaterThanOrEqual(out[k - 1]!.start);
    expect(out[0]!.start).toBeGreaterThanOrEqual(0);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(1400 + 1000);
    expect(out.filter((w) => !w.approx).map((w) => w.text)).toEqual(['we', 'ship', 'it']);
  });

  it('spreads words evenly when nothing matches', () => {
    const out = transferTimes(splitWords('bonjour à tous'), timed('hello everyone'));
    expect(out).toHaveLength(3);
    expect(out.every((w) => w.approx)).toBe(true);
    expect(out[0]!.start).toBe(0);
    expect(out[2]!.end).toBe(900);
  });

  it('returns nothing without timing to transfer', () => {
    expect(transferTimes(splitWords('hello'), [])).toEqual([]);
  });
});
