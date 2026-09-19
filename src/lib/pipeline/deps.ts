import { createNotionMeetingStore } from '../notion/store';
import { createGeminiMeetingAI } from '../transcribe/ai';
import type { AudioStore, JobStage, MeetingAI, MeetingStore, Settings } from '../types';

export interface PipelineDeps {
  ai: MeetingAI;
  store: MeetingStore;
  audio: AudioStore;
  /** Progress for the UI. Errors it throws or rejects with are ignored. */
  onStage?: (s: JobStage) => void;
}

/** Gemini and Notion from the user's settings, audio from the given store. */
export function createPipelineDeps(
  settings: Settings,
  audio: AudioStore,
  onStage?: (s: JobStage) => void,
): PipelineDeps {
  return {
    ai: createGeminiMeetingAI(settings.geminiApiKey),
    store: createNotionMeetingStore(settings.notionToken),
    audio,
    ...(onStage ? { onStage } : {}),
  };
}

/** Progress is informational: a failing listener must never stop a job. */
export function stageReporter(onStage: PipelineDeps['onStage']): (s: JobStage) => void {
  return (stage) => {
    try {
      const returned: unknown = onStage?.(stage);
      if (returned instanceof Promise) returned.catch(() => undefined);
    } catch {
      // Ignored, see above.
    }
  };
}
