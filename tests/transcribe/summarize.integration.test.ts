import { describe, expect, it } from 'vitest';
import { GeminiError } from '@lib/gemini/rest';
import { STARTER_SECTIONS } from '@lib/profiles';
import { createGeminiMeetingAI } from '@lib/transcribe/ai';
import type { MeetingSummary, NoteSection } from '@lib/types';

// Real Gemini (gemini-3.5-flash, structured output).
const API_KEY = process.env.GOOGLE_API_KEY ?? '';
const ATTENDEES = ['Claire Dupont', 'Ilya K.', 'Paul Martin'];
const PROFILE = { prompt: '', sections: [...STARTER_SECTIONS] };
const CLIENT: NoteSection[] = [
  { id: 'a', title: 'Client needs', format: 'bullets', instruction: 'What they asked for, in their words.' },
  { id: 'b', title: 'Pricing', format: 'paragraph', instruction: 'Any numbers discussed.' },
];

const FRENCH_MEETING = [
  'Claire Dupont: Bonjour à tous. Aujourd’hui on fait le point sur la sortie de Manet Meetings.',
  'Paul Martin: La version 1.2 est prête, il reste les tests sur Chrome. Je m’en occupe d’ici jeudi.',
  'Ilya K.: OK. Et pour Notion, the new template is almost done, I will share it by Friday.',
  'Claire Dupont: Parfait. On valide donc la sortie de la version 1.2 lundi prochain.',
  'Paul Martin: D’accord. Il faudra aussi prévenir les clients par email.',
  'Claire Dupont: Je rédige l’email aux clients. Merci à tous.',
].join('\n');

const ENGLISH_MEETING = [
  'Ilya K.: Quick sync on the Lumind onboarding flow.',
  'Claire Dupont: The signup page is live, but the welcome email still has the old logo.',
  'Paul Martin: I can fix the logo today. On a mis à jour les couleurs aussi.',
  'Ilya K.: Great. We agree to launch the onboarding to all users next Tuesday.',
  'Claire Dupont: I will write the release notes before then.',
].join('\n');

function expectValidSummary(s: MeetingSummary): void {
  expect(s.title.length).toBeGreaterThan(0);
  expect(s.title.length).toBeLessThanOrEqual(80);
  expect(s.sections[0]!.text.length).toBeGreaterThan(20);
  expect(s.sections[1]!.items.length).toBeGreaterThan(0);
  expect(s.actionItems.length).toBeGreaterThan(0);
  for (const item of s.actionItems) {
    expect(item.task.length).toBeGreaterThan(0);
    if (item.owner !== undefined) expect(ATTENDEES).toContain(item.owner);
  }
}

describe('summarize against the real API with an invalid key', () => {
  it('rejects with the API error', async () => {
    const ai = createGeminiMeetingAI('manet-test-invalid-key');
    const err = await ai
      .summarize(FRENCH_MEETING, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE })
      .catch((e: unknown) => e);
    expect(err, 'needs network access to generativelanguage.googleapis.com').toBeInstanceOf(GeminiError);
    expect((err as GeminiError).apiMessage).toMatch(/API key not valid/);
  });
});

describe.skipIf(!API_KEY)('gemini summary integration (needs GOOGLE_API_KEY)', () => {
  const ai = createGeminiMeetingAI(API_KEY);

  it('summarizes a mostly French meeting in French with attendee owners', async () => {
    const s = await ai.summarize(FRENCH_MEETING, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE });
    expectValidSummary(s);
    expect(s.language?.toLowerCase()).toMatch(/^fr/);
    expect(s.sections[2]!.items.join(' ')).toMatch(/1\.2/);
    const owners = s.actionItems.map((a) => a.owner);
    expect(owners).toContain('Paul Martin');
    expect(owners).toContain('Claire Dupont');
  }, 120_000);

  it('summarizes a mostly English meeting in English', async () => {
    const s = await ai.summarize(ENGLISH_MEETING, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE });
    expectValidSummary(s);
    expect(s.language?.toLowerCase()).toMatch(/^en/);
    expect(s.actionItems.map((a) => a.owner)).toContain('Paul Martin');
  }, 120_000);

  it('follows a custom profile’s sections', async () => {
    const s = await ai.summarize(FRENCH_MEETING, {
      attendees: ATTENDEES,
      meetingDate: '2026-09-19',
      profile: { prompt: 'Sales call with a prospect. Be concise.', sections: CLIENT },
    });
    expect(s.sections.map((section) => section.title)).toEqual(['Client needs', 'Pricing']);
  }, 120_000);
});
