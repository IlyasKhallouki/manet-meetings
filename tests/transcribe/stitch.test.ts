import { describe, expect, it } from 'vitest';
import {
  combinePasses,
  joinOverlappingTexts,
  ownershipWindows,
  stitchTextParts,
  stitchTimingParts,
  TranscriptionError,
} from '@lib/transcribe/stitch';
import type { TimedWord } from '@lib/types';

const w = (text: string, start: number, end = start + 300): TimedWord => ({ text, start, end });

/** One word per second: "w0" at 0 ms, "w1" at 1000 ms, … */
function ticks(from: number, to: number): TimedWord[] {
  return Array.from({ length: to - from }, (_, k) => w(`w${from + k}`, (from + k) * 1000));
}

function words(from: number, to: number, spell = (s: string) => s): string {
  return Array.from({ length: to - from }, (_, k) => spell(`w${from + k}`)).join(' ');
}

function sorted(ws: TimedWord[]): boolean {
  return ws.every((x, k) => k === 0 || x.start >= ws[k - 1]!.start);
}

describe('ownershipWindows', () => {
  it('splits each overlap at its midpoint', () => {
    expect(
      ownershipWindows([
        { startMs: 0, endMs: 100 },
        { startMs: 80, endMs: 200 },
        { startMs: 180, endMs: 300 },
      ]),
    ).toEqual([
      { from: -Infinity, to: 90 },
      { from: 90, to: 190 },
      { from: 190, to: Infinity },
    ]);
  });

  it('gives a single part everything', () => {
    expect(ownershipWindows([{ startMs: 0, endMs: 5000 }])).toEqual([{ from: -Infinity, to: Infinity }]);
  });
});

describe('stitchTimingParts', () => {
  it('shifts part-relative words and keeps each overlap word once', () => {
    const out = stitchTimingParts([
      { startMs: 0, endMs: 100_000, words: [w('a', 10_000), w('b', 50_000), w('shared', 85_000), w('cut', 95_000)] },
      // Starts at 80 s: "shared" again at 85 s, then words past the overlap midpoint (90 s).
      { startMs: 80_000, endMs: 200_000, words: [w('garbled', 1_000), w('shared', 5_000), w('c', 12_000), w('d', 60_000)] },
    ]);
    expect(out.map((x) => x.text)).toEqual(['a', 'b', 'shared', 'c', 'd']);
    expect(out.map((x) => x.start)).toEqual([10_000, 50_000, 85_000, 92_000, 140_000]);
    expect(out[3]).toEqual({ text: 'c', start: 92_000, end: 92_300 });
  });

  it('passes a single part through, shifted and sorted', () => {
    const out = stitchTimingParts([{ startMs: 1000, endMs: 9000, words: [w('b', 2000), w('a', 500)] }]);
    expect(out).toEqual([w('a', 1500), w('b', 3000)]);
  });

  it('orders parts by start time', () => {
    const out = stitchTimingParts([
      { startMs: 80_000, endMs: 200_000, words: [w('late', 20_000)] },
      { startMs: 0, endMs: 100_000, words: [w('early', 1_000)] },
    ]);
    expect(out.map((x) => x.text)).toEqual(['early', 'late']);
  });
});

