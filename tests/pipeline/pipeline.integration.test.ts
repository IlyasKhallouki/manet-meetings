import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeToken, splitWords } from '@lib/align/sequence';
import { UNKNOWN_SPEAKER } from '@lib/merge';
import { NotionClient, type NotionPage } from '@lib/notion/client';
import { sameNotionId } from '@lib/notion/ids';
import { createNotionMeetingStore } from '@lib/notion/store';
import { createPipelineDeps, processSession, saveSession, type PipelineDeps } from '@lib/pipeline';
import { isDuplicateCheckNote, NOTES } from '@lib/pipeline/notes';
import { createGeminiMeetingAI } from '@lib/transcribe/ai';
import {
  MAX_TRANSCRIBE_ATTEMPTS,
  type CaptionSegment,
  type JobStage,
  type ProcessJob,
  type SessionMeta,
  type SessionResult,
  type Settings,
} from '@lib/types';
import { createFileAudioStore } from '../helpers/fileAudioStore';
import { seedAudio, SPEECH_EN, SPEECH_MIXED, SPEECH_MIXED_SWITCH_MS } from '../helpers/fixtures';
import { MEET_CODE, mixedSpeechCaptions, revisions, SELF_NAME, sessionMeta, testSettings } from '../helpers/meeting';
import { countingFetch, eventually, refusedBaseUrl } from '../helpers/network';

const GEMINI_KEY = process.env.GOOGLE_API_KEY ?? '';
const NOTION_TOKEN = process.env.NOTION_TOKEN ?? '';
const NOTION_DB = process.env.NOTION_TEST_DB_ID ?? '';
const HAS_NOTION = Boolean(NOTION_TOKEN && NOTION_DB);

const INVALID_GEMINI_KEY = 'manet-test-invalid-key';
const INVALID_NOTION_TOKEN = 'ntn_manet_test_invalid_token';
/** Well-formed but unknown, so the request reaches Notion and fails on the token. */
const UNKNOWN_DB_ID = '0123456789abcdef0123456789abcdef';

const KEY_INVALID = /API key not valid/;
const FR_DISTINCTIVE = ['verne', 'monde', 'passepartout', 'fogg', 'phileas'];
const VOCABULARY = ['Lumind', 'Manet', 'LibriVox', 'Sherlock Holmes', 'Arthur Conan Doyle', 'Jules Verne', 'Phileas Fogg'];

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function audioStore() {
  const root = await mkdtemp(join(tmpdir(), 'manet-pipeline-'));
  roots.push(root);
  return { root, store: createFileAudioStore(root) };
}

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let sessions = 0;
/** A session with its own id and Notion key, so runs never see each other's pages. */
function uniqueMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const n = ++sessions;
  const idempotencyKey = `pipeline-itest-${run}-${n}-2026-09-19`;
  return sessionMeta({ id: `${MEET_CODE}_${run}_${n}`, idempotencyKey, ...overrides });
}

function invalidSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    geminiApiKey: INVALID_GEMINI_KEY,
    notionToken: INVALID_NOTION_TOKEN,
    notionTeamDbId: UNKNOWN_DB_ID,
    notionPersonalDbId: UNKNOWN_DB_ID,
    ...overrides,
  });
}

function job(meta: SessionMeta, captions: CaptionSegment[], settings: Settings): ProcessJob {
  return { meta, captions, settings, route: 'team' };
}

const tokensOf = (text: string) => splitWords(text).map(normalizeToken).filter(Boolean);

/** Real Gemini client; a stalled connection fails after 20 s instead of the production 5–20 min. */
function gemini(apiKey: string, fetch?: typeof globalThis.fetch) {
  return createGeminiMeetingAI(apiKey, { rest: { timeoutMs: 20_000, ...(fetch ? { fetch } : {}) } });
}

function processed(outcome: Awaited<ReturnType<typeof processSession>>): SessionResult {
  if (outcome.status !== 'processed') throw new Error(`expected processed, got ${JSON.stringify(outcome)}`);
  return outcome.result;
}

