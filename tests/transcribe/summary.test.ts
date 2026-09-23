import { describe, expect, it } from 'vitest';
import { STARTER_SECTIONS } from '@lib/profiles';
import { parseMeetingSummary, summarize, summaryRequest, SUMMARY_SCHEMA_FIELDS } from '@lib/transcribe/summary';
import type { NoteSection } from '@lib/types';

const ATTENDEES = ['Claire Dupont', 'Ilya K.', 'Paul Martin'];
const TRANSCRIPT = [
  'Claire Dupont: Bonjour à tous, on commence par la roadmap de Manet.',
  'Ilya K.: I will send the Notion template by Friday.',
  'Paul Martin: Je m’occupe du déploiement, on valide la version 1.2.',
].join('\n');

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

const CLIENT: NoteSection[] = [
  { id: 'a', title: 'Client needs', format: 'bullets', instruction: 'What they asked for, in their words.' },
  { id: 'b', title: 'Pricing', format: 'paragraph', instruction: 'Any numbers discussed.' },
];
const PROFILE = { prompt: 'Sales call with a prospect. Be concise.', sections: CLIENT };

const valid = {
  title: 'Roadmap Manet et déploiement',
  language: 'fr-FR',
  sections: { s1: ['Un export PDF'], s2: 'Environ 40 000 € par an.' },
  actionItems: [
    { task: 'Envoyer le modèle Notion', owner: 'Ilya K.', due: 'vendredi' },
    { task: 'Déployer la version 1.2', owner: 'Paul Martin' },
  ],
};

describe('summaryRequest', () => {
  const req = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE });

  it('asks gemini-3.5-flash for JSON through the polymorphic response_format', () => {
    expect(req.model).toBe('gemini-3.5-flash');
    expect(req.store).toBe(false);
    expect(req.response_format?.type).toBe('text');
    expect(req.response_format?.mime_type).toBe('application/json');
    expect(keysDeep(req)).not.toContain('response_mime_type');
    expect(keysDeep(req)).not.toContain('generation_config');
  });

  it('declares every MeetingSummary field in the schema', () => {
    const schema = req.response_format?.schema as {
      properties: Record<string, { items?: { properties?: Record<string, { enum?: string[] }> } }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual([...SUMMARY_SCHEMA_FIELDS]);
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'sections', 'actionItems']));
    // Owners can only be attendee names.
    expect(schema.properties.actionItems?.items?.properties?.owner?.enum).toEqual(ATTENDEES);
  });

  it('gives the model the date, attendees and transcript, and the language rule', () => {
    const input = String(req.input);
    expect(input).toContain('2026-09-19');
    for (const name of ATTENDEES) expect(input).toContain(name);
    expect(input).toContain('Je m’occupe du déploiement');
    expect(req.system_instruction).toMatch(/dominant language/i);
    expect(req.system_instruction).toMatch(/mix languages/i);
    expect(req.system_instruction).toMatch(/invent/i);
  });

  it('leaves owners free when no attendee is known', () => {
    const bare = summaryRequest(TRANSCRIPT, { attendees: [], meetingDate: '2026-09-19', profile: PROFILE });
    const schema = bare.response_format?.schema as {
      properties: { actionItems: { items: { properties: { owner: { enum?: string[] } } } } };
    };
    expect(schema.properties.actionItems.items.properties.owner.enum).toBeUndefined();
  });
});

describe('summaryRequest with a profile', () => {
  const req = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: PROFILE });
  const schema = req.response_format?.schema as {
    properties: Record<string, { properties?: Record<string, { type: string; description?: string }>; required?: string[] }>;
    required: string[];
  };

  it('lists the fields in order, sections keyed s1…sN by format', () => {
    expect(Object.keys(schema.properties)).toEqual(['language', 'title', 'sections', 'actionItems']);
    expect(schema.required).toEqual(['language', 'title', 'sections', 'actionItems']);
    const sections = schema.properties.sections!;
    expect(sections.required).toEqual(['s1', 's2']);
    expect(sections.properties?.s1).toMatchObject({ type: 'array', description: 'What they asked for, in their words.' });
    expect(sections.properties?.s2).toMatchObject({ type: 'string', description: 'Any numbers discussed.' });
  });

  it('puts the prompt and each section’s instruction in the system instruction', () => {
    const system = String(req.system_instruction);
    expect(system).toContain('About these meetings:\nSales call with a prospect. Be concise.');
    expect(system).toContain('- s1 “Client needs” (bullets): What they asked for, in their words.');
    expect(system).toContain('- s2 “Pricing” (paragraph): Any numbers discussed.');
    expect(system).not.toMatch(/small team/i);
  });

  it('leaves the sections out entirely for a profile without any', () => {
    const bare = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19', profile: { prompt: '', sections: [] } });
    const props = (bare.response_format?.schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(['language', 'title', 'actionItems']);
    expect(String(bare.system_instruction)).not.toContain('About these meetings');
  });
});

