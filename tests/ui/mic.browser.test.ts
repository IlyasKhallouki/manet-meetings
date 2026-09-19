import { describe, expect, it } from 'vitest';
import { micFailure, queryMicPermission, requestMicAccess, watchMicPermission } from '@lib/ui/mic';

// Real Chrome: whatever it answers for this origin is what the pages will see. Headless
// Chrome under Playwright has no mic grant, so the request is expected to fail cleanly.
describe('microphone permission in real Chrome', () => {
  it('reports the same state as the Permissions API', async () => {
    const raw = await navigator.permissions.query({ name: 'microphone' });
    expect(await queryMicPermission()).toBe(raw.state);
  });

  it('requests the mic without throwing, and explains a failure', async () => {
    const result = await requestMicAccess();
    if (result.ok) {
      expect(await queryMicPermission()).toBe('granted');
    } else {
      expect(['denied', 'no-device', 'error']).toContain(result.reason);
      expect(result.message.length).toBeGreaterThan(10);
    }
  });

  it('watches for changes and can unsubscribe', async () => {
    const stop = await watchMicPermission(() => undefined);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('micFailure', () => {
  it('maps getUserMedia errors to what the user can do about them', () => {
    expect(micFailure(new DOMException('Permission denied', 'NotAllowedError')).reason).toBe('denied');
    expect(micFailure(new DOMException('Permission dismissed', 'NotAllowedError')).reason).toBe('denied');
    expect(micFailure(new DOMException('Requested device not found', 'NotFoundError')).reason).toBe('no-device');
    const busy = micFailure(new DOMException('Could not start audio source', 'NotReadableError'));
    expect(busy.reason).toBe('error');
    expect(busy.message).toMatch(/another app/i);
    const odd = micFailure(new Error('boom'));
    expect(odd).toEqual({ ok: false, reason: 'error', message: 'The microphone could not be opened: boom' });
  });
});