describe('pipeline against the real APIs with invalid credentials (network only)', () => {
  it('still files the meeting from captions when Notion and Gemini both refuse', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings();
    const stages: JobStage[] = [];
    const deps = createPipelineDeps(settings, store, (s) => stages.push(s));

    const before = Date.now();
    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));

    expect(stages).toEqual(['checking-duplicate', 'loading-audio', 'transcribing-timing', 'merging', 'summarizing']);
    expect(result.transcription?.timingPass).toEqual({ ok: false, error: expect.stringMatching(KEY_INVALID) });
    expect(result.transcription?.textPass).toEqual({ ok: false, error: expect.stringMatching(KEY_INVALID) });
    expect(result.summary).toBeNull();
    expect(result.title).toBe('Weekly sync');
    expect(result.attendees).toEqual(['Camille Martin', SELF_NAME]);
    expect(result.createdAt).toBeGreaterThanOrEqual(before);

    const { transcript } = result;
    expect(transcript.source).toBe('captions-only');
    // Latest caption revisions, the local user under their own name, in time order.
    const speakers = transcript.turns.map((t) => t.speaker).filter((s, i, all) => s !== all[i - 1]);
    expect(speakers).toEqual(['Camille Martin', SELF_NAME]);
    const text = transcript.turns.map((t) => t.text).join(' ');
    expect(text.match(/A Scandal in Bohemia/g)).toHaveLength(1);
    expect(text).toContain('please visit librivox.org.');
    expect(text).toContain("l'autre comme domestique.");

    expect(transcript.notes[0]).toMatch(
      /^Notion was not checked for an existing page before transcribing: Notion says the token is invalid/,
    );
    expect(transcript.notes[1]).toMatch(/^Audio transcription failed: .*API key not valid/);
    expect(transcript.notes).toContainEqual(expect.stringMatching(/text comes from Meet captions/));
    expect(transcript.notes.at(-1)).toMatch(/^The summary could not be generated: .*API key not valid/);
  }, 60_000);

  it('reports why a save failed without throwing', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    const settings = invalidSettings();
    const stages: JobStage[] = [];
    const result: SessionResult = {
      title: 'Weekly sync',
      attendees: ['Camille Martin', SELF_NAME],
      transcript: {
        turns: [{ speaker: 'Camille Martin', start: 1000, end: 3000, text: 'Bonjour à tous.' }],
        source: 'captions-only',
        notes: [],
      },
      summary: null,
      transcription: null,
      createdAt: Date.now(),
    };
    const outcome = await saveSession(
      { meta, result, settings, route: 'personal' },
      createPipelineDeps(settings, store, (s) => stages.push(s)),
    );
    expect(outcome).toEqual({ status: 'error', error: expect.stringMatching(/token is invalid/) });
    expect(stages).toEqual(['saving']);
  }, 60_000);

  it('does not upload anything when no audio was recorded, and says why', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta({
      audio: { mimeType: '', chunkCount: 0, bytes: 0, micIncluded: false, error: 'Tab capture was refused.' },
    });
    const settings = invalidSettings();
    const { fetch, counts } = countingFetch();
    const stages: JobStage[] = [];
    const deps: PipelineDeps = {
      ai: gemini(settings.geminiApiKey, fetch),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      onStage: (s) => stages.push(s),
    };

    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));

    expect(counts.uploads).toBe(0);
    expect(counts.interactions).toBe(1); // the summary attempt
    expect(stages).toEqual(['checking-duplicate', 'loading-audio', 'merging', 'summarizing']);
    expect(result.transcription).toBeNull();
    expect(result.transcript.source).toBe('captions-only');
    expect(result.transcript.notes[1]).toBe('No audio was recorded: Tab capture was refused.');
  }, 60_000);

  it('does not read audio that retention already deleted', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    meta.audio.deletedAt = Date.now();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings();
    const { fetch, counts } = countingFetch();
    const deps: PipelineDeps = {
      ai: gemini(settings.geminiApiKey, fetch),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
    };

    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));

    expect(counts.uploads).toBe(0);
    expect(result.transcription).toBeNull();
    expect(result.transcript.notes).toContain(NOTES.audioDeleted);
    expect(result.transcript.source).toBe('captions-only');
  }, 60_000);

  it('carries on from captions when the stored audio cannot be read', async () => {
    const { root, store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const audioDir = join(root, 'sessions', meta.id, 'audio');
    await chmod(audioDir, 0o000);
    try {
      const settings = invalidSettings();
      const { fetch, counts } = countingFetch();
      const deps: PipelineDeps = {
        ai: gemini(settings.geminiApiKey, fetch),
        store: createNotionMeetingStore(settings.notionToken),
        audio: store,
      };
      const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));
      expect(counts.uploads).toBe(0);
      expect(result.transcription).toBeNull();
      expect(result.transcript.notes[1]).toMatch(/^The audio recording could not be read: .*EACCES/);
      expect(result.transcript.source).toBe('captions-only');
    } finally {
      await chmod(audioDir, 0o755);
    }
  }, 60_000);

  it('makes no Gemini call when nothing was captured', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta({ meetingTitle: undefined });
    const settings = invalidSettings();
    const { fetch, counts } = countingFetch();
    const stages: JobStage[] = [];
    const deps: PipelineDeps = {
      ai: gemini(settings.geminiApiKey, fetch),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      onStage: (s) => stages.push(s),
    };

    const result = processed(await processSession(job(meta, [], settings), deps));

    expect(counts.requests).toBe(0);
    expect(stages).toEqual(['checking-duplicate', 'loading-audio', 'merging']);
    expect(result.title).toBe(`Meeting ${MEET_CODE}`);
    expect(result.attendees).toEqual([SELF_NAME]);
    expect(result.transcript.turns).toEqual([]);
    expect(result.transcript.notes.slice(1)).toEqual([
      'No audio was recorded.',
      'Nothing was captured: no audio transcript and no captions.',
    ]);
  }, 60_000);

  it('skips the Notion check when the user chose to transcribe anyway', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings();
    const stages: JobStage[] = [];
    const deps = createPipelineDeps(settings, store, (s) => stages.push(s));

    const result = processed(
      await processSession({ ...job(meta, mixedSpeechCaptions(), settings), force: true }, deps),
    );

    expect(stages).toEqual(['loading-audio', 'transcribing-timing', 'merging', 'summarizing']);
    expect(result.transcript.notes.some(isDuplicateCheckNote)).toBe(false);
    expect(result.transcript.notes[0]).toMatch(/^Audio transcription failed: .*API key not valid/);
  }, 60_000);

  it('asks to try again later while Gemini is unreachable, and files the captions on the last attempt', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings({ geminiApiKey: 'manet-test-key' });
    const stages: JobStage[] = [];
    const deps: PipelineDeps = {
      // A refused connection: a real network failure, as when a laptop wakes up offline.
      ai: createGeminiMeetingAI(settings.geminiApiKey, { rest: { baseUrl: await refusedBaseUrl(), retries: 0 } }),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      onStage: (s) => stages.push(s),
    };
    const attempt = (n?: number) =>
      processSession({ ...job(meta, mixedSpeechCaptions(), settings), ...(n ? { attempt: n } : {}) }, deps);

    const unreachable = /^Could not reach Gemini/;
    expect(await attempt()).toEqual({ status: 'retry-later', error: expect.stringMatching(unreachable) });
    expect(stages).toEqual(['checking-duplicate', 'loading-audio', 'transcribing-timing']);
    expect(await attempt(MAX_TRANSCRIBE_ATTEMPTS - 1)).toEqual({
      status: 'retry-later',
      error: expect.stringMatching(unreachable),
    });

    const last = processed(await attempt(MAX_TRANSCRIBE_ATTEMPTS));
    expect(last.transcript.source).toBe('captions-only');
    expect(last.transcription?.timingPass).toEqual({ ok: false, error: expect.stringMatching(unreachable) });
    expect(last.transcript.notes[1]).toMatch(/^Audio transcription failed: Could not reach Gemini/);
    expect(last.transcript.notes.at(-1)).toMatch(/^The summary could not be generated: Could not reach Gemini/);
  }, 60_000);

  it('files the captions without calling Gemini when no Gemini key is set', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings({ geminiApiKey: '' });
    const { fetch, counts } = countingFetch();
    const stages: JobStage[] = [];
    const deps: PipelineDeps = {
      ai: gemini(settings.geminiApiKey, fetch),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      onStage: (s) => stages.push(s),
    };

    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));

    expect(counts.requests).toBe(0);
    expect(stages).toEqual(['checking-duplicate', 'merging']);
    expect(result.transcription).toBeNull();
    expect(result.summary).toBeNull();
    expect(result.title).toBe('Weekly sync');
    expect(result.transcript.source).toBe('captions-only');
    expect(result.transcript.notes[1]).toBe(NOTES.noGeminiKey);
    expect(result.transcript.turns.map((t) => t.text).join(' ')).toContain("l'autre comme domestique.");
  }, 60_000);

  it('says when the audio stopped, measured from the recording', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    meta.audio.error = 'The recorder stopped responding';
    await seedAudio(store, meta.id, SPEECH_EN); // 40.2 s of an 80.4 s call
    const settings = invalidSettings();

    const result = processed(
      await processSession(job(meta, mixedSpeechCaptions(), settings), createPipelineDeps(settings, store)),
    );

    expect(result.transcript.notes[1]).toBe(
      'Audio recording stopped early at 00:00:40 (The recorder stopped responding); ' +
        'after that, the transcript relies on Meet captions.',
    );
    expect(result.transcript.source).toBe('captions-only');
  }, 60_000);

  it('keeps going when the progress callback throws or rejects', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings();
    const stages: JobStage[] = [];
    const deps: PipelineDeps = {
      ai: gemini(settings.geminiApiKey),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      // Alternately throws and returns a rejected promise, like an async sendMessage
      // wrapper; vitest fails the run on an unhandled rejection.
      onStage: (s) => {
        stages.push(s);
        if (stages.length % 2) throw new Error('the background went away');
        return Promise.reject(new Error('no receiver'));
      },
    };
    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps));
    // The transcriber reports progress too; the key, not the callback, stopped it.
    expect(stages).toContain('transcribing-timing');
    expect(result.transcription?.timingPass).toEqual({ ok: false, error: expect.stringMatching(KEY_INVALID) });
    expect(result.transcript.notes.at(-1)).toMatch(KEY_INVALID);
  }, 60_000);
});

