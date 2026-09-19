import { describe, expect, it } from 'vitest';
import { splitWords } from '@lib/align/sequence';
import { mergeTranscript, UNKNOWN_SPEAKER } from '@lib/merge';
import type { CaptionSegment, TimedWord } from '@lib/types';
import { accuracy, build, garble, labelsOf, rng, speak, squash, type Line, type Scenario } from './scenario';

const ALICE = 'Alice Durand';
const CAMILLE = 'Camille Martin';
const DAVID = 'David Chen';
const SOPHIE = 'Sophie Laurent';

const meeting: Line[] = [
  { speaker: CAMILLE, text: 'Bonjour à tous, on commence par le point sur Lumind.' },
  { speaker: 'You', self: true, text: 'Thanks Camille, I will present the budget numbers first.', gap: 700 },
  { speaker: DAVID, text: 'Yes, the onboarding flow shipped on Monday.', gap: 600 },
  { speaker: CAMILLE, text: 'Super, et les retours des premiers utilisateurs?', gap: 450 },
  { speaker: 'You', self: true, text: 'Mostly positive, the hiring plan is on track too.', gap: 500 },
  { speaker: DAVID, text: 'But the export to Notion is still slow.', gap: 900 },
  { speaker: CAMILLE, text: "D'accord, il faut regarder ça cette semaine.", gap: 500 },
  { speaker: 'You', self: true, text: "Great, I'll pair with Sophie tomorrow.", gap: 600 },
];

/** More of the same meeting, with no self lines. */
const more: Line[] = [
  { speaker: SOPHIE, text: 'Pour la V2, on vise toujours fin octobre?', gap: 600 },
  { speaker: DAVID, text: 'I think so, unless the payment provider slips again.', gap: 500 },
  { speaker: CAMILLE, text: 'On garde septembre si on coupe la facturation annuelle.', gap: 700 },
  { speaker: SOPHIE, text: 'The design system is ready, I sent the Figma link yesterday.', gap: 450 },
  { speaker: DAVID, text: 'Et le backend? On en parle maintenant ou jeudi?', gap: 650 },
  { speaker: CAMILLE, text: 'Non, on garde ça pour jeudi, merci à tous.', gap: 500 },
];

/** Words of the lines matching `keep`, sorted by start like the transcriber returns them. */
function wordsOf(s: Scenario, lines: Line[], keep: (l: Line) => boolean): TimedWord[] {
  return s.lines.flatMap((ws, k) => (keep(lines[k]!) ? ws : [])).sort((x, y) => x.start - y.start);
}

/** The recorder's lines given to Alice, so no line is self. */
const othersOnly = (lines: Line[]) => lines.map((l) => ({ ...l, self: false, speaker: l.self ? ALICE : l.speaker }));

const turnsOf = (t: { turns: { speaker: string; text: string }[] }) => t.turns.map((x) => [x.speaker, x.text]);

