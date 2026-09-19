/** Meet URLs look like https://meet.google.com/abc-defg-hij (optionally with ?query). */
const MEET_CODE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/;

export function meetCodeFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== 'meet.google.com') return null;
    return MEET_CODE.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