const NOTION_SUITE = 'pipeline with real Notion and an invalid Gemini key (needs NOTION_TOKEN + NOTION_TEST_DB_ID)';

describe.skipIf(!HAS_NOTION)(NOTION_SUITE, () => {
  const notion = createNotionMeetingStore(NOTION_TOKEN);
  const client = new NotionClient(NOTION_TOKEN);
  const keys: string[] = [];

  afterAll(async () => {
    for (const key of keys) {
      for (const page of await notion.listByKey(NOTION_DB, key).catch(() => [])) {
        await notion.archivePage(page.pageId).catch(() => undefined);
      }
    }
  }, 120_000);

  it('files a captions-only meeting, then reports it as a duplicate without calling Gemini', async () => {
    const { store } = await audioStore();
    const meta = uniqueMeta();
    keys.push(meta.idempotencyKey);
    await seedAudio(store, meta.id, SPEECH_MIXED);
    const settings = invalidSettings({ notionToken: NOTION_TOKEN, notionTeamDbId: NOTION_DB });
    const deps = (counting = countingFetch(), stages: JobStage[] = []): PipelineDeps => ({
      ai: gemini(settings.geminiApiKey, counting.fetch),
      store: createNotionMeetingStore(settings.notionToken),
      audio: store,
      onStage: (s) => stages.push(s),
    });

    const result = processed(await processSession(job(meta, mixedSpeechCaptions(), settings), deps()));
    expect(result.transcript.source).toBe('captions-only');
    expect(result.transcript.notes.some((n) => n.startsWith('Notion was not checked'))).toBe(false);

    const saved = await saveSession({ meta, result, settings, route: 'team' }, deps());
    expect(saved.status).toBe('created');
    if (saved.status !== 'created') return;

    const page = await client.request<NotionPage>('GET', `/pages/${saved.pageId}`);
    const text = (name: string) => page.properties[name]?.rich_text?.map((r) => r.plain_text).join('');
    const title = Object.values(page.properties).find((p) => p.type === 'title');
    expect(title?.title?.map((r) => r.plain_text).join('')).toBe('Weekly sync');
    expect(page.properties.Source?.select?.name).toBe('captions-only');
    expect(text('Key')).toBe(meta.idempotencyKey);
    expect(text('Recorded by')).toBe(SELF_NAME);
    expect(text('Meet code')).toBe(MEET_CODE);
    expect(page.properties.Duration?.number).toBe(1.3); // 80.4 s in minutes
    expect(page.properties.Attendees?.multi_select?.map((o) => o.name.toLowerCase())).toEqual(['camille martin', 'ilyas']);

    await eventually(() => notion.findByKey(NOTION_DB, meta.idempotencyKey), (v) => v !== null);

    const counting = countingFetch();
    const stages: JobStage[] = [];
    const again = await processSession(job(meta, mixedSpeechCaptions(), settings), deps(counting, stages));
    expect(again.status).toBe('duplicate');
    if (again.status !== 'duplicate') return;
    expect(sameNotionId(again.existing.pageId, saved.pageId)).toBe(true);
    expect(again.existing.recordedBy).toBe(SELF_NAME);
    expect(counting.counts.requests).toBe(0);
    expect(stages).toEqual(['checking-duplicate']);

    const savedAgain = await saveSession({ meta, result, settings, route: 'team' }, deps());
    expect(savedAgain.status).toBe('duplicate');

    // "Transcribe anyway", then "Save anyway": the user saw that page and wants theirs filed too.
    const forcedStages: JobStage[] = [];
    const forcedJob = { ...job(meta, mixedSpeechCaptions(), settings), force: true };
    const forced = processed(await processSession(forcedJob, deps(countingFetch(), forcedStages)));
    expect(forcedStages[0]).toBe('loading-audio');
    const savedAnyway = await saveSession({ meta, result: forced, settings, route: 'team', force: true }, deps());
    expect(savedAnyway.status).toBe('created');
    if (savedAnyway.status !== 'created') return;
    expect(sameNotionId(savedAnyway.pageId, saved.pageId)).toBe(false);
    const pages = await eventually(
      () => notion.listByKey(NOTION_DB, meta.idempotencyKey),
      (v) => v.length === 2,
    );
    expect(pages.map((p) => p.pageId).some((id) => sameNotionId(id, savedAnyway.pageId))).toBe(true);
  }, 240_000);
});

