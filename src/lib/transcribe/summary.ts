/**
 * Meeting summary with gemini-3.5-flash structured output. The answer is validated
 * and normalized here because the schema only constrains shape, not content.
 */
import { SUMMARY_MODEL } from '../gemini/models';
import { createInteraction, type InteractionRequest, type RestOptions } from '../gemini/rest';
import { outputText } from '../gemini/response';
import type { ActionItem, MeetingSummary, NoteSection, SummarizeOptions, SummarySection } from '../types';

const MAX_TITLE = 80;
const SUMMARY_TIMEOUT_MS = 5 * 60_000;

/** Schema property order; the model writes fields in this order, language first. */
export const SUMMARY_SCHEMA_FIELDS = ['language', 'title', 'sections', 'actionItems'] as const;

const RULES = `You write meeting notes. Meetings may mix languages, sometimes within one sentence.

Rules:
- Write every field in the dominant language of the meeting: the language most of the transcript is spoken in. Keep names, product names and technical terms as spoken.
- Use only what the transcript says. Never invent facts, decisions, owners or dates. Leave a section or list empty rather than guess.
- language: the dominant language as a BCP-47 code, e.g. "fr-FR" or "en-US".
- title: short and specific, at most 80 characters, without the date.
- sections: fill each section listed below under its key, following its instruction. A paragraph section is a string; a bullets section is a list of short strings.
- actionItems: concrete follow-ups someone committed to or was asked to do. Set owner only when the transcript makes clear who owns the task, and only to one of the attendee names exactly as listed. Set due only when a deadline is stated, worded as it was said.`;

function cleanNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))];
}

/** The schema key of the section at `index`: s1, s2… */
export function sectionKey(index: number): string {
  return `s${index + 1}`;
}

function sectionInstruction(section: Pick<NoteSection, 'title' | 'instruction'>): string {
  return section.instruction.trim() || `What belongs under “${section.title.trim()}”.`;
}

/** The fixed rules, then the profile's prompt and sections. */
export function systemInstruction(profile: SummarizeOptions['profile']): string {
  const parts = [RULES];
  const prompt = profile.prompt.trim();
  if (prompt) parts.push(`About these meetings:\n${prompt}`);
  if (profile.sections.length > 0) {
    const lines = profile.sections.map(
      (s, i) => `- ${sectionKey(i)} “${s.title.trim()}” (${s.format}): ${sectionInstruction(s)}`,
    );
    parts.push(['Sections:', ...lines].join('\n'));
  }
  return parts.join('\n\n');
}

function schema(attendees: string[], sections: readonly NoteSection[]): Record<string, unknown> {
  const list = { type: 'array', items: { type: 'string' } };
  const properties: Record<string, unknown> = {
    language: { type: 'string', description: 'Dominant language of the meeting, BCP-47.' },
    title: { type: 'string', description: 'Short meeting title, at most 80 characters.' },
  };
  // Gemini rejects an object schema without properties, so a profile without sections has no field for them.
  if (sections.length > 0) {
    properties.sections = {
      type: 'object',
      properties: Object.fromEntries(
        sections.map((s, i) => [
          sectionKey(i),
          s.format === 'bullets'
            ? { ...list, description: sectionInstruction(s) }
            : { type: 'string', description: sectionInstruction(s) },
        ]),
      ),
      required: sections.map((_, i) => sectionKey(i)),
    };
  }
  properties.actionItems = {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        owner: {
          type: 'string',
          description: 'Attendee who owns the task, exactly as listed.',
          ...(attendees.length > 0 ? { enum: attendees } : {}),
        },
        due: { type: 'string', description: 'Deadline as stated, if any.' },
      },
      required: ['task'],
    },
  };
  return { type: 'object', properties, required: Object.keys(properties) };
}

