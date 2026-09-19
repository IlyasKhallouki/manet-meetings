import { describe, expect, it } from 'vitest';
import {
  combinePasses,
  joinOverlappingTexts,
  ownershipWindows,
  stitchTextParts,
  stitchTimingParts,
  TranscriptionError,
  uncoveredRanges,
  type PartOutcome,
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

const texts = (ws: TimedWord[]) => ws.map((x) => x.text);

/** Successful part outcomes, as transcribeParts builds them. */
const timed = (startMs: number, endMs: number, value: TimedWord[], incomplete?: boolean): PartOutcome<TimedWord[]> => ({
  startMs,
  endMs,
  ok: true,
  value,
  ...(incomplete ? { incomplete } : {}),
});
const said = (startMs: number, endMs: number, value: string, incomplete?: boolean): PartOutcome<string> => ({
  startMs,
  endMs,
  ok: true,
  value,
  ...(incomplete ? { incomplete } : {}),
});
const failed = (startMs: number, endMs: number, error: string, transient = false): PartOutcome<never> => ({
  startMs,
  endMs,
  ok: false,
  error,
  transient,
});

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
    expect(texts(out)).toEqual(['a', 'b', 'shared', 'c', 'd']);
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
    expect(texts(out)).toEqual(['early', 'late']);
  });

  // Each part times the overlap on its own, so a word near the midpoint (27.5 s)
  // can land on either side of it in each part.
  it('keeps a boundary word once when both parts put it on their own side of the midpoint', () => {
    const out = stitchTimingParts([
      { startMs: 0, endMs: 30_000, words: [w('please', 26_800), w('visit', 27_490), w('librivox', 28_100)] },
      { startMs: 25_000, endMs: 55_000, words: [w('please', 1_850), w('visit', 2_530), w('librivox', 3_140)] },
    ]);
    expect(texts(out)).toEqual(['please', 'visit', 'librivox']);
  });

  it('keeps a boundary word when both parts put it on the other side of the midpoint', () => {
    const out = stitchTimingParts([
      { startMs: 0, endMs: 30_000, words: [w('please', 26_800), w('visit', 27_510), w('librivox', 28_100)] },
      { startMs: 25_000, endMs: 55_000, words: [w('please', 1_850), w('visit', 2_470), w('librivox', 3_140)] },
    ]);
    expect(texts(out)).toEqual(['please', 'visit', 'librivox']);
  });

  it('cuts at the midpoint when the overlap has no word in common', () => {
    const out = stitchTimingParts([
      { startMs: 0, endMs: 30_000, words: [w('bonjour', 20_000), w('hum', 27_000), w('tail', 29_000)] },
      { startMs: 25_000, endMs: 55_000, words: [w('head', 500), w('euh', 2_600), w('merci', 10_000)] },
    ]);
    expect(texts(out)).toEqual(['bonjour', 'hum', 'euh', 'merci']);
  });

  it('does not match the same word heard seconds apart', () => {
    // "okay" at 26 s in the first part and 29 s in the second are two different "okay"s.
    const out = stitchTimingParts([
      { startMs: 0, endMs: 30_000, words: [w('okay', 26_000), w('so', 27_000)] },
      { startMs: 25_000, endMs: 55_000, words: [w('right', 3_000), w('okay', 4_000)] },
    ]);
    expect(texts(out)).toEqual(['okay', 'so', 'right', 'okay']);
  });
});

