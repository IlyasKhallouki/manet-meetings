import { describe, expect, it } from 'vitest';
import { splitWords } from '@lib/align/sequence';
import { mergeTranscript, UNKNOWN_SPEAKER } from '@lib/merge';
import type { CaptionSegment, TimedWord } from '@lib/types';
import { accuracy, build, garble, labelsOf, rng, speak, squash, type Line } from './scenario';

const CAMILLE = 'Camille Martin';
const DAVID = 'David Chen';
const SOPHIE = 'Sophie Laurent';

const standup: Line[] = [
  { speaker: CAMILLE, text: 'Bonjour à tous, on commence par le point sur Lumind.' },
  { speaker: DAVID, text: 'Yes, the onboarding flow shipped on Monday.', gap: 700 },
  { speaker: CAMILLE, text: 'Super, et les retours des premiers utilisateurs?', gap: 450 },
  { speaker: DAVID, text: 'Mostly positive, but the export to Notion is still slow.', gap: 900 },
  { speaker: CAMILLE, text: "D'accord, il faut regarder ça cette semaine.", gap: 500 },
  { speaker: DAVID, text: "I can take it, I'll pair with Sophie tomorrow.", gap: 600 },
  { speaker: CAMILLE, text: 'Parfait, merci David.', gap: 400 },
  { speaker: DAVID, text: 'No problem.', gap: 800 },
];

const inputOf = (s: { words: TimedWord[]; captions: CaptionSegment[] }, extra: object = {}) => ({
  words: s.words,
  captions: s.captions,
  selfName: 'Ilyas',
  ...extra,
});

