/**
 * Every Gemini endpoint and model id lives here. Checked against the Gemini API docs
 * (transcribe, interactions, files) as of September 2026.
 */
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_API_VERSION = 'v1beta';

/*
 * No Api-Revision header: the steps-based Interactions schema is the only one since
 * June 8, 2026 (the header is ignored), and the API's CORS preflight rejects it.
 */

/** Speech-to-text: word timestamps, custom vocabulary, language auto-detection. */
export const TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';

/** Meeting summary with structured JSON output. */
export const SUMMARY_MODEL = 'gemini-3.5-flash';
