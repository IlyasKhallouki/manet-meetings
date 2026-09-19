import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteCaptions, loadCaptions, mergeCaptions } from '@lib/storage/captionStore';
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
    expect(await mergeCaptions('s1', [seg('c1', 0, 0), seg('c2', 0, 10)])).toBe(2);
    expect(await mergeCaptions('s1', [seg('c2', 1, 10), seg('c3', 0, 20)])).toBe(3);
    expect(await mergeCaptions('s1', [])).toBe(3);
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
