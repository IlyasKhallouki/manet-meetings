import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteCaptions, loadCaptions, mergeCaptions, speakersOf } from '@lib/storage/captionStore';
import type { CaptionSegment } from '@lib/types';

function seg(id: string, rev: number, tStart: number, text = `${id} r${rev}`): CaptionSegment {
  return { id, speaker: 'Alice', self: false, text, tStart, tEnd: tStart + 1000 + rev * 100, rev };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('captionStore', () => {
  it('stores captions under captions:<sessionId>', async () => {
    await mergeCaptions('s1', [seg('c1', 0, 0)]);
    const raw = await fakeBrowser.storage.local.get('captions:s1');
    expect(raw['captions:s1']).toBeTruthy();
  });

  it('keeps the highest revision of each segment, whatever order batches arrive in', async () => {
    await mergeCaptions('s1', [seg('c1', 0, 0), seg('c2', 0, 3000)]);
    await mergeCaptions('s1', [seg('c1', 2, 0, 'hello world')]);
    await mergeCaptions('s1', [seg('c1', 1, 0, 'hello')]);
    const caps = await loadCaptions('s1');
    expect(caps.find((c) => c.id === 'c1')).toMatchObject({ rev: 2, text: 'hello world' });
    expect(caps).toHaveLength(2);
  });

  it('keeps the highest revision within a single batch', async () => {
    await mergeCaptions('s1', [seg('c1', 3, 0, 'three'), seg('c1', 1, 0, 'one')]);
    expect(await loadCaptions('s1')).toEqual([seg('c1', 3, 0, 'three')]);
  });

  it('returns the number of distinct segments after the merge', async () => {
    expect((await mergeCaptions('s1', [seg('c1', 0, 0), seg('c2', 0, 10)])).count).toBe(2);
    expect((await mergeCaptions('s1', [seg('c2', 1, 10), seg('c3', 0, 20)])).count).toBe(3);
    expect((await mergeCaptions('s1', [])).count).toBe(3);
  });

  it('returns the speakers of every stored segment, not only of the batch', async () => {
    await mergeCaptions('s1', [said('c1', 'Marie Curie', 1000, 4000)]);
    const { speakers } = await mergeCaptions('s1', [said('c2', 'Tom Martin', 5000, 6000)]);
    expect(speakers.map((s) => s.name)).toEqual(['Marie Curie', 'Tom Martin']);
  });

  it('loads captions sorted by start time', async () => {
    await mergeCaptions('s1', [seg('late', 0, 9000), seg('early', 0, 1000), seg('mid', 0, 5000)]);
    expect((await loadCaptions('s1')).map((c) => c.id)).toEqual(['early', 'mid', 'late']);
  });

  it('does not lose segments when batches are merged concurrently', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => mergeCaptions('s1', [seg(`c${i}`, 0, i * 100), seg(`c${i}`, 1, i * 100)])),
    );
    const caps = await loadCaptions('s1');
    expect(caps).toHaveLength(30);
    expect(caps.every((c) => c.rev === 1)).toBe(true);
  });

  it('keeps sessions separate and deletes one session', async () => {
    await mergeCaptions('s1', [seg('c1', 0, 0)]);
    await mergeCaptions('s2', [seg('c1', 5, 0)]);
    await deleteCaptions('s1');
    expect(await loadCaptions('s1')).toEqual([]);
    expect(await loadCaptions('s2')).toEqual([seg('c1', 5, 0)]);
  });

  it('returns an empty list for a session without captions', async () => {
    expect(await loadCaptions('none')).toEqual([]);
  });
});

function said(id: string, speaker: string, tStart: number, tEnd: number, extra: Partial<CaptionSegment> = {}): CaptionSegment {
  return { id, speaker, self: false, text: 'words', tStart, tEnd, rev: 0, ...extra };
}

describe('speakersOf', () => {
  it('lists each speaker once, in order of first speech, with first/last times and talk time', () => {
    const speakers = speakersOf([
      said('c3', 'Tom Martin', 9000, 12_000),
      said('c1', 'Marie Curie', 1000, 4000),
      said('c2', 'Tom Martin', 5000, 6500),
      said('c4', 'Marie Curie', 13_000, 15_000),
    ]);
    expect(speakers).toEqual([
      { name: 'Marie Curie', self: false, firstAt: 1000, lastAt: 15_000, talkMs: 5000 },
      { name: 'Tom Martin', self: false, firstAt: 5000, lastAt: 12_000, talkMs: 4500 },
    ]);
  });

  it('keeps the local user as one self entry under Meet’s label, whatever the language', () => {
    const speakers = speakersOf([
      said('c1', 'You', 2000, 3000, { self: true }),
      said('c2', 'Vous', 8000, 9000, { self: true }),
      said('c3', 'Marie Curie', 500, 1500),
    ]);
    expect(speakers).toEqual([
      { name: 'Marie Curie', self: false, firstAt: 500, lastAt: 1500, talkMs: 1000 },
      { name: 'You', self: true, firstAt: 2000, lastAt: 9000, talkMs: 2000 },
    ]);
  });

  it('treats names that differ only in case or spacing as one person, named as first seen', () => {
    const speakers = speakersOf([said('c2', 'marie  curie ', 4000, 5000), said('c1', 'Marie Curie', 1000, 2000)]);
    expect(speakers).toEqual([{ name: 'Marie Curie', self: false, firstAt: 1000, lastAt: 5000, talkMs: 2000 }]);
  });

  it('skips blocks without a speaker name, and never counts negative talk time', () => {
    const speakers = speakersOf([said('c1', '  ', 0, 1000), said('c2', 'Tom', 3000, 2500)]);
    expect(speakers).toEqual([{ name: 'Tom', self: false, firstAt: 3000, lastAt: 3000, talkMs: 0 }]);
  });

  it('is empty without captions', () => {
    expect(speakersOf([])).toEqual([]);
  });
});
