/**
 * Realistic session data for pipeline tests: SessionMeta, Settings and Meet caption
 * blocks the way the content script records them (several revisions per block, the
 * local user labelled "You").
 */
import { starterProfiles } from '@lib/profiles';
import type { CaptionSegment, Settings, SessionMeta } from '@lib/types';
import { SPEECH_MIXED_MS } from './fixtures';

export const MEET_CODE = 'abc-defg-hij';
export const SELF_NAME = 'Ilyas';
/** 2026-09-19 10:15:30 local time. */
export const STARTED_AT = new Date(2026, 8, 19, 10, 15, 30).getTime();

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    geminiApiKey: '',
    notionToken: '',
    notionTeamDbId: '',
    notionPersonalDbId: '',
    defaultRoute: 'team',
    autoTranscribe: true,
    retentionDays: 7,
    displayName: SELF_NAME,
    customVocabulary: ['Lumind', 'Manet'],
    languageCodes: [],
    includeMic: true,
    profiles: starterProfiles(),
    defaultProfileId: 'team',
    ...overrides,
  };
}

export function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: `${MEET_CODE}_20260919T081530Z`,
    meetCode: MEET_CODE,
    meetingTitle: 'Weekly sync',
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + SPEECH_MIXED_MS,
    durationMs: SPEECH_MIXED_MS,
    status: 'processing',
    route: 'team',
    idempotencyKey: `${MEET_CODE}-2026-09-19`,
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 0, bytes: 0, micIncluded: true },
    captionCount: 0,
    ...overrides,
  };
}

/** Every revision of one caption block, text growing as Meet refines it. */
export function revisions(
  id: string,
  speaker: string,
  tStart: number,
  tEnd: number,
  texts: string[],
  self = false,
): CaptionSegment[] {
  return texts.map((text, rev) => ({
    id,
    speaker,
    self,
    text,
    tStart,
    tEnd: texts.length === 1 ? tEnd : Math.round(tStart + ((tEnd - tStart) * rev) / (texts.length - 1)),
    rev,
  }));
}

/**
 * Captions a Meet call would show for tests/fixtures/audio/speech-mixed.webm, as if
 * Camille read the English half and the local user ("You") the French half. Blocks
 * trail speech by about 1.5 s and split at the long pauses (≈ 30–33 s, 70–73 s).
 */
export function mixedSpeechCaptions(): CaptionSegment[] {
  return [
    ...revisions('c1', 'Camille Martin', 2_500, 31_000, [
      'A Scandal in Bohemia',
      'A Scandal in Bohemia, from The Adventures of Sherlock Holmes by Sir Arthur Conan Doyle.',
      'A Scandal in Bohemia, from The Adventures of Sherlock Holmes by Sir Arthur Conan Doyle. This is a LibriVox ' +
        'recording. All LibriVox recordings are in the public domain. For more information or to volunteer, ' +
        'please visit librivox.org.',
    ]),
    ...revisions('c2', 'Camille Martin', 34_600, 41_300, [
      'To Sherlock Holmes she is',
      'To Sherlock Holmes she is always the woman. I have seldom heard him mention her under any other name.',
    ]),
    ...revisions(
      'c3',
      'You',
      43_300,
      71_500,
      [
        'Chapitre premier.',
        'Chapitre premier du Tour du monde en quatre-vingts jours, de Jules Verne.',
        'Chapitre premier du Tour du monde en quatre-vingts jours, de Jules Verne. Ceci est un enregistrement ' +
          'LibriVox. Tous les enregistrements LibriVox sont dans le domaine public.',
      ],
      true,
    ),
    ...revisions(
      'c4',
      'You',
      74_300,
      80_300,
      [
        'Dans lequel Phileas Fogg',
        "Dans lequel Phileas Fogg et Passepartout s'acceptent réciproquement, l'un comme maître, l'autre comme domestique.",
      ],
      true,
    ),
  ];
}
