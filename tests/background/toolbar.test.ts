/**
 * The toolbar button through a whole meeting: icon, badge and tooltip follow the
 * sessions in storage, however they change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSession, putSession } from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';
import { idempotencyKey, sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { clockTime, configure, MEET_CODE, seg, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const STARTED = T0 + 150;
const MINUTE = 60_000;
const AMBER = { background: [249, 171, 0, 255], color: '#1F1F1F' };

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  await configure();
  m = h.createManager();
  await m.boot();
});

async function record(): Promise<number> {
  const tabId = await h.openMeetTab();
  expect(await m.start(tabId)).toEqual({ ok: true, sessionId: ID });
  return tabId;
}

/** A chunk lands `ms` after the recording started (the clock moves there). */
async function chunkAt(ms: number, index: number): Promise<void> {
  h.clock.set(STARTED + ms);
  await m.onRecorderChunk({ sessionId: ID, index, bytes: (index + 1) * 4000 });
  await m.idle();
}

function stored(id: string, patch: Partial<SessionMeta>): SessionMeta {
  return {
    id,
    meetCode: MEET_CODE,
    startedAt: T0 - 60 * MINUTE,
    status: 'saved',
    idempotencyKey: idempotencyKey(MEET_CODE, T0),
    audio: { mimeType: 'audio/webm', chunkCount: 1, bytes: 10, micIncluded: true },
    captionCount: 1,
    ...patch,
  };
}