describe('stitching overlapping parts that disagree on times', () => {
  /** Deterministic speech from a small, repetitive EN/FR vocabulary, with pauses. */
  function speech(seed: number) {
    let x = seed;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const vocab = 'the a and to of we i you it is so that on for this ok yes no le la de et je tu on est'.split(' ');
    const truth: TimedWord[] = [];
    let t = 200;
    for (let k = 0; k < 420; k++) {
      t += 250 + Math.floor(rnd() * 400) + (rnd() < 0.05 ? 3000 : 0);
      truth.push(w(vocab[Math.floor(rnd() * vocab.length)]!, t, t + 220));
    }
    return { truth, rnd };
  }

  it('keeps every word once, in order, whatever the clock skew of each part', () => {
    const spans = [[0, 60_000], [50_000, 110_000], [100_000, 170_000], [160_000, 260_000]] as const;
    for (let seed = 1; seed <= 100; seed++) {
      const { truth, rnd } = speech(seed);
      // Each part hears whole words only and runs its own clock: a skew of up to ±200 ms, plus ±50 ms per word.
      const parts = spans.map(([startMs, endMs]) => {
        const skew = Math.round((rnd() - 0.5) * 400);
        const heard = truth.filter((x) => x.start >= startMs + 150 && x.end <= endMs - 150);
        return {
          startMs,
          endMs,
          words: heard.map((x) => {
            const jitter = skew + Math.round((rnd() - 0.5) * 100);
            return w(x.text, x.start - startMs + jitter, x.end - startMs + jitter);
          }),
        };
      });
      const timing = stitchTimingParts(parts);
      const expected = texts(truth.filter((x) => x.end <= 260_000 - 150));
      expect(texts(timing), `seed ${seed}`).toEqual(expected);
      expect(sorted(timing), `seed ${seed}`).toBe(true);

      const textParts = [[0, 130_000], [120_000, 260_000]].map(([startMs, endMs]) => ({
        startMs: startMs!,
        endMs: endMs!,
        text: truth
          .filter((x) => x.start >= startMs! + 150 && x.end <= endMs! - 150)
          .map((x) => x.text.toUpperCase())
          .join(' '),
      }));
      const out = stitchTextParts(textParts, timing);
      expect(texts(out), `seed ${seed}`).toEqual(expected.map((t) => t.toUpperCase()));
    }
  });
});