describe('mergeTranscript: words + captions', () => {
  it('labels two alternating speakers through a 1–2 s caption lag', () => {
    const s = build(standup, { startLag: 1200, endLag: 1800, jitter: 300 });
    const t = mergeTranscript(inputOf(s));

    expect(t.source).toBe('audio+captions');
    expect(t.notes).toEqual([]);
    expect(labelsOf(t)).toEqual(s.expected);
    expect(t.turns.map((x) => x.speaker)).toEqual(standup.map((l) => l.speaker));
    expect(t.turns.map((x) => x.text)).toEqual(standup.map((l) => l.text));
    t.turns.forEach((turn, k) => {
      expect(turn.start).toBe(s.lines[k]![0]!.start);
      expect(turn.end).toBe(s.lines[k]!.at(-1)!.end);
    });
  });

  it('handles three speakers and replaces the self label with selfName', () => {
    const lines: Line[] = [
      { speaker: 'You', self: true, text: "Ok, let's go through the roadmap quickly." },
      { speaker: CAMILLE, text: "Alors, pour la V2 on vise fin octobre.", gap: 500 },
      { speaker: SOPHIE, text: 'The design system is ready, I sent the Figma link.', gap: 650 },
      { speaker: 'You', self: true, text: 'Great, thanks Sophie.', gap: 400 },
      { speaker: DAVID, text: 'Et le backend? On en parle maintenant?', gap: 550 },
      { speaker: CAMILLE, text: "Non, on garde ça pour jeudi.", gap: 300 },
    ];
    const s = build(lines, { selfName: 'Ilyas', jitter: 250, seed: 9 });
    const t = mergeTranscript(inputOf(s));

    expect(labelsOf(t)).toEqual(s.expected);
    expect(new Set(t.turns.map((x) => x.speaker))).toEqual(new Set(['Ilyas', CAMILLE, SOPHIE, DAVID]));
    expect(t.turns.some((x) => x.speaker === 'You')).toBe(false);
  });

  it('keeps speaker changes right in rapid exchanges with a slow caption refinement', () => {
    const lines: Line[] = [
      { speaker: CAMILLE, text: 'Tu as vu le mail de Stripe ce matin?' },
      { speaker: DAVID, text: 'Yes, they approved the account.', gap: 40 },
      { speaker: CAMILLE, text: 'Génial, donc on peut lancer lundi.', gap: 0 },
      { speaker: DAVID, text: 'Monday works, I will update the changelog.', gap: 90 },
      { speaker: CAMILLE, text: 'Et préviens Sophie aussi.', gap: 20 },
      { speaker: DAVID, text: 'Sure, doing it now.', gap: 60 },
    ];
    const s = build(lines, { startLag: 1000, endLag: 2600, jitter: 250, seed: 4 });
    const t = mergeTranscript(inputOf(s));

    expect(labelsOf(t)).toEqual(s.expected);
    expect(t.turns).toHaveLength(lines.length);
  });

  it('labels short interjections (oui, ok) inside another speaker’s turn', () => {
    const lines: Line[] = [
      {
        speaker: DAVID,
        text: 'So the plan for next week is to finish the Notion export and then start on the calendar sync with Google.',
      },
      { speaker: CAMILLE, text: 'Oui.', interject: 5 },
      { speaker: CAMILLE, text: 'OK.', caption: 'Okay.', interject: 13 },
    ];
    for (const splitCaption of [false, true]) {
      const s = build(
        lines.map((l) => (l.interject === undefined ? l : { ...l, splitCaption })),
        { jitter: 150, seed: 11 },
      );
      const t = mergeTranscript(inputOf(s));
      expect(labelsOf(t), `splitCaption=${splitCaption}`).toEqual(s.expected);
      expect(t.turns.map((x) => x.speaker)).toEqual([DAVID, CAMILLE, DAVID, CAMILLE, DAVID]);
      expect(t.turns.map((x) => x.text)).toContain('Oui.');
      expect(t.turns.map((x) => x.text)).toContain('OK.');
    }
  });

  it('keeps uncaptioned fillers (euh, um) with the turn they start', () => {
    // Gemini's verbatim mode keeps fillers that Meet leaves out of the captions, so
    // the only clue is that speakers change at pauses.
    for (const frenchCaptionedInEnglish of [false, true]) {
      const lines: Line[] = [];
      for (let round = 0; round < 3; round++) {
        standup.forEach((l, k) => {
          const caption = frenchCaptionedInEnglish && l.speaker === CAMILLE ? garble(l.text, k + round) : l.text;
          const text = `${k % 2 ? 'Um,' : 'Euh,'} ${l.text}`;
          lines.push({ ...l, text, caption, gap: 180 + ((k * 97 + round * 53) % 300) });
        });
      }
      const s = build(lines, { startLag: 1200, endLag: 1900, jitter: 400, seed: 23 });
      const t = mergeTranscript(inputOf(s));

      expect(t.turns.map((x) => x.text), `garbled=${frenchCaptionedInEnglish}`).toEqual(lines.map((l) => l.text));
      expect(labelsOf(t)).toEqual(s.expected);
    }
  });

  it('separates overlapping speech using caption text', () => {
    const lines: Line[] = [
      { speaker: DAVID, text: 'I think we should move the launch to October because the payment provider is not ready.' },
      { speaker: CAMILLE, text: 'Non, on peut garder septembre si on coupe la facturation annuelle.', gap: -1600 },
      { speaker: DAVID, text: 'Hmm, that could work actually.', gap: 500 },
    ];
    const s = build(lines, { jitter: 200, seed: 5 });
    // The overlap really interleaves the two speakers' words.
    const firstCamille = s.expected.indexOf(CAMILLE);
    expect(s.expected.slice(firstCamille).includes(DAVID)).toBe(true);

    const t = mergeTranscript(inputOf(s));
    expect(labelsOf(t)).toEqual(s.expected);
  });

  it('assigns speakers from timing alone when caption text is in the wrong language', () => {
    const lines = standup.map((l, k) => ({ ...l, caption: garble(l.text, k + 1) }));
    const s = build(lines, { startLag: 1200, endLag: 1800, jitter: 300, seed: 2 });
    const t = mergeTranscript(inputOf(s));

    expect(labelsOf(t)).toEqual(s.expected);
    expect(t.turns.map((x) => x.text)).toEqual(standup.map((l) => l.text));
  });

  it('stays accurate on rapid exchanges with garbage captions', () => {
    const gaps = [0, 120, 60, 200, 30, 150, 80, 0];
    const lines: Line[] = [];
    for (let round = 0; round < 4; round++) {
      standup.forEach((l, k) => lines.push({ ...l, gap: gaps[k], caption: garble(l.text, round * 10 + k + 7) }));
    }
    const s = build(lines, { startLag: 1300, endLag: 1700, jitter: 250, seed: 8 });
    const t = mergeTranscript(inputOf(s));

    // Without readable text, ±250 ms of lag noise can move a word across a gapless
    // turn change; every turn change must still be found.
    expect(accuracy(labelsOf(t), s.expected)).toBeGreaterThanOrEqual(0.95);
    expect(t.turns.map((x) => x.speaker)).toEqual(lines.map((l) => l.speaker));
  });

  it('learns an unusual caption lag from the speakers whose captions are readable', () => {
    // David speaks English (captioned well); Camille speaks French into English captions.
    const lines: Line[] = [];
    for (let k = 0; k < 6; k++) {
      lines.push({ speaker: DAVID, text: standup[(2 * k + 1) % standup.length]!.text, gap: 250 });
      const fr = standup[(2 * k) % standup.length]!.text;
      lines.push({ speaker: CAMILLE, text: fr, caption: garble(fr, k + 20), gap: 300 });
    }
    const s = build(lines, { startLag: 3000, endLag: 3600, jitter: 200, seed: 6 });
    const t = mergeTranscript(inputOf(s));

    expect(accuracy(labelsOf(t), s.expected)).toBeGreaterThanOrEqual(0.97);
  });

  it('learns the caption lag from timing when no caption text is usable', () => {
    const lines: Line[] = [];
    for (let k = 0; k < 24; k++) {
      const l = standup[k % standup.length]!;
      lines.push({ ...l, caption: garble(l.text, k + 50), gap: 200 + ((k * 337) % 700) });
    }
    const s = build(lines, { startLag: 2600, endLag: 3400, jitter: 250, seed: 14 });
    const t = mergeTranscript(inputOf(s));

    expect(accuracy(labelsOf(t), s.expected)).toBeGreaterThanOrEqual(0.97);
  });

  it('honours an explicit captionLagMs', () => {
    const lines = standup.map((l, k) => ({ ...l, caption: garble(l.text, k + 30) }));
    const s = build(lines, { startLag: 3200, endLag: 3200, jitter: 150, seed: 12 });

    const t = mergeTranscript(inputOf(s, { captionLagMs: 3200 }));
    expect(labelsOf(t)).toEqual(s.expected);
  });

  it('marks words as Unknown speaker where captions are missing for a stretch', () => {
    const lines: Line[] = [
      ...standup.slice(0, 3),
      ...standup.map((l) => ({ ...l, caption: null, gap: 500 })),
      ...standup.slice(3, 6).map((l) => ({ ...l, gap: 500 })),
    ];
    const s = build(lines, { jitter: 200, seed: 13 });
    const t = mergeTranscript(inputOf(s));
    const labels = labelsOf(t);

    expect(labels).toHaveLength(s.words.length);
    const captioned = (k: number) => k < 3 || k >= 3 + standup.length;
    let from = 0;
    s.lines.forEach((lineWords, k) => {
      const got = labels.slice(from, from + lineWords.length);
      if (captioned(k)) expect(got, `line ${k}`).toEqual(lineWords.map(() => lines[k]!.speaker));
      from += lineWords.length;
    });
    // The middle of the uncaptioned stretch is far from any caption block.
    const midStart = s.lines.slice(0, 7).reduce((n, l) => n + l.length, 0);
    expect(labels.slice(midStart, midStart + s.lines[7]!.length).every((x) => x === UNKNOWN_SPEAKER)).toBe(true);
    expect(t.notes.some((n) => /speaker unknown/i.test(n) && /\d\d:\d\d:\d\d/.test(n))).toBe(true);
  });

  it('smooths an implausible one- or two-word flip inside continuous speech', () => {
    const words = speak('we should probably ask the accountant before we change the pricing page again this week', 1000);
    const lag = 1500;
    const captions: CaptionSegment[] = [
      {
        id: 'a',
        speaker: DAVID,
        self: false,
        text: garble(words.map((w) => w.text).join(' ')),
        tStart: words[0]!.start + lag,
        tEnd: words.at(-1)!.end + lag,
        rev: 9,
      },
      // A spurious block (noise from someone else's mic) over words 8–9.
      {
        id: 'b',
        speaker: SOPHIE,
        self: false,
        text: 'hm',
        tStart: words[8]!.start + lag,
        tEnd: words[9]!.end + lag,
        rev: 1,
      },
    ];
    const t = mergeTranscript({ words, captions, selfName: 'Ilyas', captionLagMs: lag });

    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.speaker).toBe(DAVID);
  });

  it('splits one speaker into separate turns on a long silence', () => {
    const first = speak('Je partage mon écran.', 2000);
    const second = speak('Voilà, vous voyez le tableau?', first.at(-1)!.end + 6000);
    const words = [...first, ...second];
    const captions: CaptionSegment[] = [
      {
        id: 'x',
        speaker: CAMILLE,
        self: false,
        text: 'Je partage mon écran. Voilà, vous voyez le tableau?',
        tStart: first[0]!.start + 1200,
        tEnd: second.at(-1)!.end + 1800,
        rev: 4,
      },
    ];
    const t = mergeTranscript({ words, captions, selfName: 'Ilyas' });

    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      [CAMILLE, 'Je partage mon écran.'],
      [CAMILLE, 'Voilà, vous voyez le tableau?'],
    ]);
  });

  it('tidies spacing before punctuation and around French elisions', () => {
    const tokens = ['Bon', ',', 'on', 'commence', '?', "L'", 'équipe', 'est', 'là', '(', 'enfin', ')', '.'];
    tokens.push('C’', 'est', 'parti', '!');
    const words = tokens.map((text, i) => ({ text, start: 1000 + i * 300, end: 1000 + i * 300 + 250 }));
    const captions: CaptionSegment[] = [
      { id: 'c', speaker: CAMILLE, self: false, text: 'bon on commence', tStart: 2500, tEnd: 7000, rev: 3 },
    ];
    const t = mergeTranscript({ words, captions, selfName: 'Ilyas' });

    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]!.text).toBe("Bon, on commence? L'équipe est là (enfin). C’est parti!");
  });

  it('never drops or reorders words and returns turns sorted by start', () => {
    const s = build(standup, { jitter: 300, seed: 21 });
    const shuffled = [...s.words];
    const rand = rng(99);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const t = mergeTranscript({ words: shuffled, captions: [...s.captions].reverse(), selfName: 'Ilyas' });

    expect(squash(t.turns.map((x) => x.text))).toBe(squash(s.words.map((w) => w.text)));
    expect(labelsOf(t)).toEqual(s.expected);
    for (let k = 1; k < t.turns.length; k++) expect(t.turns[k]!.start).toBeGreaterThanOrEqual(t.turns[k - 1]!.start);
  });

  it('keeps only the latest revision of each caption block', () => {
    const s = build(standup.slice(0, 2), { seed: 3 });
    const stale = s.captions.map((c) => ({ ...c, speaker: 'Someone Else', rev: 0, tEnd: c.tStart }));
    const t = mergeTranscript({ words: s.words, captions: [...stale, ...s.captions], selfName: 'Ilyas' });

    expect(labelsOf(t)).toEqual(s.expected);
  });

  it('carries input notes through first', () => {
    const s = build(standup.slice(0, 2));
    const t = mergeTranscript(inputOf(s, { notes: ['Text pass failed: quota exceeded'] }));
    expect(t.notes[0]).toBe('Text pass failed: quota exceeded');
  });
});