describe.skipIf(!GEMINI_KEY)(
  'pipeline with real Gemini (needs GOOGLE_API_KEY; the save also needs NOTION_TOKEN + NOTION_TEST_DB_ID)',
  () => {
    const meta = uniqueMeta();
    const settings = testSettings({
      geminiApiKey: GEMINI_KEY,
      notionToken: HAS_NOTION ? NOTION_TOKEN : INVALID_NOTION_TOKEN,
      notionTeamDbId: HAS_NOTION ? NOTION_DB : UNKNOWN_DB_ID,
      customVocabulary: VOCABULARY,
    });
    let deps: PipelineDeps;
    let result: SessionResult | undefined;

    beforeAll(async () => {
      const { store } = await audioStore();
      await seedAudio(store, meta.id, SPEECH_MIXED);
      deps = createPipelineDeps(settings, store);
    });

    afterAll(async () => {
      if (!HAS_NOTION) return;
      const notion = createNotionMeetingStore(NOTION_TOKEN);
      for (const page of await notion.listByKey(NOTION_DB, meta.idempotencyKey).catch(() => [])) {
        await notion.archivePage(page.pageId).catch(() => undefined);
      }
    }, 120_000);

    it('transcribes the recording, gives each word its caption speaker and summarizes', async () => {
      const stages: JobStage[] = [];
      result = processed(
        await processSession(job(meta, mixedSpeechCaptions(), settings), { ...deps, onStage: (s) => stages.push(s) }),
      );

      expect(stages.slice(0, 3)).toEqual(['checking-duplicate', 'loading-audio', 'transcribing-timing']);
      expect(stages.slice(-3)).toEqual(['aligning', 'merging', 'summarizing']);
      expect(result.transcription).toEqual({ timingPass: { ok: true }, textPass: { ok: true } });
      expect(result.transcript.source).toBe('audio+captions');
      // Nothing degraded (a "Speaker unknown for …" note about a stray word is fine).
      const degraded = result.transcript.notes.filter(
        (n) => !n.startsWith('Notion was not checked') && /failed|could not|unavailable|not captured|No audio/i.test(n),
      );
      expect(degraded).toEqual([]);
      expect(result.attendees).toEqual(['Camille Martin', SELF_NAME]);

      expect(result.summary).not.toBeNull();
      expect(result.summary!.title.length).toBeGreaterThan(0);
      expect(result.summary!.summary.length).toBeGreaterThan(0);
      expect(result.title).toBe(result.summary!.title);

      const { turns } = result.transcript;
      const tokensBy = (speaker: string) =>
        tokensOf(turns.filter((t) => t.speaker === speaker).map((t) => t.text).join(' '));
      const camille = tokensBy('Camille Martin');
      const self = tokensBy(SELF_NAME);
      const unknown = tokensBy(UNKNOWN_SPEAKER);
      expect(camille).toContain('holmes');
      expect(camille.some((t) => FR_DISTINCTIVE.includes(t))).toBe(false);
      expect(self.some((t) => FR_DISTINCTIVE.includes(t))).toBe(true);
      expect(self).not.toContain('holmes');
      expect(unknown.length).toBeLessThanOrEqual(0.05 * (camille.length + self.length + unknown.length));
      for (const t of turns) {
        if (t.speaker === 'Camille Martin') expect(t.start).toBeLessThan(SPEECH_MIXED_SWITCH_MS + 1500);
        if (t.speaker === SELF_NAME) expect(t.end).toBeGreaterThan(SPEECH_MIXED_SWITCH_MS - 1500);
      }
      // Vocabulary spelling from the text pass.
      expect([...camille, ...self]).toContain('librivox');
    }, 300_000);

    it('keeps what only captions have: the recorder without a mic, and the call after the audio stopped', async () => {
      const { store } = await audioStore();
      const early = uniqueMeta({
        audio: {
          mimeType: 'audio/webm;codecs=opus',
          chunkCount: 0,
          bytes: 0,
          micIncluded: false,
          error: 'The recorder stopped responding',
        },
      });
      // 40.2 s of English, then the recorder died while the call went on in French.
      await seedAudio(store, early.id, SPEECH_EN);
      const selfLine = 'Merci Camille, on passe au budget.';
      const jeanLine = 'Chapitre premier du Tour du monde en quatre-vingts jours, de Jules Verne.';
      const captions = [
        ...mixedSpeechCaptions().filter((c) => !c.self),
        // In the pause after Camille's first block; the tab audio never has the recorder's voice.
        ...revisions('s1', 'You', 31_500, 33_800, [selfLine], true),
        ...revisions('j1', 'Jean Dupont', 45_000, 58_000, ['Chapitre premier', jeanLine]),
      ];

      const out = processed(await processSession(job(early, captions, settings), createPipelineDeps(settings, store)));

      expect(out.transcript.source).toBe('audio+captions');
      const { turns, notes } = out.transcript;
      const tokensBy = (speaker: string) =>
        tokensOf(turns.filter((t) => t.speaker === speaker).map((t) => t.text).join(' '));
      expect(tokensBy(SELF_NAME)).toEqual(tokensOf(selfLine));
      expect(tokensBy('Jean Dupont')).toEqual(tokensOf(jeanLine));
      expect(tokensBy('Camille Martin')).toContain('holmes');
      expect(notes).toContain(
        'Audio recording stopped early at 00:00:40 (The recorder stopped responding); ' +
          'after that, the transcript relies on Meet captions.',
      );
      expect(notes).toContainEqual(expect.stringMatching(new RegExp(`^${SELF_NAME}'s microphone was not recorded`)));
      expect(notes).toContainEqual(expect.stringMatching(/^Where the audio had no transcript \(00:00:4/));
    }, 300_000);

    it.skipIf(!HAS_NOTION)('saves the transcribed meeting to Notion', async () => {
      expect(result, 'needs the transcription test to have run').toBeDefined();
      const saved = await saveSession({ meta, result: result!, settings, route: 'team' }, deps);
      expect(saved.status).toBe('created');
      if (saved.status !== 'created') return;
      const page = await new NotionClient(NOTION_TOKEN).request<NotionPage>('GET', `/pages/${saved.pageId}`);
      expect(page.properties.Source?.select?.name).toBe('audio+captions');
      const title = Object.values(page.properties).find((p) => p.type === 'title');
      expect(title?.title?.map((r) => r.plain_text).join('')).toBe(result!.title);
    }, 180_000);
  },
);