describe('mergeTranscript: caption text for speech the audio does not have', () => {
  it('keeps a caption block that has no audio words in its span', () => {
    // The review's probe: audio words for Alice (0–10 s), and a self block later.
    const words = speak('Hi everyone, the quarterly review is first on the agenda today, then the hiring plan.', 0);
    expect(words.at(-1)!.end).toBeLessThan(10_000);
    const captions: CaptionSegment[] = [
      {
        id: 'a',
        speaker: ALICE,
        self: false,
        text: 'Hi everyone the quarterly review is first on the agenda today then the hiring plan',
        tStart: 1200,
        tEnd: words.at(-1)!.end + 1800,
        rev: 12,
      },
      {
        id: 's',
        speaker: 'You',
        self: true,
        text: 'Thanks Alice I will present the budget numbers and the hiring plan',
        tStart: 21_000,
        tEnd: 30_000,
        rev: 9,
      },
    ];
    const t = mergeTranscript({ words, captions, selfName: 'Ilyas' });

    expect(t.source).toBe('audio+captions');
    expect(turnsOf(t)).toEqual([
      [ALICE, 'Hi everyone, the quarterly review is first on the agenda today, then the hiring plan.'],
      ['Ilyas', 'Thanks Alice I will present the budget numbers and the hiring plan'],
    ]);
    expect(t.turns[1]!.start).toBeGreaterThan(t.turns[0]!.end);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatch(/captions/i);
    expect(t.notes[0]).toMatch(/00:00:1\d–00:00:2\d/);
  });

  it('without the mic, keeps every self block as caption text and gives the audio words to others', () => {
    const lines: Line[] = [
      ...meeting,
      // The recorder talks over David; the audio has only David.
      { speaker: DAVID, text: 'One more thing about the pricing page and the new plans.', gap: 500 },
      { speaker: 'You', self: true, text: 'Sure, go ahead.', interject: 3 },
    ];
    const s = build(lines, { selfName: 'Ilyas', startLag: 1200, endLag: 1800, jitter: 250, seed: 3 });
    const tabOnly = wordsOf(s, lines, (l) => !l.self);
    const t = mergeTranscript({ words: tabOnly, captions: s.captions, selfName: 'Ilyas', micIncluded: false });

    const selfTurns = t.turns.filter((x) => x.speaker === 'Ilyas').map((x) => x.text);
    expect(selfTurns).toEqual(lines.filter((l) => l.self).map((l) => l.text));
    // Every audio word is still there once, with its real speaker.
    const others = t.turns.filter((x) => x.speaker !== 'Ilyas');
    expect(squash(others.map((x) => x.text))).toBe(squash(tabOnly.map((w) => w.text)));
    const said = new Set(tabOnly);
    expect(labelsOf({ ...t, turns: others })).toEqual(s.expected.filter((_, i) => said.has(s.words[i]!)));
    // Reading order: the self lines sit between the right audio turns.
    expect(t.turns.slice(0, 8).map((x) => x.speaker)).toEqual(meeting.map((l) => (l.self ? 'Ilyas' : l.speaker)));
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatch(/microphone was not recorded/i);
    expect(t.notes[0]).toContain('Ilyas');
  });

  it('with the mic recorded, self blocks are aligned like anyone else and never duplicated', () => {
    const s = build(meeting, { selfName: 'Ilyas', jitter: 250, seed: 5 });
    for (const micIncluded of [undefined, true]) {
      const t = mergeTranscript({ words: s.words, captions: s.captions, selfName: 'Ilyas', micIncluded });
      expect(labelsOf(t)).toEqual(s.expected);
      expect(squash(t.turns.map((x) => x.text))).toBe(squash(s.words.map((w) => w.text)));
      expect(t.notes).toEqual([]);
    }
  });

  it('fills the rest of the meeting from captions when the audio ends early, without repeating the boundary', () => {
    const lines = [...meeting, ...more];
    const s = build(lines, { selfName: 'Ilyas', startLag: 1300, endLag: 1900, jitter: 200, seed: 8 });
    // The recorder died in the middle of line 9 (David).
    const cut = s.lines[9]![3]!.end + 20;
    const heard = s.words.filter((w) => w.end <= cut);
    const t = mergeTranscript({ words: heard, captions: s.captions, selfName: 'Ilyas', audioEndMs: cut });

    // Nothing is lost and nothing the audio heard is repeated.
    expect(squash(t.turns.map((x) => x.text))).toBe(squash(lines.map((l) => l.text)));
    expect(t.turns.map((x) => x.speaker)).toEqual(lines.map((l) => (l.self ? 'Ilyas' : l.speaker)));
    expect(t.turns[9]!.text).toBe(lines[9]!.text);
    // Caption turns come after the audio, in caption order.
    for (let k = 1; k < t.turns.length; k++) expect(t.turns[k]!.start).toBeGreaterThanOrEqual(t.turns[k - 1]!.start);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatch(/captions/i);
  });

  it('fills a failed transcription part from captions and keeps the audio on both sides', () => {
    const lines: Line[] = [];
    for (let round = 0; round < 3; round++) meeting.forEach((l) => lines.push({ ...l, gap: 400 + round * 50 }));
    const s = build(lines, { selfName: 'Ilyas', jitter: 200, seed: 12 });
    // Part 2 of 3 failed: no words between the end of line 7 and the start of line 16.
    const gap = { start: s.lines[7]!.at(-1)!.end + 200, end: s.lines[16]![0]!.start - 200 };
    const words = s.words.filter((w) => w.end < gap.start || w.start > gap.end);
    const t = mergeTranscript({ words, captions: s.captions, selfName: 'Ilyas', gaps: [gap] });

    expect(squash(t.turns.map((x) => x.text))).toBe(squash(lines.map((l) => l.text)));
    expect(t.turns.map((x) => x.speaker)).toEqual(lines.map((l) => (l.self ? 'Ilyas' : l.speaker)));
    const [note] = t.notes;
    expect(t.notes).toHaveLength(1);
    expect(note).toMatch(/captions/i);
    // One range, roughly the gap.
    expect(note!.match(/\d\d:\d\d:\d\d–\d\d:\d\d:\d\d/g)).toHaveLength(1);
  });

  it('fills a failed part even when the captions are in the wrong language', () => {
    const lines = meeting.map((l, k) => ({ ...l, caption: garble(l.text, k + 3) }));
    const s = build(lines, { selfName: 'Ilyas', jitter: 150, seed: 2 });
    const gap = { start: s.lines[3]![0]!.start - 100, end: s.lines[4]!.at(-1)!.end + 100 };
    const words = s.words.filter((w) => w.end < gap.start || w.start > gap.end);
    const t = mergeTranscript({ words, captions: s.captions, selfName: 'Ilyas', gaps: [gap] });

    expect(t.turns.map((x) => x.speaker)).toEqual(lines.map((l) => (l.self ? 'Ilyas' : l.speaker)));
    expect(t.turns[3]!.text).toBe(lines[3]!.caption);
    expect(t.turns[4]!.text).toBe(lines[4]!.caption);
    expect(t.turns[5]!.text).toBe(lines[5]!.text);
  });

  it('never adds caption text over speech the audio has, even with a misjudged lag or short blocks', () => {
    const lines: Line[] = [
      {
        speaker: DAVID,
        text: 'So the plan for next week is to finish the Notion export and then start on the calendar sync.',
      },
      { speaker: CAMILLE, text: 'Oui.', interject: 5 },
      { speaker: CAMILLE, text: 'OK.', caption: 'Okay.', gap: 2500 },
      { speaker: DAVID, text: 'Right.', gap: 2500 },
      { speaker: SOPHIE, text: 'Hmm.', caption: 'Mm', gap: 2500 },
      ...meeting.map((l, k) => ({
        ...l,
        self: false,
        speaker: l.self ? SOPHIE : l.speaker,
        caption: garble(l.text, k),
      })),
    ];
    const s = build(lines, { startLag: 2600, endLag: 3200, jitter: 300, seed: 17 });
    for (const captionLagMs of [undefined, 1500, 3500]) {
      const t = mergeTranscript({ words: s.words, captions: s.captions, selfName: 'Ilyas', captionLagMs });
      expect(squash(t.turns.map((x) => x.text)), `lag=${captionLagMs}`).toBe(squash(s.words.map((w) => w.text)));
      expect(t.notes.some((n) => /no transcript/i.test(n))).toBe(false);
    }
  });

  it('trusts the words over an audio end or gap that is a few seconds off', () => {
    const lines = meeting.map((l, k) => ({ ...l, caption: garble(l.text, k + 9) }));
    const s = build(lines, { selfName: 'Ilyas', jitter: 200, seed: 6 });
    const end = s.words.at(-1)!.end;
    // The recorder's estimate of where the audio ends is early, and a reported gap has words.
    const gaps = [{ start: s.lines[3]![0]!.start - 1000, end: s.lines[3]![2]!.end }];
    const t = mergeTranscript({ words: s.words, captions: s.captions, selfName: 'Ilyas', gaps, audioEndMs: end - 4000 });

    expect(squash(t.turns.map((x) => x.text))).toBe(squash(s.words.map((w) => w.text)));
    expect(t.notes).toEqual([]);
  });

  it('does not treat a block as unheard when only a few of its words were transcribed with a text match', () => {
    const lines: Line[] = [
      { speaker: CAMILLE, text: 'Alors on regarde le budget marketing pour le trimestre prochain.' },
      { speaker: DAVID, text: 'The budget looks fine to me.', gap: 600 },
    ];
    const s = build(lines, { jitter: 100, seed: 4 });
    const t = mergeTranscript({ words: s.words, captions: s.captions, selfName: 'Ilyas' });
    expect(turnsOf(t)).toEqual(lines.map((l) => [l.speaker, l.text]));
  });
});

