import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mergeTranscript } from '@lib/merge';
import { audioEndMs, mergeInputFor } from '@lib/pipeline/process';
import type { CaptionSegment, SessionMeta, TimedWord, TranscriptionResult } from '@lib/types';
import { createFileAudioStore } from '../helpers/fileAudioStore';
import { seedAudio, SPEECH_EN, SPEECH_MIXED, SPEECH_MIXED_MS } from '../helpers/fixtures';
import { revisions, SELF_NAME, sessionMeta, STARTED_AT, testSettings } from '../helpers/meeting';

/** Words spoken one every `stepMs`, as the timing pass returns them. */
function spoken(text: string, startMs: number, stepMs = 400): TimedWord[] {
  return text.split(' ').map((w, i) => ({ text: w, start: startMs + i * stepMs, end: startMs + i * stepMs + 300 }));
}

function transcribed(words: TimedWord[], extra: Partial<TranscriptionResult> = {}): TranscriptionResult {
  const text = words.map((w) => w.text).join(' ');
  return { words, text, timingPass: { ok: true }, textPass: { ok: true }, ...extra };
}

function merged(meta: SessionMeta, captions: CaptionSegment[], t: TranscriptionResult | null, audioEnd?: number) {
  const input = mergeInputFor({ meta, captions, settings: testSettings() }, t, audioEnd, ['Earlier note.']);
  return mergeTranscript(input);
}

const textOf = (turns: { text: string }[]) => turns.map((t) => t.text).join(' ');

const RELEASE =
  'we should ship the release on friday after the review and then we can look at the metrics for the whole ' +
  'quarter together with the team';

describe('what the merge learns about the recording', () => {
  it("keeps the recorder's own caption text when their mic was not recorded, and leaves the words to others", () => {
    // Crosstalk: the recorder speaks over Alice. Meet never plays the local voice into the tab.
    const meta = sessionMeta();
    meta.audio.micIncluded = false;
    const captions = [
      ...revisions('a1', 'Alice', 1500, 12_500, [RELEASE]),
      ...revisions('s1', 'You', 5000, 8000, ['sorry can you share the deck please'], true),
    ];
    const t = merged(meta, captions, transcribed(spoken(RELEASE, 1000)));

    expect(t.source).toBe('audio+captions');
    const self = t.turns.filter((turn) => turn.speaker === SELF_NAME);
    expect(textOf(self)).toBe('sorry can you share the deck please');
    expect(textOf(t.turns.filter((turn) => turn.speaker === 'Alice'))).toBe(RELEASE);
    expect(t.notes[0]).toBe('Earlier note.');
    expect(t.notes).toContain(
      `${SELF_NAME}'s microphone was not recorded, so their words come from Meet captions ` +
        'and may contain recognition errors.',
    );
  });

  it('fills the part of a caption block that fell where a transcription part failed', () => {
    const bob =
      'the budget for the next quarter is still under discussion with finance and we expect an answer before ' +
      'the end of march';
    const heard = bob.split(' ').slice(0, 11).join(' ');
    const alice = 'we should ship the release on friday after the review';
    const captions = [
      ...revisions('a1', 'Alice', 1500, 11_000, [alice]),
      ...revisions('b1', 'Bob', 13_500, 31_500, [bob]),
    ];
    const t = merged(
      sessionMeta(),
      captions,
      transcribed([...spoken(alice, 1000), ...spoken(heard, 12_000, 800)], { gaps: [{ start: 20_500, end: 40_000 }] }),
    );

    expect(textOf(t.turns)).toBe(`${alice} ${bob}`);
    expect(t.notes).toContainEqual(expect.stringMatching(/^Where the audio had no transcript \(00:00:2/));
  });

  it('fills the rest of the meeting from captions after the audio stopped early', () => {
    const alice = 'we should ship the release on friday after the review';
    const tail =
      'so let us move the launch to the following monday then because the review needs two more days and the ' +
      'notes are not ready';
    const heard = tail.split(' ').slice(0, 10).join(' ');
    const captions = [
      ...revisions('a1', 'Alice', 1500, 11_000, [alice]),
      ...revisions('a2', 'Alice', 33_500, 51_500, [tail]),
    ];
    const words = [...spoken(alice, 1000), ...spoken(heard, 32_000, 800)];

    const t = merged(sessionMeta(), captions, transcribed(words), 40_200);
    expect(textOf(t.turns)).toBe(`${alice} ${tail}`);
    expect(t.notes).toContainEqual(expect.stringMatching(/^Where the audio had no transcript \(00:00:40/));
  });

  it('passes no range and no audio end when nothing is missing', () => {
    const input = mergeInputFor(
      { meta: sessionMeta(), captions: [], settings: testSettings({ displayName: ' Ilyas ' }) },
      transcribed([], { gaps: [] }),
      undefined,
      [],
    );
    expect(input).toEqual({ words: [], text: '', captions: [], selfName: 'Ilyas', notes: [], micIncluded: true });
  });
});

describe('audioEndMs', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function recorded(name: string, sessionId: string): Promise<Blob> {
    const root = await mkdtemp(join(tmpdir(), 'manet-audio-end-'));
    roots.push(root);
    const store = createFileAudioStore(root);
    await seedAudio(store, sessionId, name);
    const audio = await store.readAudio(sessionId);
    if (!audio) throw new Error('no audio was stored');
    return audio;
  }

  it('measures the audio that was recorded when the recorder stopped early', async () => {
    const meta = sessionMeta({ durationMs: SPEECH_MIXED_MS });
    meta.audio.error = 'The recorder stopped responding';
    const ms = await audioEndMs(meta, await recorded(SPEECH_EN, meta.id));
    // speech-en.webm is 40.2 s, while the meeting went on to 80.4 s.
    expect(ms).toBeGreaterThan(40_000);
    expect(ms).toBeLessThan(40_500);
  });

  it('is undefined when the audio ran until the end', async () => {
    const meta = sessionMeta();
    expect(await audioEndMs(meta, await recorded(SPEECH_MIXED, meta.id))).toBeUndefined();
  });

  it('falls back to the last persisted chunk when the WebM cannot be parsed', async () => {
    const meta = sessionMeta();
    meta.audio.error = 'Recorder error: EncodingError';
    const garbage = new Blob([new Uint8Array(64)], { type: 'audio/webm' });
    expect(await audioEndMs(meta, garbage)).toBeUndefined();
    meta.audio.lastChunkAt = STARTED_AT + 12_345;
    expect(await audioEndMs(meta, garbage)).toBe(12_345);
  });
});
