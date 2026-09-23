import { describe, expect, it, vi } from 'vitest';
import { processSession } from '@lib/pipeline/process';
import { saveSession } from '@lib/pipeline/save';
import type { MeetingAI, MeetingStore, ProcessJob, SessionResult } from '@lib/types';
import { sessionMeta, testProfile, testSettings } from '../helpers/meeting';

const CLIENT = testProfile({
  id: 'client',
  name: 'Client meeting',
  databaseId: 'client-db',
  prompt: 'Sales call.',
  sections: [{ id: 'n', title: 'Client needs', instruction: 'Their words.', format: 'bullets' }],
  vocabulary: ['Acme'],
});

function deps(overrides: { ai?: Partial<MeetingAI>; store?: Partial<MeetingStore> } = {}) {
  const ai: MeetingAI = {
    transcribe: vi.fn(async () => ({
      words: [{ text: 'Bonjour', start: 0, end: 500 }],
      text: 'Bonjour',
      timingPass: { ok: true as const },
      textPass: { ok: true as const },
    })),
    summarize: vi.fn(async () => ({ title: 'Acme call', sections: [], actionItems: [] })),
    ...overrides.ai,
  };
  const store: MeetingStore = {
    findByKey: vi.fn(async () => null),
    createMeeting: vi.fn(async () => ({ pageId: 'p1', url: 'https://notion.so/p1' })),
    listByKey: vi.fn(async () => []),
    archivePage: vi.fn(async () => undefined),
    ...overrides.store,
  };
  const audio = {
    readAudio: vi.fn(async () => new Blob([new Uint8Array(10)], { type: 'audio/webm' })),
    writeChunk: vi.fn(),
    stat: vi.fn(),
    list: vi.fn(),
    delete: vi.fn(),
  };
  return { ai, store, audio };
}

function job(overrides: Partial<ProcessJob> = {}): ProcessJob {
  return {
    meta: sessionMeta({ profileId: 'client' }),
    captions: [],
    settings: testSettings({ geminiApiKey: 'k', customVocabulary: ['Manet'] }),
    profile: CLIENT,
    ...overrides,
  };
}

describe('the pipeline with a profile', () => {
  it('checks the profile’s database, adds its vocabulary and writes its sections', async () => {
    const d = deps();
    const outcome = await processSession(job(), d);
    expect(d.store.findByKey).toHaveBeenCalledWith('client-db', expect.any(String));
    expect(vi.mocked(d.ai.transcribe).mock.calls[0]![1].customVocabulary).toEqual(
      expect.arrayContaining(['Manet', 'Acme']),
    );
    expect(vi.mocked(d.ai.summarize).mock.calls[0]![1].profile).toBe(CLIENT);
    expect(outcome.status === 'processed' && outcome.result.profile).toEqual({ id: 'client', name: 'Client meeting' });
  });

  it('summarizes a stored result again without touching the audio', async () => {
    const d = deps();
    const reuse: SessionResult = {
      title: 'Old',
      attendees: ['Marie'],
      transcript: {
        turns: [{ speaker: 'Marie', start: 0, end: 1000, text: 'Bonjour' }],
        source: 'audio+captions',
        notes: ['The summary could not be generated: timeout', 'Kept note.'],
      },
      summary: null,
      transcription: { timingPass: { ok: true }, textPass: { ok: true } },
      profile: { id: 'team', name: 'Team' },
      createdAt: 1,
    };
    const outcome = await processSession(job({ reuse }), d);
    expect(d.ai.transcribe).not.toHaveBeenCalled();
    expect(d.audio.readAudio).not.toHaveBeenCalled();
    expect(d.ai.summarize).toHaveBeenCalledOnce();
    if (outcome.status !== 'processed') throw new Error(outcome.status);
    expect(outcome.result.profile).toEqual({ id: 'client', name: 'Client meeting' });
    expect(outcome.result.transcript.turns).toEqual(reuse.transcript.turns);
    expect(outcome.result.transcript.notes).toEqual(['Kept note.']);
    expect(outcome.result.title).toBe('Acme call');
  });

  it('saves to the profile’s database with the profile’s name', async () => {
    const d = deps();
    const result: SessionResult = {
      title: 'Acme call', attendees: [], summary: null, transcription: null, createdAt: 1,
      transcript: { turns: [{ speaker: 'A', start: 0, end: 1, text: 'x' }], source: 'audio-only', notes: [] },
      profile: { id: 'client', name: 'Client meeting' },
    };
    // force skips the duplicate check and the settle loop, which would otherwise wait on Notion's index.
    await saveSession({ meta: sessionMeta({ profileId: 'client' }), result, settings: testSettings(), profile: CLIENT, force: true }, d);
    expect(d.store.createMeeting).toHaveBeenCalledWith('client-db', expect.objectContaining({ profileName: 'Client meeting' }));
  });
});