describe('toolbar button while idle', () => {
  it('shows the idle icon and how to record, with the real shortcut', async () => {
    expect(h.icon()).toBe('idle');
    expect(await h.badge()).toBe('');
    expect(await h.badgeTitle()).toBe('Manet Meetings: record this call (Alt+Shift+R)');
  });

  it('leaves the shortcut out when none is set', async () => {
    h.shortcut.value = '';
    const next = h.createManager();
    await next.boot();
    expect(await h.badgeTitle()).toBe('Manet Meetings: record this call');
  });

  it('counts meetings that need you in amber, and clears the count when they are resolved', async () => {
    await putSession(stored('aaa-bbbb-ccc_20260919T060000Z', { status: 'failed', error: 'Transcribing didn’t start. Try again.' }));
    await putSession(stored('aaa-bbbb-ccc_20260919T070000Z', { status: 'failed', error: 'Notion returned 502' }));
    // A scheduled retry is not waiting on you yet; neither is a saved meeting.
    await putSession(stored('aaa-bbbb-ccc_20260919T080000Z', { status: 'failed', retryAt: T0 + MINUTE }));
    await putSession(stored('aaa-bbbb-ccc_20260919T050000Z', { status: 'saved' }));
    await m.idle();
    expect(await h.badge()).toBe('2');
    expect(await h.badgeColors()).toEqual(AMBER);
    expect(await h.badgeTitle()).toBe('Manet Meetings: record this call (Alt+Shift+R) · 2 meetings need you');

    await m.transcribe('aaa-bbbb-ccc_20260919T060000Z');
    await m.idle();
    // Transcribed and saved, so only the other failure is left.
    expect(await h.badge()).toBe('1');
    expect(await h.badgeTitle()).toMatch(/· 1 meeting needs you$/);

    await m.remove('aaa-bbbb-ccc_20260919T070000Z');
    await m.idle();
    expect(await h.badge()).toBe('');
  });

  it('does not touch Chrome again when nothing it shows has changed', async () => {
    const setTitle = vi.spyOn(fakeBrowser.action, 'setTitle');
    await putSession(stored('aaa-bbbb-ccc_20260919T050000Z', { status: 'saved' }));
    await m.refreshAction();
    await m.idle();
    expect(setTitle).not.toHaveBeenCalled();
  });

  it('keeps the badge and tooltip when the icon files cannot be loaded', async () => {
    h.setIcon.mockRejectedValue(new Error('Failed to fetch'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putSession(stored('aaa-bbbb-ccc_20260919T060000Z', { status: 'processed' }));
    await m.idle();
    expect(await h.badge()).toBe('1');

    // Still recorded, and the next change tries the icon again.
    const tabId = await h.openMeetTab();
    expect(await m.start(tabId)).toMatchObject({ ok: true });
    expect(await h.badgeTitle()).toMatch(/^Recording since /);
    expect(h.setIcon.mock.calls.at(-1)?.[0]).toMatchObject({ path: { 16: '/icon/rec-16.png', 32: '/icon/rec-32.png' } });
  });
});

describe('toolbar button while recording', () => {
  it('shows the red-dot icon and the start time, over any count of meetings that need you', async () => {
    await putSession(stored('aaa-bbbb-ccc_20260919T060000Z', { status: 'processed' }));
    await record();
    expect(h.icon()).toBe('recording');
    expect(h.setIcon).toHaveBeenLastCalledWith({ path: { 16: '/icon/rec-16.png', 32: '/icon/rec-32.png' } });
    expect(await h.badge()).toBe('');
    expect(await h.badgeTitle()).toBe(`Recording since ${clockTime(STARTED)}`);

    await m.stop(ID);
    await m.idle();
    expect(h.setIcon).toHaveBeenLastCalledWith({ path: { 16: '/icon/16.png', 32: '/icon/32.png' } });
    // The meeting that just ended was transcribed and saved: the other one still needs you.
    expect(await h.badge()).toBe('1');
  });

  it('adds "!" when nobody is named 20 s in, and drops it when captions arrive', async () => {
    await record();
    await chunkAt(5000, 0);
    await chunkAt(15_000, 1);
    expect(await h.badge()).toBe('');
    await chunkAt(20_000, 2);
    expect(await h.badge()).toBe('!');
    expect(await h.badgeColors()).toEqual(AMBER);
    expect(await h.badgeTitle()).toBe('Recording — no captions yet');

    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Marie Curie', 21_000, 'Bonjour')] });
    await m.idle();
    expect(await h.badge()).toBe('');
    expect(await h.badgeTitle()).toBe(`Recording since ${clockTime(STARTED)}`);
  });

  it('adds "!" when captions go quiet for more than 5 min while audio flows', async () => {
    await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Marie Curie', 1000, 'Bonjour')] }); // tEnd 3000
    for (let i = 0; i < 12; i++) await chunkAt((i + 1) * 5000, i);
    expect(await h.badge()).toBe('');

    await chunkAt(3000 + 5 * MINUTE + 5000, 12);
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toBe(`Recording — no captions since ${clockTime(STARTED + 3000)}`);

    await m.onCaptions({ sessionId: ID, segments: [seg('c2', 'Tom Martin', 5 * MINUTE + 7000, 'Pardon, micro coupé')] });
    await m.idle();
    expect(await h.badge()).toBe('');
  });

  it('adds "!" when audio stops arriving though the recorder still answers, found by the watchdog alarm', async () => {
    await record();
    await m.onCaptions({ sessionId: ID, segments: [seg('c1', 'Marie Curie', 1000, 'Bonjour')] });
    await chunkAt(5000, 0);
    h.clock.set(STARTED + 25_000);
    await m.onAlarm('recorder-watchdog');
    expect((await getSession(ID))?.audio.error).toBeUndefined();
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toBe(`Recording — no call audio since ${clockTime(STARTED + 5000)}`);

    await chunkAt(26_000, 1);
    expect(await h.badge()).toBe('');
  });

  it('keeps "!" for a captions-only recording, and names it in the tooltip', async () => {
    const tabId = await record();
    await m.onRecorderStopped({ sessionId: ID, reason: 'error', error: 'QuotaExceededError', chunkCount: 1, bytes: 10 });
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toBe('Recording captions only — no call audio');

    await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
    await m.idle();
    expect(h.icon()).toBe('idle');
    // Transcribed and saved when the call ended: nothing is left to flag.
    expect(await h.badge()).toBe('');
  });

  it('flags a tab that cannot deliver captions at once', async () => {
    const tabId = await h.openMeetTab(undefined, { contentScript: false });
    h.executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    await m.start(tabId);
    await m.idle();
    expect(await h.badge()).toBe('!');
    expect(await h.badgeTitle()).toBe('Recording — no captions yet');
  });

  it('never puts the meeting title in the tooltip', async () => {
    const tabId = await h.openMeetTab();
    await m.onMeetJoined(tabId, { meetCode: MEET_CODE, title: 'Pricing call with Acme' });
    await m.start(tabId);
    h.clock.set(STARTED + 30_000);
    await m.onAlarm('recorder-watchdog');
    expect(await h.badgeTitle()).not.toMatch(/Acme|abc-defg-hij/);
  });
});