export function summaryRequest(
  transcriptText: string,
  opts: Pick<SummarizeOptions, 'attendees' | 'meetingDate' | 'profile'>,
): InteractionRequest {
  const attendees = cleanNames(opts.attendees);
  const input = [
    `Meeting date: ${opts.meetingDate}`,
    `Attendees: ${attendees.length > 0 ? attendees.join(', ') : 'unknown'}`,
    '',
    'Transcript (one line per speaker turn):',
    '<transcript>',
    transcriptText.trim(),
    '</transcript>',
  ].join('\n');
  return {
    model: SUMMARY_MODEL,
    system_instruction: systemInstruction(opts.profile),
    input,
    response_format: { type: 'text', mime_type: 'application/json', schema: schema(attendees, opts.profile.sections) },
    store: false,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function fail(reason: string): never {
  throw new Error(`Gemini returned an invalid summary: ${reason}`);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} is not a string`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return text(value, field) || undefined;
}

function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) fail(`${field} is not a list`);
  return value.map((v, i) => text(v, `${field}[${i}]`)).filter(Boolean);
}

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attendee spelling of `owner` (full name or unambiguous first name), else nothing. */
function matchOwner(owner: string, attendees: string[], transcript: string): string | undefined {
  const o = fold(owner);
  if (!o) return undefined;
  const exact = attendees.find((a) => fold(a) === o);
  if (exact) return exact;
  const byFirstName = attendees.filter((a) => fold(a).split(' ')[0] === o);
  if (byFirstName.length === 1) return byFirstName[0];
  // Without an attendee list, accept a name the transcript itself contains.
  if (attendees.length === 0 && fold(transcript).includes(o)) return owner.trim();
  return undefined;
}

function capTitle(title: string): string {
  if (title.length <= MAX_TITLE) return title;
  const cut = title.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** One section's value from the model, shaped by its format. Missing means empty. */
function sectionValue(value: unknown, section: Pick<NoteSection, 'title' | 'format'>, field: string): SummarySection {
  const base = { title: section.title.trim(), format: section.format };
  if (value === undefined || value === null) return { ...base, text: '', items: [] };
  if (section.format === 'bullets') {
    const items = typeof value === 'string' ? [value.trim()].filter(Boolean) : textList(value, field);
    return { ...base, text: '', items };
  }
  const paragraph = Array.isArray(value) ? textList(value, field).join('\n\n') : text(value, field);
  return { ...base, text: paragraph, items: [] };
}

/**
 * Parses and checks the model's JSON. Throws on anything that is not a
 * MeetingSummary; trims strings, drops blank entries, caps the title and maps
 * owners onto attendee names (dropping owners it cannot place).
 */
export function parseMeetingSummary(
  raw: string,
  opts: { attendees: readonly string[]; sections: readonly Pick<NoteSection, 'title' | 'format'>[]; transcript?: string },
): MeetingSummary {
  const unfenced = raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  let json: unknown;
  try {
    json = JSON.parse(unfenced);
  } catch {
    fail('not JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('not an object');
  const obj = json as Record<string, unknown>;

  const title = capTitle(text(obj.title, 'title'));
  if (!title) fail('title is empty');
  const attendees = cleanNames(opts.attendees);
  if (!Array.isArray(obj.actionItems)) fail('actionItems is not a list');
  const actionItems: ActionItem[] = [];
  obj.actionItems.forEach((item: unknown, i) => {
    if (typeof item !== 'object' || item === null) fail(`actionItems[${i}] is not an object`);
    const it = item as Record<string, unknown>;
    const task = text(it.task, `actionItems[${i}].task`);
    const ownerRaw = optionalText(it.owner, `actionItems[${i}].owner`);
    const due = optionalText(it.due, `actionItems[${i}].due`);
    if (!task) return;
    const owner = ownerRaw && matchOwner(ownerRaw, attendees, opts.transcript ?? '');
    actionItems.push({ task, ...(owner ? { owner } : {}), ...(due ? { due } : {}) });
  });
  const language = optionalText(obj.language, 'language');

  const rawSections = obj.sections ?? {};
  if (typeof rawSections !== 'object' || Array.isArray(rawSections)) fail('sections is not an object');
  const sections = opts.sections.map((section, i) =>
    sectionValue((rawSections as Record<string, unknown>)[sectionKey(i)], section, `sections.${sectionKey(i)}`),
  );

  return { title, sections, actionItems, ...(language ? { language } : {}) };
}

/** Summarizes a speaker-labelled transcript. Throws when Gemini fails or answers badly. */
export async function summarize(
  apiKey: string,
  transcriptText: string,
  opts: SummarizeOptions,
  rest: RestOptions = {},
): Promise<MeetingSummary> {
  if (!transcriptText.trim()) throw new Error('Nothing to summarize: the transcript is empty');
  const interaction = await createInteraction(apiKey, summaryRequest(transcriptText, opts), {
    ...rest,
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeoutMs: rest.timeoutMs ?? SUMMARY_TIMEOUT_MS,
  });
  return parseMeetingSummary(outputText(interaction), {
    attendees: opts.attendees,
    sections: opts.profile.sections,
    transcript: transcriptText,
  });
}