describe('stitchTextParts', () => {
  it('puts text-pass spelling on timing-pass times', () => {
    const timing = [w('hello', 0), w('lumen', 500), w('team', 1000)];
    const out = stitchTextParts([{ startMs: 0, endMs: 2000, text: 'Hello Lumind team.' }], timing);
    expect(out.map((x) => x.text)).toEqual(['Hello', 'Lumind', 'team.']);
    expect(out[0]).toEqual({ text: 'Hello', start: 0, end: 300 });
    expect(out[2]).toEqual({ text: 'team.', start: 1000, end: 1300 });
    expect(out[1]!.approx).toBe(true);
  });

  it('keeps every word exactly once across overlapping text parts', () => {
    const timing = ticks(0, 20);
    const upper = (s: string) => s.toUpperCase();
    const out = stitchTextParts(
      [
        { startMs: 0, endMs: 12_000, text: words(0, 12, upper) },
        { startMs: 8_000, endMs: 20_000, text: words(8, 20, upper) },
      ],
      timing,
    );
    expect(out.map((x) => x.text)).toEqual(ticks(0, 20).map((x) => x.text.toUpperCase()));
    expect(out.map((x) => x.start)).toEqual(timing.map((x) => x.start));
  });

  it('spreads text over its window when the timing pass heard nothing there', () => {
    const out = stitchTextParts([{ startMs: 0, endMs: 3000, text: 'un deux trois' }], []);
    expect(out.map((x) => x.text)).toEqual(['un', 'deux', 'trois']);
    expect(out.every((x) => x.approx)).toBe(true);
    expect(out[0]!.start).toBe(0);
    expect(out[2]!.end).toBe(3000);
    expect(sorted(out)).toBe(true);
  });

  it('falls back to timing words where a text part came back empty', () => {
    const timing = ticks(0, 20);
    const out = stitchTextParts(
      [
        { startMs: 0, endMs: 12_000, text: words(0, 12) },
        { startMs: 8_000, endMs: 20_000, text: '   ' },
      ],
      timing,
    );
    expect(out.map((x) => x.text)).toEqual(timing.map((x) => x.text));
  });
});

describe('joinOverlappingTexts', () => {
  it('returns a single part as is', () => {
    expect(joinOverlappingTexts([{ startMs: 0, endMs: 1000, text: ' Bonjour à tous. ' }])).toBe('Bonjour à tous.');
  });

  it('drops the words both parts heard in their overlap', () => {
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 8000, text: 'one two three four five six seven eight' },
        { startMs: 5000, endMs: 11_000, text: 'Six, seven eight nine ten eleven' },
      ]),
    ).toBe('one two three four five six seven eight nine ten eleven');
  });

  it('concatenates when the overlap shares no words (silence)', () => {
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 8000, text: 'alpha beta' },
        { startMs: 5000, endMs: 11_000, text: 'gamma delta' },
      ]),
    ).toBe('alpha beta gamma delta');
  });
});

describe('combinePasses', () => {
  const timingWords = [w('hello', 0), w('lumen', 500), w('team', 1000)];
  const textParts = [{ startMs: 0, endMs: 2000, text: 'Hello Lumind team' }];

  it('uses text-pass spelling on timing-pass times when both passes worked', () => {
    const r = combinePasses({ ok: true, value: timingWords }, { ok: true, value: textParts });
    expect(r.timingPass).toEqual({ ok: true });
    expect(r.textPass).toEqual({ ok: true });
    expect(r.words.map((x) => x.text)).toEqual(['Hello', 'Lumind', 'team']);
    expect(r.words[0]!.start).toBe(0);
    expect(r.text).toBe('Hello Lumind team');
  });

  it('falls back to timing-pass words when the text pass failed', () => {
    const r = combinePasses({ ok: true, value: timingWords }, { ok: false, error: 'quota' });
    expect(r.words).toEqual(timingWords);
    expect(r.text).toBe('hello lumen team');
    expect(r.textPass).toEqual({ ok: false, error: 'quota' });
    expect(r.timingPass).toEqual({ ok: true });
  });

  it('returns untimed text-pass text when the timing pass failed', () => {
    const r = combinePasses({ ok: false, error: 'timeout' }, { ok: true, value: textParts });
    expect(r.words).toEqual([]);
    expect(r.text).toBe('Hello Lumind team');
    expect(r.timingPass).toEqual({ ok: false, error: 'timeout' });
    expect(r.textPass).toEqual({ ok: true });
  });

  it('throws with both messages when both passes failed', () => {
    let err: unknown;
    try {
      combinePasses({ ok: false, error: 'upload refused' }, { ok: false, error: 'model overloaded' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TranscriptionError);
    const e = err as TranscriptionError;
    expect(e.message).toContain('upload refused');
    expect(e.message).toContain('model overloaded');
    expect(e.timingError).toBe('upload refused');
    expect(e.textError).toBe('model overloaded');
  });
});
