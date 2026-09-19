import { describe, expect, it } from 'vitest';
import { parseMeetingSummary, summarize, summaryRequest, SUMMARY_SCHEMA_FIELDS } from '@lib/transcribe/summary';

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

const valid = {
  title: 'Roadmap Manet et déploiement',
  language: 'fr-FR',
  summary: 'L’équipe a revu la roadmap et validé la version 1.2.',
  keyPoints: ['Roadmap de Manet revue'],
  decisions: ['Version 1.2 validée'],
  actionItems: [
    { task: 'Envoyer le modèle Notion', owner: 'Ilya K.', due: 'vendredi' },
    { task: 'Déployer la version 1.2', owner: 'Paul Martin' },
  ],
};

describe('summaryRequest', () => {
  const req = summaryRequest(TRANSCRIPT, { attendees: ATTENDEES, meetingDate: '2026-09-19' });

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
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'summary', 'keyPoints', 'decisions', 'actionItems']));
    // Owners can only be attendee names.
    expect(schema.properties.actionItems?.items?.properties?.owner?.enum).toEqual(ATTENDEES);
  });

  it('gives the model the date, attendees and transcript, and the language rule', () => {
    const input = String(req.input);
    expect(input).toContain('2026-09-19');
    for (const name of ATTENDEES) expect(input).toContain(name);
    expect(input).toContain('Je m’occupe du déploiement');
    expect(req.system_instruction).toMatch(/dominant language/i);
    expect(req.system_instruction).toMatch(/French/);
    expect(req.system_instruction).toMatch(/invent/i);
  });

  it('leaves owners free when no attendee is known', () => {
    const bare = summaryRequest(TRANSCRIPT, { attendees: [], meetingDate: '2026-09-19' });
    const schema = bare.response_format?.schema as {
      properties: { actionItems: { items: { properties: { owner: { enum?: string[] } } } } };
    };
    expect(schema.properties.actionItems.items.properties.owner.enum).toBeUndefined();
  });
});

describe('parseMeetingSummary', () => {
  const opts = { attendees: ATTENDEES, transcript: TRANSCRIPT };

  it('accepts a valid summary', () => {
    expect(parseMeetingSummary(JSON.stringify(valid), opts)).toEqual(valid);
  });

  it('trims, drops blank entries and caps the title at 80 characters', () => {
    const s = parseMeetingSummary(
      JSON.stringify({
        ...valid,
        title: `  ${'Très long titre '.repeat(10)}`,
        keyPoints: [' a ', '', '  '],
        decisions: [],
        actionItems: [{ task: '  Relire la PR  ', due: '' }],
      }),
      opts,
    );
    expect(s.title.length).toBeLessThanOrEqual(80);
    expect(s.title.startsWith('Très long titre')).toBe(true);
    expect(s.keyPoints).toEqual(['a']);
    expect(s.decisions).toEqual([]);
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
      { attendees: [], transcript: TRANSCRIPT },
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
      JSON.stringify({ ...valid, summary: 42 }),
      JSON.stringify({ ...valid, keyPoints: 'one' }),
      JSON.stringify({ ...valid, decisions: [1, 2] }),
      JSON.stringify({ ...valid, actionItems: [{ owner: 'Paul Martin' }] }),
      JSON.stringify({ ...valid, actionItems: [{ task: 'x', due: 5 }] }),
    ];
    for (const raw of bad) expect(() => parseMeetingSummary(raw, opts), raw).toThrow(/invalid summary/);
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
      summarize('key', '  \n ', { attendees: [], meetingDate: '2026-09-19' }, { fetch: counting }),
    ).rejects.toThrow(/Nothing to summarize/);
    expect(calls).toBe(0);
  });
});
