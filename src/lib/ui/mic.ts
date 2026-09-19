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

export function micFailure(err: unknown): Extract<MicRequestResult, { ok: false }> {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  const detail = err instanceof Error && err.message ? err.message : String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { ok: false, reason: 'denied', message: 'Microphone access was blocked.' };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { ok: false, reason: 'no-device', message: 'No microphone was found. Plug one in and try again.' };
    case 'NotReadableError':
      return {
        ok: false,
        reason: 'error',
        message: 'The microphone could not be opened. Another app may be using it.',
      };
    default:
      return { ok: false, reason: 'error', message: `The microphone could not be opened: ${detail}` };
  }
}