describe('stitchTextParts', () => {
  it('puts text-pass spelling on timing-pass times', () => {
    const timing = [w('hello', 0), w('lumen', 500), w('team', 1000)];
    const out = stitchTextParts([{ startMs: 0, endMs: 2000, text: 'Hello Lumind team.' }], timing);
    expect(texts(out)).toEqual(['Hello', 'Lumind', 'team.']);
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
    expect(texts(out)).toEqual(ticks(0, 20).map((x) => x.text.toUpperCase()));
    expect(out.map((x) => x.start)).toEqual(timing.map((x) => x.start));
  });

  it('keeps an untimed word near the midpoint once', () => {
    // The timing pass missed "ten" (no word between 9 s and 11 s); both text parts
    // heard it and interpolate it on either side of the 10 s midpoint.
    const timing = [...ticks(0, 10), ...ticks(11, 20)];
    const out = stitchTextParts(
      [
        { startMs: 0, endMs: 12_000, text: `${words(0, 10)} ten w11` },
        { startMs: 8_000, endMs: 20_000, text: `w8 w9 um ten ${words(11, 20)}` },
      ],
      timing,
    );
    expect(texts(out).filter((t) => t === 'ten')).toHaveLength(1);
    expect(texts(out).filter((t) => /^w\d+$/.test(t))).toEqual(timing.map((x) => x.text));
    expect(sorted(out)).toBe(true);
  });

  it('spreads text over its window when the timing pass heard nothing there', () => {
    const out = stitchTextParts([{ startMs: 0, endMs: 3000, text: 'un deux trois' }], []);
    expect(texts(out)).toEqual(['un', 'deux', 'trois']);
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
    expect(texts(out)).toEqual(texts(timing));
  });

  it('keeps the timing words after the point where a text part was cut short', () => {
    const out = stitchTextParts([{ startMs: 0, endMs: 100_000, text: words(0, 60, (s) => s.toUpperCase()) }], ticks(0, 100));
    expect(texts(out)).toEqual([...words(0, 60).toUpperCase().split(' '), ...words(60, 100).split(' ')]);
    expect(out.slice(60)).toEqual(ticks(60, 100));
  });

  it('keeps a stretch the text pass skipped (a code-switched aside)', () => {
    const heard = "we agreed to ship on friday oui c'est bon on verra ça demain and paul owns the notes";
    const timing = heard.split(' ').map((t, k) => w(t, k * 400));
    const out = stitchTextParts(
      [{ startMs: 0, endMs: 10_000, text: 'We agreed to ship on Friday, and Paul owns the notes.' }],
      timing,
    );
    expect(out.map((x) => x.text).join(' ')).toBe(
      "We agreed to ship on Friday, oui c'est bon on verra ça demain and Paul owns the notes.",
    );
  });

  it('does not add timing words for a short rewording', () => {
    const timing = 'the budget is twenty six million for now'.split(' ').map((t, k) => w(t, k * 400));
    const out = stitchTextParts([{ startMs: 0, endMs: 5000, text: 'The budget is 26M$ for now.' }], timing);
    expect(texts(out)).toEqual(['The', 'budget', 'is', '26M$', 'for', 'now.']);
  });

  it('spreads text past a cut-short timing part toward the end of the audio', () => {
    // Timing stops at 59 s of a 100 s part; the text pass heard all 100 words.
    const out = stitchTextParts([{ startMs: 0, endMs: 100_000, text: words(0, 100) }], ticks(0, 60));
    expect(out).toHaveLength(100);
    expect(out.at(-1)!.start).toBeGreaterThan(90_000);
    expect(out.at(-1)!.end).toBeLessThanOrEqual(100_000);
    expect(sorted(out)).toBe(true);
  });

  it('keeps timing words where no text part succeeded', () => {
    const timing = ticks(0, 90);
    const out = stitchTextParts(
      [
        { startMs: 0, endMs: 35_000, text: words(0, 35, (s) => s.toUpperCase()) },
        // The text part for 30–65 s failed.
        { startMs: 60_000, endMs: 90_000, text: words(60, 90, (s) => s.toUpperCase()) },
      ],
      timing,
    );
    expect(out.map((x) => x.text.toLowerCase())).toEqual(texts(timing));
    expect(texts(out)[40]).toBe('w40');
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

  it('dedupes a realistic overlap despite a recognition difference', () => {
    const a =
      'ok so the plan is to freeze the build on thursday then we run the full regression suite and if the numbers ' +
      'look fine we tag the release candidate and send it to the beta group on friday morning';
    const b =
      'we tag the release candidat and send it to the beta group on friday morning after that marie handles the ' +
      'store listing and the screenshots';
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 40_000, text: a },
        { startMs: 30_000, endMs: 60_000, text: b },
      ]),
    ).toBe(`${a} after that marie handles the store listing and the screenshots`);
  });

  it('concatenates when the overlap shares no words (silence)', () => {
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 8000, text: 'alpha beta' },
        { startMs: 5000, endMs: 11_000, text: 'gamma delta' },
      ]),
    ).toBe('alpha beta gamma delta');
  });

  it('concatenates unrelated English texts that only share function words', () => {
    // Nobody spoke in the 30–60 s overlap: stray "the/and/for/of" matches are not an overlap.
    const a =
      'so for the release we still need the final build and the notes and then we can look at the date for the ' +
      'launch and the review of the last bugs is on me and the rest of the team will test the app on the new ' +
      'phones this week';
    const b =
      'on the budget side we spent more than planned on the servers and the ads so for the next quarter i want a ' +
      'clear plan with the numbers per month and a review with finance at the end of each month';
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 60_000, text: a },
        { startMs: 30_000, endMs: 90_000, text: b },
      ]),
    ).toBe(`${a} ${b}`);
  });

  it('concatenates unrelated French texts that only share function words', () => {
    const a =
      "alors pour la sortie il nous faut encore la version finale et les notes de version et ensuite on regarde " +
      "la date du lancement avec l'équipe de test qui passe sur les nouveaux téléphones cette semaine";
    const b =
      "côté budget on a dépensé plus que prévu sur les serveurs et la publicité donc pour le prochain trimestre " +
      "je veux un plan clair avec les chiffres par mois et une revue avec la finance à la fin de chaque mois";
    expect(
      joinOverlappingTexts([
        { startMs: 0, endMs: 60_000, text: a },
        { startMs: 30_000, endMs: 90_000, text: b },
      ]),
    ).toBe(`${a} ${b}`);
  });
});

