import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import { micFailure, queryMicPermission, requestMicAccess, watchMicPermission, type MicPermission } from '@lib/ui/mic';

// Real Chrome. The mic permission is set through the DevTools protocol, which is what
// the user's answer in Chrome's prompt or in site settings does.

type Setting = 'granted' | 'denied' | 'prompt';

// Playwright runs each session in its own browser context; a permission set without its
// id would land in the default context and change nothing here.
const { browserContextId } = (await cdp().send('Target.getTargetInfo')).targetInfo;
if (!browserContextId) throw new Error('No browser context id for this page.');

/** Without an audio input device, a granted mic still cannot open. */
const hasAudioInput = (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === 'audioinput');

async function setMic(setting: Setting): Promise<void> {
  await cdp().send('Browser.setPermission', {
    permission: { name: 'microphone' },
    setting,
    origin: location.origin,
    browserContextId,
  });
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

let before: PermissionState;
beforeEach(async () => {
  before = (await navigator.permissions.query({ name: 'microphone' })).state;
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Later files in this browser context expect Chrome's own state.
  await setMic(before);
});

describe('microphone permission in real Chrome', () => {
  it('reports the permission Chrome holds', async () => {
    for (const setting of ['granted', 'denied', 'prompt'] as const) {
      await setMic(setting);
      expect(await queryMicPermission(), setting).toBe(setting);
    }
  });

  it('explains a blocked microphone', async () => {
    await setMic('denied');
    const result = await requestMicAccess();
    expect(result).toEqual({ ok: false, reason: 'denied', message: 'Chrome blocked the microphone for Manet Meetings.' });
  });

  it.skipIf(!hasAudioInput)('opens a granted mic and releases it at once', async () => {
    await setMic('granted');
    const gum = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    expect(await requestMicAccess()).toEqual({ ok: true });
    expect(gum).toHaveBeenCalledTimes(1);
    const stream = await (gum.mock.results[0]!.value as Promise<MediaStream>);
    expect(stream.getAudioTracks().length).toBeGreaterThan(0);
    // Only the grant is needed now: a live track would keep Chrome's mic indicator on.
    for (const track of stream.getTracks()) expect(track.readyState).toBe('ended');
  });

  it('calls back on every change until unsubscribed', async () => {
    await setMic('prompt');
    const seen: MicPermission[] = [];
    const stop = await watchMicPermission((state) => seen.push(state));

    await setMic('granted');
    await until(() => seen.length === 1);
    await setMic('denied');
    await until(() => seen.length === 2);
    expect(seen).toEqual(['granted', 'denied']);

    stop();
    const control: MicPermission[] = [];
    const stopControl = await watchMicPermission((state) => control.push(state));
    await setMic('granted');
    // The control watcher got the change, so ours would have too.
    await until(() => control.length === 1);
    await new Promise((r) => setTimeout(r, 50));
    stopControl();
    expect(seen).toEqual(['granted', 'denied']);
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
  });

  it('names the permission page’s button (Continue) as the next step for a missing mic', () => {
    expect(micFailure(new DOMException('Requested device not found', 'NotFoundError'))).toEqual({
      ok: false,
      reason: 'no-device',
      message: 'No microphone was found. Plug one in, then choose Continue.',
    });
  });

  it('says what went wrong in a sentence the page can follow with its own next step', () => {
    // permissionView adds “Choose Continue to try again.”: these end without a next step of their own.
    expect(micFailure(new DOMException('Permission denied', 'NotAllowedError')).message).toBe(
      'Chrome blocked the microphone for Manet Meetings.',
    );
    expect(micFailure(new DOMException('Could not start audio source', 'NotReadableError')).message).toBe(
      'Chrome couldn’t open the microphone. Another app may be using it.',
    );
  });

  it('keeps an unexpected error’s own words in the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const boom = new Error('boom');
      expect(micFailure(boom)).toEqual({ ok: false, reason: 'error', message: 'Chrome couldn’t open the microphone.' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/microphone/i), boom);
    } finally {
      warn.mockRestore();
    }
  });
});
