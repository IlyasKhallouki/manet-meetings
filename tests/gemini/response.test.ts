import { describe, expect, it } from 'vitest';
import { outputText, parseOffsetMs, timedWords, wordAnnotations, type Interaction } from '@lib/gemini/response';

// The documented REST response of a transcription with word timestamps + diarization
// (ai.google.dev/gemini-api/docs/transcribe, "Parsing transcription output").
const documented: Interaction = {
  id: 'interactions/abc123xyz',
  status: 'completed',
  steps: [
    {
      id: 'step_001',
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: 'Hello world',
          annotations: [
            { type: 'word_info', text: 'Hello', speaker: 'spk_1', start_offset: '0.100s', end_offset: '0.450s' },
            { type: 'word_info', text: 'world', speaker: 'spk_1', start_offset: '0.500s', end_offset: '0.850s' },
          ],
        },
      ],
    },
  ],
};

describe('parseOffsetMs', () => {
  it('converts google-duration strings to integer milliseconds', () => {
    expect(parseOffsetMs('0.100s')).toBe(100);
    expect(parseOffsetMs('1.5s')).toBe(1500);
    expect(parseOffsetMs('12s')).toBe(12000);
    expect(parseOffsetMs('3723.456789s')).toBe(3723457);
    expect(parseOffsetMs('0s')).toBe(0);
  });

  it('rejects missing or malformed offsets', () => {
    expect(parseOffsetMs(undefined)).toBeUndefined();
    expect(parseOffsetMs('')).toBeUndefined();
    expect(parseOffsetMs('abc')).toBeUndefined();
    expect(parseOffsetMs('1.5')).toBeUndefined();
    expect(parseOffsetMs('-1s')).toBeUndefined();
  });
});

describe('outputText', () => {
  it('reads the text of model_output steps', () => {
    expect(outputText(documented)).toBe('Hello world');
  });

  it('skips thought and user_input steps and joins several text blocks', () => {
    const interaction: Interaction = {
      status: 'completed',
      steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'prompt' }] },
        { type: 'thought', summary: [{ type: 'text', text: 'thinking' }] },
        {
          type: 'model_output',
          content: [
            { type: 'text', text: '{"a":' },
            { type: 'text', text: '1}' },
          ],
        },
      ],
    };
    expect(outputText(interaction)).toBe('{"a":1}');
  });

  it('returns an empty string when there is no output', () => {
    expect(outputText({ status: 'completed' })).toBe('');
    expect(outputText({ status: 'completed', steps: [] })).toBe('');
  });
});

describe('word annotations', () => {
  it('collects word_info annotations in order', () => {
    expect(wordAnnotations(documented).map((w) => w.text)).toEqual(['Hello', 'world']);
  });

  it('turns them into timed words in milliseconds', () => {
    expect(timedWords(documented)).toEqual([
      { text: 'Hello', start: 100, end: 450 },
      { text: 'world', start: 500, end: 850 },
    ]);
  });

  it('ignores citations, untimed words and blank words', () => {
    const interaction: Interaction = {
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [
            {
              type: 'text',
              text: 'a b c',
              annotations: [
                { type: 'url_citation', url: 'https://example.com' },
                { type: 'word_info', text: 'a', start_offset: '1s', end_offset: '1.2s' },
                { type: 'word_info', text: 'b' },
                { type: 'word_info', text: ' ', start_offset: '1.3s', end_offset: '1.4s' },
                { type: 'word_info', text: 'c', start_offset: '2s', end_offset: '1.9s' },
              ],
            },
          ],
        },
      ],
    };
    expect(timedWords(interaction)).toEqual([
      { text: 'a', start: 1000, end: 1200 },
      // End before start is clamped rather than dropped.
      { text: 'c', start: 2000, end: 2000 },
    ]);
  });
});
