import { describe, expect, it } from 'vitest';
import { senderAllowed } from '@lib/messages';

const EXT = 'chrome-extension://abcdefghijklmnop/';
const meetTab = { tab: { id: 7 } as never, url: 'https://meet.google.com/abc-defg-hij' };

describe('senderAllowed', () => {
  it('accepts content-script messages only from a Meet tab', () => {
    expect(senderAllowed('captions/batch', meetTab, EXT)).toBe(true);
    expect(senderAllowed('meet/joined', { tab: { id: 7 } as never }, EXT)).toBe(true);
    expect(senderAllowed('meet/left', { url: 'https://meet.google.com/x' }, EXT)).toBe(false);
    expect(senderAllowed('captions/batch', { tab: { id: 7 } as never, url: 'https://evil.example/' }, EXT)).toBe(false);
  });

  it('keeps privileged messages away from content scripts', () => {
    for (const type of ['session/delete', 'session/start', 'offscreen/process', 'offscreen/recorder-stopped']) {
      expect(senderAllowed(type, meetTab, EXT)).toBe(false);
    }
  });

  it('accepts privileged messages from extension pages, the worker and the offscreen document', () => {
    expect(senderAllowed('session/delete', { tab: { id: 3 } as never, url: `${EXT}dashboard.html` }, EXT)).toBe(true);
    expect(senderAllowed('offscreen/process', { url: `${EXT}background.js` }, EXT)).toBe(true);
    expect(senderAllowed('offscreen/job-done', { url: `${EXT}offscreen.html` }, EXT)).toBe(true);
    expect(senderAllowed('session/start', {}, EXT)).toBe(true);
  });
});