describe('mergeTranscript: caption fill on the untimed fallback', () => {
  it('keeps self caption text when the mic was not recorded', () => {
    const s = build(meeting, { selfName: 'Ilyas', jitter: 200, seed: 21 });
    const text = meeting.filter((l) => !l.self).map((l) => l.text).join('\n');
    const t = mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas', micIncluded: false });

    expect(t.turns.map((x) => x.speaker)).toEqual(meeting.map((l) => (l.self ? 'Ilyas' : l.speaker)));
    expect(t.turns.filter((x) => x.speaker === 'Ilyas').map((x) => x.text)).toEqual(
      meeting.filter((l) => l.self).map((l) => l.text),
    );
    expect(squash(t.turns.filter((x) => x.speaker !== 'Ilyas').map((x) => x.text))).toBe(squash([text]));
    expect(t.notes.some((n) => /microphone was not recorded/i.test(n))).toBe(true);
  });

  it('does not spread the transcript over captions recorded after the audio ended', () => {
    const lines = [...more, ...othersOnly(meeting.slice(1))];
    const s = build(lines, { jitter: 200, seed: 22 });
    const cut = s.lines[5]!.at(-1)!.end + 300;
    const text = lines.slice(0, 6).map((l) => l.text).join('\n');
    const t = mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas', audioEndMs: cut });

    expect(t.turns.map((x) => x.speaker)).toEqual(lines.map((l) => l.speaker));
    expect(t.turns.map((x) => x.text)).toEqual(lines.map((l) => l.text));
    for (let k = 1; k < t.turns.length; k++) expect(t.turns[k]!.start).toBeGreaterThanOrEqual(t.turns[k - 1]!.start);
    expect(t.notes.some((n) => /captions/i.test(n) && /\d\d:\d\d:\d\d/.test(n))).toBe(true);
  });

  it('keeps a block that starts just before the audio ended but got no transcript word', () => {
    const lines = [...more, ...othersOnly(meeting.slice(1))];
    const s = build(lines, { startLag: 1200, endLag: 1800, jitter: 100, seed: 23 });
    // The recorder died as line 6 began: its lag-compensated block starts before the cut.
    const cut = s.lines[6]![0]!.start + 100;
    const text = lines.slice(0, 6).map((l) => l.text).join('\n');
    const t = mergeTranscript({ words: [], text, captions: s.captions, selfName: 'Ilyas', audioEndMs: cut });

    expect(t.turns.map((x) => x.text)).toEqual(lines.map((l) => l.text));
  });

  it('keeps self caption text even when no other caption can place the untimed transcript', () => {
    const captions: CaptionSegment[] = [
      { id: 's', speaker: 'You', self: true, text: 'On y va?', tStart: 3000, tEnd: 4500, rev: 2 },
    ];
    const text = 'Oui, alors premier point.';
    const t = mergeTranscript({ words: [], text, captions, selfName: 'Ilyas', micIncluded: false });

    expect(turnsOf(t)).toEqual([
      [UNKNOWN_SPEAKER, 'Oui, alors premier point.'],
      ['Ilyas', 'On y va?'],
    ]);
    expect(t.source).toBe('audio-only');
    expect(t.notes.some((n) => /microphone was not recorded/i.test(n))).toBe(true);
    expect(t.notes.some((n) => /captions were unavailable/i.test(n))).toBe(false);
  });
});

