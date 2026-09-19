import { describe, expect, it } from 'vitest';
import { CaptionTracker, type BlockReading } from '@lib/captions/tracker';

const A = (text: string): BlockReading => ({ speaker: 'Camille Martin', text, self: false });
const B = (text: string): BlockReading => ({ speaker: 'Hugo Bernard', text, self: false });
const ME = (text: string): BlockReading => ({ speaker: 'You', text, self: true });

function tracker() {
  return new CaptionTracker<object>({ idPrefix: 't' });
}

describe('CaptionTracker', () => {
  it('emits a new block as rev 0 with tStart = tEnd = first sighting', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, ME('Bonjour à tous'), 1200);
    expect(tr.drainChanges()).toEqual([
      { id: 't-1', speaker: 'You', self: true, text: 'Bonjour à tous', tStart: 1200, tEnd: 1200, rev: 0 },
    ]);
  });

  it('emits nothing when the text is unchanged', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('Hello'), 0);
    tr.drainChanges();
    tr.update(node, A('Hello'), 500);
    tr.update(node, A('  Hello \n'), 900);
    expect(tr.drainChanges()).toEqual([]);
  });

  it('bumps rev and tEnd on each change and drains only the latest revision per id', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('So'), 1000);
    tr.update(node, A('So the'), 1300);
    tr.update(node, A('So the plan'), 1700);
    const [seg] = tr.drainChanges();
    expect(seg).toMatchObject({ id: 't-1', text: 'So the plan', tStart: 1000, tEnd: 1700, rev: 2 });
    tr.update(node, A('So the plan is'), 2100);
    expect(tr.drainChanges()).toEqual([
      expect.objectContaining({ id: 't-1', text: 'So the plan is', tEnd: 2100, rev: 3 }),
    ]);
    expect(tr.drainChanges()).toEqual([]);
  });

  it('never emits empty text and keeps the last non-empty text', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('   '), 0);
    expect(tr.drainChanges()).toEqual([]);
    tr.update(node, A('Okay'), 100);
    tr.drainChanges();
    tr.update(node, A(''), 200);
    expect(tr.drainChanges()).toEqual([]);
    expect(tr.segments()).toEqual([expect.objectContaining({ text: 'Okay', rev: 0 })]);
  });

  it('treats a rewrite or a shrink as a revision of the same segment', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('I think we should go with the blue'), 0);
    tr.update(node, A('I think we should go with Lumind'), 400);
    tr.update(node, A('I think we should go'), 800);
    const out = tr.drainChanges();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 't-1', text: 'I think we should go', rev: 2, tEnd: 800 });
  });

  it('gives distinct nodes distinct ids and drains them ordered by tStart', () => {
    const tr = new CaptionTracker<object>();
    const n1 = {};
    const n2 = {};
    tr.update(n2, B('Second'), 3000);
    tr.update(n1, A('First'), 1000);
    const out = tr.drainChanges();
    expect(out.map((s) => s.text)).toEqual(['First', 'Second']);
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });

  it('uses a random id prefix by default so two trackers of one session never collide', () => {
    const a = new CaptionTracker<object>();
    const b = new CaptionTracker<object>();
    a.update({}, A('x'), 0);
    b.update({}, A('x'), 0);
    expect(a.drainChanges()[0]!.id).not.toBe(b.drainChanges()[0]!.id);
  });

  it('finalizes removed nodes without emitting anything', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('Done here'), 0);
    tr.drainChanges();
    tr.remove(node, 500);
    expect(tr.drainChanges()).toEqual([]);
    expect(tr.liveCount).toBe(0);
    // A later, unrelated block from the same speaker is a new segment.
    tr.update({}, A('Next topic'), 10_000);
    expect(tr.drainChanges()).toEqual([expect.objectContaining({ id: 't-2', text: 'Next topic', rev: 0 })]);
  });

  it('keeps the id when Meet re-renders a removed block as a new node', () => {
    const tr = tracker();
    const old = {};
    tr.update(old, A('We ship on Monday'), 1000);
    tr.drainChanges();
    tr.remove(old, 2000);
    const fresh = {};
    tr.update(fresh, A('We ship on Monday'), 2050);
    expect(tr.drainChanges()).toEqual([]);
    tr.update(fresh, A('We ship on Monday next week'), 2400);
    expect(tr.drainChanges()).toEqual([
      expect.objectContaining({ id: 't-1', text: 'We ship on Monday next week', tStart: 1000, tEnd: 2400, rev: 1 }),
    ]);
    expect(tr.segments()).toHaveLength(1);
  });

  it('does not continue a removed block after the window', () => {
    const tr = new CaptionTracker<object>({ idPrefix: 't', continuationWindowMs: 3000 });
    const old = {};
    tr.update(old, A('We ship on Monday'), 1000);
    tr.remove(old, 2000);
    tr.update({}, A('We ship on Monday'), 9000);
    expect(tr.segments().map((s) => s.id)).toEqual(['t-1', 't-2']);
  });

  it('keeps the id when a new node continues the most recent live segment and ignores the stale node', () => {
    const tr = tracker();
    const old = {};
    const fresh = {};
    tr.update(old, A('Can everyone see'), 0);
    tr.update(fresh, A('Can everyone see my screen'), 300);
    // Meet removes the stale copy later; its late edits must not fork or rewrite the segment.
    tr.update(old, A('Can everyone see me'), 400);
    tr.remove(old, 500);
    tr.update(fresh, A('Can everyone see my screen now'), 700);
    const out = tr.drainChanges();
    expect(out).toEqual([
      expect.objectContaining({ id: 't-1', text: 'Can everyone see my screen now', tStart: 0, tEnd: 700, rev: 2 }),
    ]);
  });

  it('does not merge a repeated phrase into an older block when someone spoke in between', () => {
    const tr = tracker();
    tr.update({}, A('Yes.'), 0);
    tr.update({}, B('Should we ship it?'), 500);
    tr.update({}, A('Yes.'), 1200);
    expect(tr.segments().map((s) => `${s.id}:${s.text}`)).toEqual(['t-1:Yes.', 't-2:Should we ship it?', 't-3:Yes.']);
  });

  it('does not glue a new utterance to a just-removed block that merely starts the same way', () => {
    const tr = tracker();
    const old = {};
    tr.update(old, A('So what I meant was the budget'), 0);
    tr.remove(old, 5000);
    tr.update({}, A('So'), 5010);
    expect(tr.segments().map((s) => s.text)).toEqual(['So what I meant was the budget', 'So']);
  });

  it('does not merge a new turn into an earlier short block Meet drops as the turn appears', () => {
    const tr = tracker();
    const [b1, b2, b3] = [{}, {}, {}];
    tr.update(b1, A('Oui.'), 10_000);
    tr.update(b2, B('Tu peux partager ton écran ?'), 12_000);
    tr.remove(b1, 14_000);
    tr.update(b3, A('Oui je partage mon écran.'), 14_000);
    expect(tr.segments().map((s) => [s.speaker, s.text, s.tStart])).toEqual([
      ['Camille Martin', 'Oui.', 10_000],
      ['Hugo Bernard', 'Tu peux partager ton écran ?', 12_000],
      ['Camille Martin', 'Oui je partage mon écran.', 14_000],
    ]);
  });

  it('does not merge a new turn into an earlier short block Meet just corrected, and keeps its later edits', () => {
    const tr = tracker();
    const [b1, b2, b3] = [{}, {}, {}];
    tr.update(b1, A('Oui'), 10_000);
    tr.update(b2, B('Tu peux partager ton écran ?'), 12_000);
    tr.update(b1, A('Oui.'), 13_900);
    tr.update(b3, A('Oui je partage mon écran.'), 14_000);
    tr.update(b1, A('Oui, oui.'), 14_200);
    expect(tr.segments().map((s) => [s.text, s.tStart])).toEqual([
      ['Oui, oui.', 10_000],
      ['Tu peux partager ton écran ?', 12_000],
      ['Oui je partage mon écran.', 14_000],
    ]);
  });

  it('does not extend a dropped one- or two-word block with a new turn that starts the same way', () => {
    const tr = tracker();
    const [b1, b2, b3] = [{}, {}, {}];
    tr.update(b1, A('OK.'), 10_000);
    tr.update(b2, B('On passe à la suite ?'), 11_000);
    tr.remove(b1, 12_000);
    tr.remove(b2, 12_000);
    tr.update(b3, A('OK, next topic then.'), 12_000);
    expect(tr.segments().map((s) => s.text)).toEqual(['OK.', 'On passe à la suite ?', 'OK, next topic then.']);
  });

  it('starts a new segment when Meet recycles a node for another speaker', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('Thanks'), 0);
    tr.update(node, B('Sure'), 800);
    expect(tr.segments()).toEqual([
      expect.objectContaining({ id: 't-1', speaker: 'Camille Martin', text: 'Thanks' }),
      expect.objectContaining({ id: 't-2', speaker: 'Hugo Bernard', text: 'Sure', tStart: 800, rev: 0 }),
    ]);
  });

  it('splits when a long monologue block restarts from scratch', () => {
    const tr = tracker();
    const node = {};
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    tr.update(node, A(long), 0);
    tr.update(node, A('and the next part'), 90_000);
    tr.update(node, A('and the next part begins'), 91_000);
    const segs = tr.segments();
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ text: long, rev: 0 });
    expect(segs[1]).toMatchObject({ text: 'and the next part begins', tStart: 90_000, rev: 1 });
  });

  it('re-attaches every block after the whole region is replaced', () => {
    const tr = tracker();
    const [a1, b1, a2] = [{}, {}, {}];
    tr.update(a1, A('Point one'), 0);
    tr.update(b1, B('Agreed'), 1000);
    tr.update(a2, A('And point two'), 2000);
    tr.drainChanges();
    tr.removeAll(2500);
    const [a1n, b1n, a2n] = [{}, {}, {}];
    tr.update(a1n, A('Point one'), 2600);
    tr.update(b1n, B('Agreed'), 2600);
    tr.update(a2n, A('And point two is'), 2600);
    expect(tr.drainChanges()).toEqual([expect.objectContaining({ id: 't-3', text: 'And point two is', rev: 1 })]);
    expect(tr.segments()).toHaveLength(3);
    expect(tr.liveCount).toBe(3);
  });

  it('lists every node it still references, including stale copies, until they are removed', () => {
    const tr = tracker();
    const old = {};
    const fresh = {};
    tr.update(old, A('Can everyone see'), 0);
    tr.update(fresh, A('Can everyone see my screen'), 300);
    expect(tr.liveKeys()).toEqual([fresh]);
    expect(new Set(tr.heldKeys())).toEqual(new Set([old, fresh]));
    tr.remove(old, 400);
    tr.remove(fresh, 400);
    expect(tr.heldKeys()).toEqual([]);
  });

  it('shifts every segment to a corrected t = 0 and bumps its rev so consumers replace it', () => {
    const tr = tracker();
    const [n1, n2] = [{}, {}];
    tr.update(n1, A('Before the fix'), 2000);
    tr.update(n1, A('Before the fix, longer'), 2600);
    tr.update(n2, B('Hi'), 1000);
    tr.drainChanges();
    tr.shiftTimes(-1500);
    expect(tr.drainChanges().map((s) => [s.text, s.tStart, s.tEnd, s.rev])).toEqual([
      ['Hi', 0, 0, 1],
      ['Before the fix, longer', 500, 1100, 2],
    ]);
    tr.update(n1, A('Before the fix, longer still'), 1400);
    expect(tr.drainChanges()).toEqual([expect.objectContaining({ tStart: 500, tEnd: 1400, rev: 3 })]);
  });

  it('clamps times: never negative, integer ms, tEnd never before tStart', () => {
    const tr = tracker();
    const node = {};
    tr.update(node, A('early'), -250.4);
    tr.update(node, A('early bird'), 99.6);
    expect(tr.segments()[0]).toMatchObject({ tStart: 0, tEnd: 100 });
  });
});