describe('uncoveredRanges', () => {
  it('lists the spans no successful part covered', () => {
    expect(
      uncoveredRanges([
        timed(0, 30_000, []),
        failed(25_000, 55_000, 'boom'),
        timed(50_000, 80_000, []),
        failed(0, 45_000, 'boom'),
        failed(40_000, 80_000, 'boom'),
      ]),
    ).toEqual([{ start: 30_000, end: 50_000 }]);
    expect(uncoveredRanges([timed(0, 30_000, []), failed(25_000, 55_000, 'boom')])).toEqual([
      { start: 30_000, end: 55_000 },
    ]);
    expect(uncoveredRanges([timed(0, 30_000, []), said(0, 30_000, '')])).toEqual([]);
  });
});

describe('combinePasses', () => {
  const timingWords = [w('hello', 0), w('lumen', 500), w('team', 1000)];
  const one = (value: TimedWord[]) => [timed(0, 2000, value)];
  const oneText = (value: string) => [said(0, 2000, value)];

  it('uses text-pass spelling on timing-pass times when both passes worked', () => {
    const r = combinePasses(one(timingWords), oneText('Hello Lumind team'));
    expect(r.timingPass).toEqual({ ok: true });
    expect(r.textPass).toEqual({ ok: true });
    expect(texts(r.words)).toEqual(['Hello', 'Lumind', 'team']);
    expect(r.words[0]!.start).toBe(0);
    expect(r.text).toBe('Hello Lumind team');
    expect(r).not.toHaveProperty('gaps');
  });

  it('falls back to timing-pass words when the text pass failed', () => {
    const r = combinePasses(one(timingWords), [failed(0, 2000, 'quota')]);
    expect(r.words).toEqual(timingWords);
    expect(r.text).toBe('hello lumen team');
    expect(r.textPass).toEqual({ ok: false, error: 'quota' });
    expect(r.timingPass).toEqual({ ok: true });
    expect(r).not.toHaveProperty('gaps');
  });

  it('returns untimed text-pass text when the timing pass failed', () => {
    const r = combinePasses([failed(0, 2000, 'timeout')], oneText('Hello Lumind team'));
    expect(r.words).toEqual([]);
    expect(r.text).toBe('Hello Lumind team');
    expect(r.timingPass).toEqual({ ok: false, error: 'timeout' });
    expect(r.textPass).toEqual({ ok: true });
  });

  it('keeps the timing words a truncated text part did not reach', () => {
    const r = combinePasses([timed(0, 100_000, ticks(0, 100))], [said(0, 100_000, words(0, 60))]);
    expect(r.words).toHaveLength(100);
    expect(r.text).toBe(words(0, 100));
  });

  it('warns about a part that came back incomplete', () => {
    const r = combinePasses(
      [timed(0, 1_680_000, ticks(0, 10)), timed(1_650_000, 3_330_000, []), timed(3_300_000, 6_600_000, [], true)],
      [said(0, 3_300_000, words(0, 10)), said(3_270_000, 6_600_000, 'la suite', true)],
    );
    expect(r.textPass).toEqual({ ok: true, warning: 'text pass part 2 (54:30–1:50:00) was cut short' });
    expect(r.timingPass).toEqual({ ok: true, warning: 'timing pass part 3 (55:00–1:50:00) was cut short' });
    expect(r).not.toHaveProperty('gaps');
  });

  it('names the range of a single-part pass that was cut short', () => {
    const r = combinePasses(one(timingWords), [said(0, 2000, 'Hello', true)]);
    expect(r.textPass).toEqual({ ok: true, warning: 'text pass (0:00–0:02) was cut short' });
    expect(texts(r.words)).toEqual(['Hello', 'lumen', 'team']);
  });

  it('keeps the parts that succeeded and reports what no part covered', () => {
    const r = combinePasses(
      [timed(0, 30_000, ticks(0, 30)), failed(25_000, 55_000, 'interaction failed'), timed(50_000, 80_000, ticks(0, 30))],
      [said(0, 45_000, words(0, 45)), failed(40_000, 80_000, 'Could not reach Gemini', true)],
    );
    expect(r.timingPass).toEqual({ ok: true, warning: 'timing pass part 2 (0:25–0:55) failed: interaction failed' });
    expect(r.textPass).toEqual({ ok: true, warning: 'text pass part 2 (0:40–1:20) failed: Could not reach Gemini' });
    expect(r.gaps).toEqual([{ start: 45_000, end: 50_000 }]);
    const starts = r.words.map((x) => x.start);
    // Text words up to 45 s (timed where the timing pass has words), timing words from 50 s.
    expect(texts(r.words).slice(0, 30)).toEqual(texts(ticks(0, 30)));
    expect(r.words.filter((x) => x.start >= 50_000)).toHaveLength(30);
    expect(starts.every((s) => s < 45_000 || s >= 50_000)).toBe(true);
    expect(sorted(r.words)).toBe(true);
  });

  it('fails a pass only when every part failed', () => {
    const r = combinePasses(
      [timed(0, 30_000, ticks(0, 30)), timed(25_000, 55_000, ticks(0, 30))],
      [failed(0, 45_000, 'quota'), failed(40_000, 55_000, 'quota')],
    );
    expect(r.textPass).toEqual({ ok: false, error: 'quota' });
    expect(r.timingPass).toEqual({ ok: true });
    expect(r.words.length).toBeGreaterThan(50);
  });

  it('joins the untimed text of the parts that succeeded and reports the gap', () => {
    const r = combinePasses(
      [failed(0, 30_000, 'boom'), failed(25_000, 60_000, 'boom')],
      [said(0, 25_000, 'début'), failed(20_000, 45_000, 'boom'), said(40_000, 60_000, 'fin')],
    );
    expect(r.text).toBe('début fin');
    expect(r.gaps).toEqual([{ start: 25_000, end: 40_000 }]);
    expect(r.timingPass).toEqual({ ok: false, error: 'boom' });
  });

  it('throws with both messages when both passes failed', () => {
    let err: unknown;
    try {
      combinePasses([failed(0, 2000, 'upload refused')], [failed(0, 2000, 'model overloaded')]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TranscriptionError);
    const e = err as TranscriptionError;
    expect(e.message).toContain('upload refused');
    expect(e.message).toContain('model overloaded');
    expect(e.timingError).toBe('upload refused');
    expect(e.textError).toBe('model overloaded');
    expect(e.transient).toBe(false);
  });

  it('marks the failure transient only when every part failed transiently', () => {
    const run = (textTransient: boolean) => {
      try {
        combinePasses(
          [failed(0, 30_000, 'Could not reach Gemini', true), failed(25_000, 55_000, 'timed out', true)],
          [failed(0, 55_000, 'API key not valid', textTransient)],
        );
      } catch (e) {
        return e as TranscriptionError;
      }
      throw new Error('expected a TranscriptionError');
    };
    expect(run(true).transient).toBe(true);
    expect(run(false).transient).toBe(false);
    expect(run(true).timingError).toBe('Could not reach Gemini; timed out');
  });

  it('fails a pass that had no parts', () => {
    const r = combinePasses(one(timingWords), []);
    expect(r.textPass).toEqual({ ok: false, error: 'no audio to transcribe' });
  });
});