describe('mergeTranscript: degradation', () => {
  it('words without captions → audio-only, Unknown speaker turns split on pauses', () => {
    const first = speak('Hello, can everyone hear me?', 500);
    const second = speak('Ok, the recording has started.', first.at(-1)!.end + 2500);
    const t = mergeTranscript({ words: [...first, ...second], captions: [], selfName: 'Ilyas', notes: ['n1'] });

    expect(t.source).toBe('audio-only');
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      [UNKNOWN_SPEAKER, 'Hello, can everyone hear me?'],
      [UNKNOWN_SPEAKER, 'Ok, the recording has started.'],
    ]);
    expect(t.turns[1]!.start).toBe(second[0]!.start);
    expect(t.notes[0]).toBe('n1');
    expect(t.notes.some((n) => /captions/i.test(n))).toBe(true);
  });

  it('untimed text + captions → speakers aligned by caption text, approximate times', () => {
    // Text pass spelling (Lumind, Notion) differs from Meet's captions in places.
    const lines: Line[] = standup.map((l) => ({
      ...l,
      caption: l.text.replace('Lumind', 'lumen').replace('Notion', 'notion.').replace('Sophie', 'sofi'),
    }));
    const s = build(lines, { jitter: 200, seed: 17 });
    const text = standup.map((l) => l.text).join('\n');
    const notes = ['Timing pass failed: 500'];
    const t = mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas', notes });

    expect(t.source).toBe('audio+captions');
    expect(t.notes[0]).toBe('Timing pass failed: 500');
    expect(t.notes.some((n) => /caption text/i.test(n))).toBe(true);
    const expected = standup.flatMap((l) => splitWords(l.text).map(() => l.speaker));
    expect(accuracy(labelsOf(t), expected)).toBeGreaterThanOrEqual(0.95);
    expect(t.turns.map((x) => x.speaker)).toEqual(standup.map((l) => l.speaker));
    expect(squash(t.turns.map((x) => x.text))).toBe(squash([text]));
    // Times come from the (lag-compensated) caption blocks and never run backwards.
    for (let k = 1; k < t.turns.length; k++) expect(t.turns[k]!.start).toBeGreaterThanOrEqual(t.turns[k - 1]!.start);
    for (const turn of t.turns) expect(turn.end).toBeGreaterThanOrEqual(turn.start);
    const lastCaption = Math.max(...s.captions.map((c) => c.tEnd));
    expect(t.turns.at(-1)!.end).toBeLessThanOrEqual(lastCaption);
    expect(Math.abs(t.turns[1]!.start - s.lines[1]![0]!.start)).toBeLessThan(1500);
  });

  it('untimed text + wrong-language captions still keeps every word', () => {
    const lines = standup.map((l, k) => ({ ...l, caption: garble(l.text, k + 40) }));
    const s = build(lines, { seed: 19 });
    const text = standup.map((l) => l.text).join(' ');
    const t = mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas' });

    expect(t.source).toBe('audio+captions');
    expect(squash(t.turns.map((x) => x.text))).toBe(squash([text]));
    expect(t.turns.every((x) => x.speaker === CAMILLE || x.speaker === DAVID)).toBe(true);
    expect(t.notes.some((n) => /rough|approximate/i.test(n))).toBe(true);
  });

  it('untimed text without captions → audio-only, no speakers, text kept', () => {
    const text = 'Bonjour à tous.\n\nOn commence par Lumind.';
    const t = mergeTranscript({ words: [], text, captions: [], selfName: 'Ilyas' });

    expect(t.source).toBe('audio-only');
    expect(t.turns.every((x) => x.speaker === UNKNOWN_SPEAKER)).toBe(true);
    expect(squash(t.turns.map((x) => x.text))).toBe(squash([text]));
    expect(t.notes.length).toBeGreaterThan(0);
  });

  it('captions only → captions-only transcript with merged same-speaker blocks', () => {
    const captions: CaptionSegment[] = [
      { id: '1', speaker: 'You', self: true, text: 'On y va?', tStart: 3000, tEnd: 4500, rev: 2 },
      { id: '2', speaker: CAMILLE, self: false, text: 'Oui, alors premier point.', tStart: 5200, tEnd: 7000, rev: 5 },
      { id: '3', speaker: CAMILLE, self: false, text: 'Le budget marketing.', tStart: 7400, tEnd: 9000, rev: 3 },
      { id: '4', speaker: DAVID, self: false, text: 'Right.', tStart: 9800, tEnd: 10200, rev: 1 },
    ];
    const t = mergeTranscript({ words: [], captions, selfName: 'Ilyas', notes: ['No audio was recorded'] });

    expect(t.source).toBe('captions-only');
    expect(t.turns.map((x) => [x.speaker, x.text])).toEqual([
      ['Ilyas', 'On y va?'],
      [CAMILLE, 'Oui, alors premier point. Le budget marketing.'],
      [DAVID, 'Right.'],
    ]);
    expect(t.notes[0]).toBe('No audio was recorded');
  });

  it('nothing at all → empty captions-only transcript with a note', () => {
    const notes = ['Audio capture failed'];
    const t = mergeTranscript({ words: [], text: '  ', captions: [], selfName: 'Ilyas', notes });

    expect(t.turns).toEqual([]);
    expect(t.source).toBe('captions-only');
    expect(t.notes[0]).toBe('Audio capture failed');
    expect(t.notes.some((n) => /nothing was captured/i.test(n))).toBe(true);
  });

  it('prefers timed words over untimed text when both are present', () => {
    const s = build(standup.slice(0, 2));
    const t = mergeTranscript(inputOf(s, { text: 'completely different text' }));
    expect(squash(t.turns.map((x) => x.text))).toBe(squash(s.words.map((w) => w.text)));
  });
});

