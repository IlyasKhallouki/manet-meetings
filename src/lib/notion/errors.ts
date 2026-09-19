/**
 * Notion failures in people's words, for Meetings, notifications and the notes on a
 * page: one or two short sentences, the fix named, fix first (HIG writing.md › Best
 * practices: "Write clear error messages… be clear about what someone can do to fix it").
 * Notion's own message and request id go to the console only.
 *
 * Every sentence names Notion: that is how Meetings and the popup tell a failed save
 * from a failed transcription (background copy.ts names Notion only for a save).
 */
import { NotionError } from './client';
import { MEETING_PROPS } from './schema';

/** A save stopped by something that isn't Notion's doing (a bug): its words go to the console. */
export const SAVE_STOPPED = 'Saving to Notion stopped before it finished. Try again.';

/** Settings left empty: nothing went wrong in Notion, so there is nothing to log. */
const QUIET = new Set(['missing_token', 'invalid_database_id']);

function log(err: unknown): void {
  if (err instanceof NotionError) {
    if (QUIET.has(err.code)) return;
    const id = err.requestId ? ` (request ${err.requestId})` : '';
    console.warn(`[manet] Notion ${err.status} ${err.code}: ${err.message}${id}`);
  } else {
    console.warn('[manet] Unexpected error around a Notion request:', err);
  }
}

function explainNotion(err: NotionError): string {
  switch (err.code) {
    case 'missing_token':
      return 'Add a Notion token in Settings, then try again.';
    case 'unauthorized':
      return 'Notion rejected the token. Copy it again in Settings.';
    case 'object_not_found':
      return 'The Notion database isn’t shared with your token. In Notion, open it and choose ••• › Connections.';
    case 'restricted_resource':
      return 'Notion didn’t let your token edit the database. In Notion, give it edit access, then try again.';
    case 'rate_limited':
    case 'service_overload':
      return 'Notion is busy right now. Try again in a minute.';
    case 'network_error':
      return 'Notion can’t be reached. Check your internet connection, then try again.';
    case 'timeout':
      return 'Notion didn’t answer in time. Try again in a few minutes.';
    case 'invalid_database_id':
      return 'Paste the Notion database link or ID in Settings, then try again.';
    case 'no_data_source':
      return 'The Notion database has no table for meetings. Paste the link of the meetings database in Settings.';
    case 'schema_mismatch':
      return `The Notion database needs a Text property named “${MEETING_PROPS.key}”. Add it in Notion, then try again.`;
    case 'conflict_error':
      return 'Notion was busy with another change. Try again.';
  }
  if (err.status >= 500) return `Notion is having trouble right now (${err.status}). Try again in a few minutes.`;
  return `Notion didn’t accept the page (${err.status}). Try again.`;
}

/**
 * What a failed Notion call means for the person, and what to do. `unexpected` is said
 * for an error that isn't Notion's (a bug); it defaults to the save's words, the one
 * caller that doesn't choose.
 */
export function explainError(err: unknown, unexpected: string = SAVE_STOPPED): string {
  log(err);
  return err instanceof NotionError ? explainNotion(err) : unexpected;
}
