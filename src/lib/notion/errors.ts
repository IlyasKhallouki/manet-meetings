import { NotionError } from './client';

/** One user-facing sentence for a failed Notion call. */
export function explainError(err: unknown): string {
  if (!(err instanceof NotionError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'missing_token':
      return 'Enter your Notion integration token in the options.';
    case 'unauthorized':
      return 'Notion says the token is invalid. Copy the integration secret again into the options.';
    case 'invalid_database_id':
    case 'no_data_source':
    case 'schema_mismatch':
      return err.message;
    case 'object_not_found':
      return `Notion could not find the database or page. Open the database in Notion, then ••• → Connections → add your integration. (${err.message})`;
    case 'restricted_resource':
      return `Notion refused the request: ${err.message}`;
    case 'rate_limited':
    case 'service_overload':
      return 'Notion is rate limiting requests. Try again in a minute.';
    case 'network_error':
    case 'timeout':
      return err.message;
    default:
      return `Notion error ${err.status} (${err.code}): ${err.message}`;
  }
}
