/**
 * An unexpected error (a bug) ends a job with the words Meetings shows, and its own
 * words go to the console only.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NotionError } from '@lib/notion/client';
import { processSession, saveSession, type PipelineDeps } from '@lib/pipeline';
import { STOPPED } from '@lib/pipeline/notes';
import type { SessionResult } from '@lib/types';
import { sessionMeta, testSettings } from '../helpers/meeting';

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function deps(store: Partial<PipelineDeps['store']> = {}): PipelineDeps {
  const unused = () => Promise.reject(new Error('not used'));
  return {
    ai: { transcribe: unused, summarize: unused },
    store: { findByKey: async () => null, createMeeting: unused, listByKey: async () => [], archivePage: unused, ...store },
    audio: { writeChunk: unused, readAudio: async () => null, stat: unused, list: unused, delete: unused },
  };
}

const RESULT: SessionResult = {
  title: 'Weekly sync',
  attendees: ['Ilyas'],
  transcript: { turns: [{ speaker: 'Ilyas', start: 0, end: 1000, text: 'Hello.' }], source: 'captions-only', notes: [] },
  summary: null,
  transcription: null,
  createdAt: 0,
};

describe('STOPPED', () => {
  it('names what stopped and the next step, and names Notion only for a save', () => {
    expect(STOPPED).toEqual({
      process: 'Transcribing stopped before it finished. Try again.',
      save: 'Saving to Notion stopped before it finished. Try again.',
    });
  });
});

describe('processSession', () => {
  it('ends with “Transcribing stopped…” when something unexpected breaks, and logs the cause', async () => {
    const settings = { ...testSettings(), displayName: undefined as unknown as string };
    const outcome = await processSession({ meta: sessionMeta(), captions: [], settings, route: 'team' }, deps());
    expect(outcome).toEqual({ status: 'error', error: STOPPED.process });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Transcribing stopped/), expect.any(TypeError));
  });
});

describe('saveSession', () => {
  it('ends with “Saving to Notion stopped…” when something unexpected breaks, and logs the cause', async () => {
    const job = { meta: sessionMeta(), result: undefined as unknown as SessionResult, settings: testSettings(), route: 'team' as const };
    const outcome = await saveSession(job, deps());
    expect(outcome).toEqual({ status: 'error', error: STOPPED.save });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Saving to Notion stopped/), expect.any(TypeError));
  });

  it('explains what Notion said in people’s words', async () => {
    const rejected = new NotionError(401, 'unauthorized', 'API token is invalid.');
    const outcome = await saveSession(
      { meta: sessionMeta(), result: RESULT, settings: testSettings(), route: 'team' },
      deps({ findByKey: () => Promise.reject(rejected) }),
    );
    expect(outcome).toEqual({ status: 'error', error: 'Notion rejected the token. Copy it again in Settings.' });
    expect(JSON.stringify(outcome)).not.toMatch(/API token is invalid/);
  });
});
