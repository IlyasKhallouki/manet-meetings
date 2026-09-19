/**
 * The offscreen entry script over WXT's fake chrome.runtime and the real messages.ts.
 * Node has no getUserMedia and no OPFS, so capture fails cleanly and the pipeline runs
 * captions-only: what is checked is that each message reaches the right code and that
 * progress flows back to the background. Recording itself is covered in real Chrome by
 * the *.browser.test.ts files next to this one.
 *
 * Notion and Gemini are called for real with deliberately invalid credentials.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleMessages, sendToOffscreen, type BackgroundProtocol } from '@lib/messages';
import { DEFAULT_SETTINGS } from '@lib/settings';
import type { CaptionSegment, JobStage, SessionMeta, Settings } from '@lib/types';

type Background = { [K in keyof BackgroundProtocol]: BackgroundProtocol[K] };

const SESSION = 'abc-defg-hij_20260919T101500Z';

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  geminiApiKey: 'invalid-gemini-key',
  notionToken: 'ntn_invalid_token_for_tests',
  notionTeamDbId: '0123456789abcdef0123456789abcdef',
  displayName: 'Ilyas',
};

const meta: SessionMeta = {
  id: SESSION,
  meetCode: 'abc-defg-hij',
  startedAt: Date.UTC(2026, 8, 19, 10, 15),
  durationMs: 60_000,
  status: 'processing',
  route: 'team',
  idempotencyKey: 'abc-defg-hij-2026-09-19',
  audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 0, bytes: 0, micIncluded: false },
  captionCount: 1,
};

const captions: CaptionSegment[] = [
  {
    id: 'c1',
    speaker: 'Ana',
    self: false,
    text: 'On valide le planning pour vendredi.',
    tStart: 1000,
    tEnd: 4000,
    rev: 2,
  },
];

const progress: { sessionId: string; stage: JobStage }[] = [];

beforeAll(async () => {
  fakeBrowser.reset();
  handleMessages<Background>('background', {
    'offscreen/job-progress': (p) => {
      progress.push(p);
    },
  });
  await import('@/entrypoints/offscreen/main');
});

beforeEach(() => {
  progress.length = 0;
});

describe('offscreen document messaging', () => {
  it('reports no recordings before any start', async () => {
    expect(await sendToOffscreen('offscreen/recorder-status', {})).toEqual({ recordingSessionIds: [] });
  });

  it('answers a start it cannot honour with a failure, not a thrown error', async () => {
    const res = await sendToOffscreen('offscreen/recorder-start', {
      sessionId: SESSION,
      streamId: 'stream-1',
      timesliceMs: 5000,
      includeMic: true,
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/^Tab audio capture failed: /) });
    expect(await sendToOffscreen('offscreen/recorder-status', {})).toEqual({ recordingSessionIds: [] });
  });

  it('runs a process job and reports its stages for the job session', async () => {
    const outcome = await sendToOffscreen('offscreen/process', { meta, captions, settings, route: 'team' });
    expect(outcome.status).toBe('processed');
    if (outcome.status !== 'processed') return;
    // No audio can be read here, so the captions carry the meeting.
    expect(outcome.result.transcript.source).toBe('captions-only');
    expect(outcome.result.transcript.turns.map((t) => t.speaker)).toEqual(['Ana']);
    await vi.waitFor(() => {
      expect(progress).toContainEqual({ sessionId: SESSION, stage: 'checking-duplicate' });
      expect(progress).toContainEqual({ sessionId: SESSION, stage: 'loading-audio' });
    });
    expect(progress.every((p) => p.sessionId === SESSION)).toBe(true);
  });

  it('runs a save job and reports the saving stage', async () => {
    const processed = await sendToOffscreen('offscreen/process', { meta, captions, settings, route: 'team' });
    if (processed.status !== 'processed') throw new Error(`process failed: ${processed.status}`);
    progress.length = 0;

    const job = { meta, result: processed.result, settings, route: 'team' } as const;
    const outcome = await sendToOffscreen('offscreen/save', job);
    // The token is invalid, so Notion refuses it; the answer still comes back as an outcome.
    expect(outcome).toEqual({ status: 'error', error: expect.stringMatching(/\S/) });
    await vi.waitFor(() => expect(progress).toContainEqual({ sessionId: SESSION, stage: 'saving' }));
  });
});
