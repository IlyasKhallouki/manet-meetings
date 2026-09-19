import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpfsAudioStore } from '@lib/storage/opfsAudioStore';
import type { AudioStore } from '@lib/types';
import { audioBytesOnDisk, storageEstimate } from '@lib/ui/storageInfo';

// Real OPFS under a private test directory, so other test files are not disturbed.
const DIR = `ui-storage-test-${crypto.randomUUID()}`;
let root: FileSystemDirectoryHandle;
let store: AudioStore;

beforeEach(async () => {
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  store = createOpfsAudioStore(async () => root);
});

afterEach(async () => {
  await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true });
});

describe('audioBytesOnDisk (real OPFS)', () => {
  it('sums committed chunk bytes per session', async () => {
    await store.writeChunk('abc-defg-hij_20260919T081500Z', 0, new Blob([new Uint8Array(1000)]));
    await store.writeChunk('abc-defg-hij_20260919T081500Z', 1, new Blob([new Uint8Array(24)]));
    await store.writeChunk('xyz-abcd-efg_20260919T091500Z', 0, new Blob([new Uint8Array(512)]));
    expect(await audioBytesOnDisk(store)).toEqual(
      new Map([
        ['abc-defg-hij_20260919T081500Z', 1024],
        ['xyz-abcd-efg_20260919T091500Z', 512],
      ]),
    );
  });

  it('is empty when nothing was recorded', async () => {
    expect(await audioBytesOnDisk(store)).toEqual(new Map());
  });

  it('returns null when the store cannot be read, so the page falls back to recorder counts', async () => {
    const broken = createOpfsAudioStore(async () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(await audioBytesOnDisk(broken)).toBeNull();
  });
});

describe('storageEstimate (real StorageManager)', () => {
  it('reports usage and quota for the origin', async () => {
    const estimate = await storageEstimate();
    expect(estimate).not.toBeNull();
    expect(estimate!.quota).toBeGreaterThan(0);
    expect(estimate!.usage).toBeGreaterThanOrEqual(0);
  });
});
