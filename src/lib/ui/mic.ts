/**
 * Microphone permission of the extension origin. The offscreen document only mixes in
 * the mic when this is already 'granted': it cannot show a prompt, so the grant happens
 * once, on the visible permission page.
 */

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export type MicRequestResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'no-device' | 'error'; message: string };

async function micStatus(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions.query({ name: 'microphone' });
  } catch {
    return null;
  }
}

function asPermission(state: string | undefined): MicPermission {
  return state === 'granted' || state === 'denied' || state === 'prompt' ? state : 'unknown';
}

export async function queryMicPermission(): Promise<MicPermission> {
  return asPermission((await micStatus())?.state);
}

/** Calls `onChange` whenever the permission changes (e.g. granted in another tab). Returns an unsubscribe. */
export async function watchMicPermission(onChange: (state: MicPermission) => void): Promise<() => void> {
  const status = await micStatus();
  if (!status) return () => undefined;
  const listener = () => onChange(asPermission(status.state));
  status.addEventListener('change', listener);
  return () => status.removeEventListener('change', listener);
}

/**
 * Asks for the mic (Chrome shows its prompt on a visible page, after a click) and
 * releases it straight away: only the grant is needed now.
 */
export async function requestMicAccess(): Promise<MicRequestResult> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return micFailure(err);
  }
  for (const track of stream.getTracks()) track.stop();
  return { ok: true };
}

/**
 * What went wrong, for the permission page. A missing mic names the page's button
 * (Continue: without a device Chrome never gets as far as blocking it); the other
 * messages say only what happened, because the page adds the next step with the label
 * of the button on screen. An unexpected error's own words go to the console.
 */
export function micFailure(err: unknown): Extract<MicRequestResult, { ok: false }> {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { ok: false, reason: 'denied', message: 'Chrome blocked the microphone for Manet Meetings.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { ok: false, reason: 'no-device', message: 'No microphone was found. Plug one in, then choose Continue.' };
    case 'NotReadableError':
      return { ok: false, reason: 'error', message: 'Chrome couldn’t open the microphone. Another app may be using it.' };
    default:
      console.warn('[manet] The microphone could not be opened:', err);
      return { ok: false, reason: 'error', message: 'Chrome couldn’t open the microphone.' };
  }
}