describe('mergeTranscript: performance', () => {
  /** ~10k words in ~1k caption blocks from four speakers. */
  const hourLong = (captionOf: (said: string[], rand: () => number, vocab: string[]) => string) => {
    const rand = rng(2024);
    const vocab = Array.from({ length: 400 }, (_, i) => `w${(i * 7919) % 1000}x${i % 13}`);
    const speakers = [CAMILLE, DAVID, SOPHIE, 'You'];
    const lines: Line[] = [];
    let words = 0;
    while (words < 10_000) {
      const n = 4 + Math.floor(rand() * 13);
      const said = Array.from({ length: n }, () => vocab[Math.floor(rand() * vocab.length)]!);
      const speaker = speakers[Math.floor(rand() * speakers.length)]!;
      lines.push({
        speaker,
        self: speaker === 'You',
        text: said.join(' '),
        caption: captionOf(said, rand, vocab),
        gap: 100 + Math.floor(rand() * 900),
      });
      words += n;
    }
    const s = build(lines, { jitter: 300, seed: 31, selfName: 'Ilyas' });
    expect(s.captions.length).toBeGreaterThan(900);
    return s;
  };
  // Meet gets about one word in five wrong.
  const noisy = (said: string[], rand: () => number, vocab: string[]) =>
    said.map((w) => (rand() < 0.2 ? vocab[Math.floor(rand() * vocab.length)]! : w)).join(' ');

  const timed = <T>(fn: () => T): [T, number] => {
    const t0 = performance.now();
    const out = fn();
    return [out, performance.now() - t0];
  };

  it('merges an hour-long meeting (~10k words, ~1k caption blocks) in under a second', () => {
    const s = hourLong(noisy);
    const [t, elapsed] = timed(() => mergeTranscript(inputOf(s)));

    expect(elapsed).toBeLessThan(1000);
    expect(accuracy(labelsOf(t), s.expected)).toBeGreaterThanOrEqual(0.97);
  });

  it('stays under a second when the lag must be found from timing (unreadable captions)', () => {
    const s = hourLong((said, rand) => garble(said.join(' '), Math.floor(rand() * 1e6)));
    const [t, elapsed] = timed(() => mergeTranscript(inputOf(s)));

    expect(elapsed).toBeLessThan(1000);
    expect(accuracy(labelsOf(t), s.expected)).toBeGreaterThanOrEqual(0.97);
  });

  it('stays under a second on the untimed-text fallback', () => {
    const s = hourLong(noisy);
    const text = s.lines.map((l) => l.map((w) => w.text).join(' ')).join('\n');
    const [t, elapsed] = timed(() => mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas' }));

    expect(elapsed).toBeLessThan(1000);
    expect(squash(t.turns.map((x) => x.text))).toBe(squash([text]));
  });
});
