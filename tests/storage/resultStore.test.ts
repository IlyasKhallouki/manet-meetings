import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteResult, getResult, putResult } from '@lib/storage/resultStore';
import type { SessionResult } from '@lib/types';

const result: SessionResult = {
  title: 'Weekly sync',
  attendees: ['Alice', 'Bob'],
  transcript: {
    turns: [{ speaker: 'Alice', start: 0, end: 1500, text: 'Bonjour à tous' }],
    source: 'audio+captions',
    notes: [],
  },
  summary: null,
  transcription: { timingPass: { ok: true }, textPass: { ok: false, error: 'quota' } },
  createdAt: 1_000,
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe('resultStore', () => {
  it('round-trips a result under result:<sessionId>', async () => {
    await putResult('s1', result);
    expect(await getResult('s1')).toEqual(result);
    expect(Object.keys(await fakeBrowser.storage.local.get(null))).toEqual(['result:s1']);
  });

  it('returns null when there is no result', async () => {
    expect(await getResult('s1')).toBeNull();
  });

  it('replaces and deletes results', async () => {
    await putResult('s1', result);
    await putResult('s1', { ...result, title: 'Renamed' });
    expect((await getResult('s1'))?.title).toBe('Renamed');
    await deleteResult('s1');
    expect(await getResult('s1')).toBeNull();
  });
});
