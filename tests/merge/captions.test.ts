import { describe, expect, it } from 'vitest';
import { attendeesFrom, captionsToTranscript, DEFAULT_CAPTION_LAG_MS, formatTranscript } from '@lib/merge';
import type { CaptionSegment, MeetingTranscript } from '@lib/types';

type SegInput = Partial<CaptionSegment> & Pick<CaptionSegment, 'id' | 'speaker' | 'text' | 'tStart'>;

const seg = (over: SegInput): CaptionSegment => ({
  self: false,
  tEnd: over.tStart + 1000,
  rev: 0,
  ...over,
});

describe('attendeesFrom', () => {
  const captions = [
    seg({ id: '1', speaker: 'Bob Martin', text: 'hi', tStart: 5000 }),
    seg({ id: '0', speaker: 'You', self: true, text: 'hello', tStart: 1000 }),
    seg({ id: '2', speaker: '  Alice   Durand ', text: 'salut', tStart: 3000 }),
    seg({ id: '3', speaker: 'Bob Martin', text: 'again', tStart: 9000 }),
    seg({ id: '4', speaker: '', text: 'ghost', tStart: 10000 }),
    seg({ id: '5', speaker: 'alice durand', text: 'case differs', tStart: 12000 }),
  ];

  it('lists unique names by first appearance with the self label mapped', () => {
    expect(attendeesFrom(captions, 'Ilyas')).toEqual(['Ilyas', 'Alice Durand', 'Bob Martin']);
  });

  it('keeps Meet’s self label when no display name is set', () => {
    expect(attendeesFrom(captions, '  ')[0]).toBe('You');
  });

  it('returns nothing without captions', () => {
    expect(attendeesFrom([], 'Ilyas')).toEqual([]);
  });
});

describe('captionsToTranscript', () => {
  it('merges consecutive blocks of one speaker, maps self, and compensates the lag', () => {
    const t = captionsToTranscript(
      [
        seg({ id: 'b', speaker: 'Camille', text: 'Oui, alors', tStart: 5200, tEnd: 7000 }),
        seg({ id: 'a', speaker: 'Vous', self: true, text: 'On commence?', tStart: 3000, tEnd: 4500 }),
        seg({ id: 'c', speaker: 'Camille', text: 'premier point.', tStart: 7400, tEnd: 9000 }),
        seg({ id: 'd', speaker: 'David', text: 'Right.', tStart: 9800, tEnd: 10200 }),
        seg({ id: 'e', speaker: 'Camille', text: 'Ensuite…', tStart: 11000, tEnd: 12500 }),
      ],
      'Ilyas',
    );

    expect(t.source).toBe('captions-only');
    expect(t.notes).toEqual([]);
    expect(t.turns).toEqual([
      { speaker: 'Ilyas', text: 'On commence?', start: 3000 - DEFAULT_CAPTION_LAG_MS, end: 4500 - DEFAULT_CAPTION_LAG_MS },
      {
        speaker: 'Camille',
        text: 'Oui, alors premier point.',
        start: 5200 - DEFAULT_CAPTION_LAG_MS,
        end: 9000 - DEFAULT_CAPTION_LAG_MS,
      },
      { speaker: 'David', text: 'Right.', start: 9800 - DEFAULT_CAPTION_LAG_MS, end: 10200 - DEFAULT_CAPTION_LAG_MS },
      { speaker: 'Camille', text: 'Ensuite…', start: 11000 - DEFAULT_CAPTION_LAG_MS, end: 12500 - DEFAULT_CAPTION_LAG_MS },
    ]);
  });

  it('uses the latest revision of each block and drops empty ones', () => {
    const t = captionsToTranscript(
      [
        seg({ id: 'x', speaker: 'Camille', text: 'Bon', tStart: 2000, rev: 0 }),
        seg({ id: 'x', speaker: 'Camille', text: 'Bonjour tout le monde', tStart: 2000, tEnd: 4000, rev: 3 }),
        seg({ id: 'x', speaker: 'Camille', text: 'Bonjour tout', tStart: 2000, rev: 1 }),
        seg({ id: 'y', speaker: 'David', text: '   ', tStart: 5000 }),
      ],
      'Ilyas',
      0,
    );
    expect(t.turns).toEqual([{ speaker: 'Camille', text: 'Bonjour tout le monde', start: 2000, end: 4000 }]);
  });

  it('splits a speaker on a long silence and never produces negative times', () => {
    const t = captionsToTranscript(
      [
        seg({ id: '1', speaker: 'Camille', text: 'Premier.', tStart: 500, tEnd: 2000 }),
        seg({ id: '2', speaker: 'Camille', text: 'Deuxième.', tStart: 30000, tEnd: 31000 }),
      ],
      'Ilyas',
    );
    expect(t.turns.map((x) => x.text)).toEqual(['Premier.', 'Deuxième.']);
    expect(t.turns[0]!.start).toBe(0);
  });

  it('returns an empty transcript for no captions', () => {
    expect(captionsToTranscript([], 'Ilyas')).toEqual({ turns: [], source: 'captions-only', notes: [] });
  });
});

describe('formatTranscript', () => {
  it('writes one "[hh:mm:ss] Speaker: text" line per turn', () => {
    const t: MeetingTranscript = {
      source: 'audio+captions',
      notes: ['ignored'],
      turns: [
        { speaker: 'Camille', start: 0, end: 1200, text: 'Bonjour.' },
        { speaker: 'David', start: 3_723_000, end: 3_725_000, text: 'Hello.' },
      ],
    };
    expect(formatTranscript(t)).toBe('[00:00:00] Camille: Bonjour.\n[01:02:03] David: Hello.');
  });

  it('is empty for an empty transcript', () => {
    expect(formatTranscript({ turns: [], source: 'captions-only', notes: [] })).toBe('');
  });
});
