import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '@lib/types';
import { micView, popupState } from '@lib/ui/popupView';

const CALL = 'https://meet.google.com/abc-defg-hij?authuser=0';
const STARTED = Date.UTC(2026, 8, 19, 8, 15, 0);

function session(patch: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'abc-defg-hij_20260919T081500Z',
    meetCode: 'abc-defg-hij',
    startedAt: STARTED,
    status: 'recording',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 1, bytes: 100, micIncluded: true },
    captionCount: 0,
    ...patch,
  };
}

const active = { sessionId: 'abc-defg-hij_20260919T081500Z', tabId: 7, meetCode: 'abc-defg-hij' };

describe('popupState', () => {
  it('asks for a Meet call when the tab is something else', () => {
    expect(popupState({ tab: { id: 3, url: 'https://example.com/' }, active: null, session: null })).toEqual({
      kind: 'not-meet',
      onMeet: false,
    });
    expect(popupState({ tab: null, active: null, session: null })).toEqual({ kind: 'not-meet', onMeet: false });
  });

  it('asks to join a call on the Meet home page', () => {
    expect(popupState({ tab: { id: 3, url: 'https://meet.google.com/' }, active: null, session: null })).toEqual({
      kind: 'not-meet',
      onMeet: true,
    });
  });

  it('offers Record on a call tab', () => {
    expect(popupState({ tab: { id: 7, url: CALL }, active: null, session: null })).toEqual({
      kind: 'idle',
      tabId: 7,
      meetCode: 'abc-defg-hij',
    });
  });

  it('cannot record a tab without an id', () => {
    expect(popupState({ tab: { url: CALL }, active: null, session: null }).kind).toBe('not-meet');
  });

  it('shows the recording of this tab', () => {
    const s = session({ meetingTitle: 'Weekly sync' });
    expect(popupState({ tab: { id: 7, url: CALL }, active, session: s })).toEqual({
      kind: 'recording',
      sessionId: s.id,
      startedAt: STARTED,
      meetCode: 'abc-defg-hij',
      title: 'Weekly sync',
      thisTab: true,
    });
  });

  it('shows a recording running in another tab, whatever this tab is', () => {
    const state = popupState({ tab: { id: 9, url: 'https://example.com/' }, active, session: session() });
    expect(state).toMatchObject({ kind: 'recording', thisTab: false });
  });

  it('reports why audio is missing from a captions-only recording', () => {
    const s = session({ audio: { ...session().audio, error: 'Tab capture failed: no permission' } });
    expect(popupState({ tab: { id: 7, url: CALL }, active, session: s })).toMatchObject({
      kind: 'recording',
      audioError: 'Tab capture failed: no permission',
    });
  });

  it('ignores a stale pointer whose session is gone or finished', () => {
    const tab = { id: 7, url: CALL };
    expect(popupState({ tab, active, session: null }).kind).toBe('idle');
    expect(popupState({ tab, active, session: session({ status: 'awaiting-route' }) }).kind).toBe('idle');
  });
});

describe('micView', () => {
  it('says the mic is on when granted', () => {
    expect(micView('granted', true)).toMatchObject({ tone: 'ok', canRequest: false });
  });

  it('offers to grant it when not yet allowed or blocked', () => {
    for (const state of ['prompt', 'denied', 'unknown'] as const) {
      const v = micView(state, true);
      expect(v.canRequest, state).toBe(true);
      expect(v.tone, state).toBe('warn');
      expect(v.text).toMatch(/other participants/);
    }
    expect(micView('denied', true).text).toMatch(/blocked/i);
  });

  it('stays quiet when the mic is turned off in settings', () => {
    expect(micView('prompt', false)).toMatchObject({ tone: 'muted', canRequest: false });
    expect(micView('granted', false).text).toMatch(/off in settings/i);
  });
});
