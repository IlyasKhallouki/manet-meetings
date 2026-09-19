import { saveMeeting } from '../notion/save';
import type { SaveJob, SaveOutcome } from '../types';
import { stageReporter, type PipelineDeps } from './deps';
import { STOPPED } from './notes';
import { databaseIdFor } from '../settingsSchema';
import { buildMeetingPageInput } from './session';

/**
 * Files a processed session into the route's Notion database, once per meeting key
 * (see notion/save.ts for how races between teammates settle), or regardless of the
 * key when the user chose "Save a second copy" (`force`). Never throws: Notion's
 * refusals come back in people's words (notion/errors.ts), anything else as STOPPED.save
 * with the error itself in the console.
 */
export async function saveSession(job: SaveJob, deps: PipelineDeps): Promise<SaveOutcome> {
  stageReporter(deps.onStage)('saving');
  try {
    const databaseId = databaseIdFor(job.settings, job.route);
    return await saveMeeting(deps.store, databaseId, buildMeetingPageInput(job), job.force ? { force: true } : {});
  } catch (err) {
    console.warn('[manet] Saving to Notion stopped:', err);
    return { status: 'error', error: STOPPED.save };
  }
}
