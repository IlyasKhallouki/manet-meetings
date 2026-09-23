import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { deleteResult, getResult, normalizeSummary, putResult } from '@lib/storage/resultStore';
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

describe('normalizeSummary', () => {
  it('turns a summary from before profiles into the three starter sections', () => {
    const old = { title: 'Sync', summary: 'We met.', keyPoints: ['A'], decisions: [], actionItems: [], language: 'en-US' };
    expect(normalizeSummary(old as never)).toEqual({
      title: 'Sync',
      sections: [
        { title: 'Summary', format: 'paragraph', text: 'We met.', items: [] },
        { title: 'Key points', format: 'bullets', text: '', items: ['A'] },
        { title: 'Decisions', format: 'bullets', text: '', items: [] },
      ],
      actionItems: [],
      language: 'en-US',
    });
  });

  it('leaves a current summary and null alone', () => {
    const current = { title: 'Sync', sections: [], actionItems: [] };
    expect(normalizeSummary(current)).toBe(current);
    expect(normalizeSummary(null)).toBeNull();
  });
});

describe('getResult', () => {
  beforeEach(() => fakeBrowser.reset());

  it('reads an old stored result in the new shape', async () => {
    await fakeBrowser.storage.local.set({
      'result:s1': {
        title: 'Sync',
        attendees: [],
        transcript: { turns: [], source: 'audio-only', notes: [] },
        summary: { title: 'Sync', summary: 'We met.', keyPoints: [], decisions: [], actionItems: [] },
        transcription: null,
        createdAt: 1,
      },
    });
    expect((await getResult('s1'))?.summary?.sections[0]).toEqual({
      title: 'Summary',
      format: 'paragraph',
      text: 'We met.',
      items: [],
    });
  });
});
