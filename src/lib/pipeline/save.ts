import { saveMeeting } from '../notion/save';
import type { SaveJob, SaveOutcome } from '../types';
import { stageReporter, type PipelineDeps } from './deps';
import { shortError } from './notes';
import { databaseIdFor } from '../settingsSchema';
import { buildMeetingPageInput } from './session';

/**
 * Files a processed session into the route's Notion database, once per meeting key
 * (see notion/save.ts for how races between teammates settle). Never throws.
 */
export async function saveSession(job: SaveJob, deps: PipelineDeps): Promise<SaveOutcome> {
  stageReporter(deps.onStage)('saving');
  try {
    return await saveMeeting(deps.store, databaseIdFor(job.settings, job.route), buildMeetingPageInput(job));
  } catch (err) {
    return { status: 'error', error: `Saving to Notion failed: ${shortError(err)}` };
  }
}