describe('mergeTranscript: caption fill performance', () => {
  it('stays under a second for an hour without the mic and with a failed part', () => {
    const rand = rng(77);
    const vocab = Array.from({ length: 400 }, (_, i) => `w${(i * 7919) % 1000}x${i % 13}`);
    const speakers = [CAMILLE, DAVID, SOPHIE, 'You'];
    const lines: Line[] = [];
    let n = 0;
    while (n < 10_000) {
      const len = 4 + Math.floor(rand() * 13);
      const said = Array.from({ length: len }, () => vocab[Math.floor(rand() * vocab.length)]!);
      const speaker = speakers[Math.floor(rand() * speakers.length)]!;
      lines.push({ speaker, self: speaker === 'You', text: said.join(' '), gap: 100 + Math.floor(rand() * 900) });
      n += len;
    }
    const s = build(lines, { jitter: 300, seed: 31, selfName: 'Ilyas' });
    expect(s.captions.length).toBeGreaterThan(900);
    const mid = s.words[Math.floor(s.words.length / 2)]!.start;
    const gap = { start: mid, end: mid + 10 * 60_000 };
    const selfWords = new Set(s.lines.flatMap((ws, k) => (lines[k]!.self ? ws : [])));
    const words = s.words.filter((w) => !selfWords.has(w) && (w.end < gap.start || w.start > gap.end));

    const t0 = performance.now();
    const t = mergeTranscript({ words, captions: s.captions, selfName: 'Ilyas', micIncluded: false, gaps: [gap] });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(1000);
    // Every word said is there once: audio words, plus captions for self and the gap.
    expect(splitWords(t.turns.map((x) => x.text).join(' '))).toHaveLength(s.words.length);
    expect(t.turns.some((x) => x.speaker === UNKNOWN_SPEAKER)).toBe(false);
  });
});

describe('mergeTranscript: caption lag with uncovered stretches', () => {
  it('learns the lag from timing using only the blocks the audio can have', () => {
    // Unreadable captions, and the recorder died early in the meeting.
    const lines: Line[] = [];
    for (let k = 0; k < 40; k++) {
      const l = more[k % more.length]!;
      lines.push({ ...l, caption: garble(l.text, k + 70), gap: 200 + ((k * 337) % 700) });
    }
    const s = build(lines, { startLag: 2800, endLag: 3400, jitter: 200, seed: 15 });
    const cut = s.lines[7]!.at(-1)!.end + 100;
    const words = s.words.filter((w) => w.end <= cut);
    const t = mergeTranscript({ words, captions: s.captions, selfName: 'Ilyas', audioEndMs: cut });

    const audio = t.turns.filter((x) => x.start < cut);
    expect(accuracy(labelsOf({ ...t, turns: audio }), s.expected.slice(0, words.length))).toBeGreaterThanOrEqual(0.97);
    expect(t.turns.slice(-32).map((x) => x.text)).toEqual(lines.slice(8).map((l) => l.caption));
  });
});