describe('parseMeetingSummary', () => {
  const opts = { attendees: ATTENDEES, sections: CLIENT, transcript: TRANSCRIPT };

  it('accepts a valid summary', () => {
    expect(parseMeetingSummary(JSON.stringify(valid), opts)).toEqual({
      title: valid.title,
      language: valid.language,
      sections: [
        { title: 'Client needs', format: 'bullets', text: '', items: ['Un export PDF'] },
        { title: 'Pricing', format: 'paragraph', text: 'Environ 40 000 € par an.', items: [] },
      ],
      actionItems: valid.actionItems,
    });
  });

  it('trims, drops blank entries and caps the title at 80 characters', () => {
    const s = parseMeetingSummary(
      JSON.stringify({
        ...valid,
        title: `  ${'Très long titre '.repeat(10)}`,
        sections: { s1: [' a ', '', '  '], s2: '' },
        actionItems: [{ task: '  Relire la PR  ', due: '' }],
      }),
      opts,
    );
    expect(s.title.length).toBeLessThanOrEqual(80);
    expect(s.title.startsWith('Très long titre')).toBe(true);
    expect(s.sections[0]!.items).toEqual(['a']);
    expect(s.sections[1]!.text).toEqual('');
    expect(s.actionItems).toEqual([{ task: 'Relire la PR' }]);
  });

  it('maps owners onto attendee names and drops invented ones', () => {
    const s = parseMeetingSummary(
      JSON.stringify({
        ...valid,
        actionItems: [
          { task: 'a', owner: 'claire dupont' },
          { task: 'b', owner: 'Paul' },
          { task: 'c', owner: 'Bob' },
        ],
      }),
      opts,
    );
    expect(s.actionItems).toEqual([
      { task: 'a', owner: 'Claire Dupont' },
      { task: 'b', owner: 'Paul Martin' },
      { task: 'c' },
    ]);
  });

  it('keeps an owner named in the transcript when attendees are unknown', () => {
    const s = parseMeetingSummary(
      JSON.stringify({ ...valid, actionItems: [{ task: 'a', owner: 'Paul Martin' }, { task: 'b', owner: 'Zoé' }] }),
      { attendees: [], sections: CLIENT, transcript: TRANSCRIPT },
    );
    expect(s.actionItems).toEqual([{ task: 'a', owner: 'Paul Martin' }, { task: 'b' }]);
  });

  it('tolerates a fenced JSON answer and a missing language', () => {
    const { language: _language, ...noLanguage } = valid;
    const s = parseMeetingSummary('```json\n' + JSON.stringify(noLanguage) + '\n```', opts);
    expect(s.title).toBe(valid.title);
    expect(s.language).toBeUndefined();
  });

  it('throws on anything that is not a MeetingSummary', () => {
    const bad = [
      '',
      'not json',
      '[]',
      JSON.stringify({ ...valid, title: '' }),
      JSON.stringify({ ...valid, sections: { s1: 42, s2: 'x' } }),
      JSON.stringify({ ...valid, actionItems: [{ owner: 'Paul Martin' }] }),
      JSON.stringify({ ...valid, actionItems: [{ task: 'x', due: 5 }] }),
    ];
    for (const raw of bad) expect(() => parseMeetingSummary(raw, opts), raw).toThrow(/invalid summary/);
  });
});

describe('parseMeetingSummary with a profile', () => {
  const parse = (raw: unknown, sections: readonly NoteSection[] = CLIENT) =>
    parseMeetingSummary(JSON.stringify(raw), { attendees: ATTENDEES, sections });

  it('maps s1…sN back onto the sections by position', () => {
    expect(parse(valid).sections).toEqual([
      { title: 'Client needs', format: 'bullets', text: '', items: ['Un export PDF'] },
      { title: 'Pricing', format: 'paragraph', text: 'Environ 40 000 € par an.', items: [] },
    ]);
  });

  it('reads a missing section as empty and tolerates a string for bullets or a list for a paragraph', () => {
    const out = parse({ ...valid, sections: { s1: 'Un export PDF', s2: ['Un.', 'Deux.'] } });
    expect(out.sections[0]!.items).toEqual(['Un export PDF']);
    expect(out.sections[1]!.text).toBe('Un.\n\nDeux.');
    expect(parse({ ...valid, sections: {} }).sections.map((s) => [s.text, s.items])).toEqual([
      ['', []],
      ['', []],
    ]);
  });

  it('has no sections for a profile without any, whatever the model sent', () => {
    expect(parse({ ...valid, sections: undefined }, []).sections).toEqual([]);
  });

  it('rejects sections that are not an object', () => {
    expect(() => parse({ ...valid, sections: ['x'] })).toThrow(/sections is not an object/);
  });

  it('writes the starter layout for Team and Personal', () => {
    const out = parse(
      { ...valid, sections: { s1: 'Revue de la roadmap.', s2: ['Roadmap revue'], s3: ['Version 1.2 validée'] } },
      STARTER_SECTIONS,
    );
    expect(out.sections.map((s) => s.title)).toEqual(['Summary', 'Key points', 'Decisions']);
  });
});

describe('summarize', () => {
  it('refuses an empty transcript without calling Gemini', async () => {
    let calls = 0;
    const counting: typeof fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return fetch(input, init);
    };
    await expect(
      summarize('key', '  \n ', { attendees: [], meetingDate: '2026-09-19', profile: PROFILE }, { fetch: counting }),
    ).rejects.toThrow(/Nothing to summarize/);
    expect(calls).toBe(0);
  });
});
