/**
 * Pausing the routing prompt (WCAG 2.2.1, HIG accessibility.md › Cognitive: "Minimize use
 * of time-boxed interface elements"): the default route waits while the person decides,
 * and comes back when they resume or close the paused prompt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSession, watchSessions } from '@lib/storage/sessionStore';
import type { SessionMeta } from '@lib/types';
import { sessionId } from '@lib/util/ids';
import type { SessionManager } from '@/entrypoints/background/sessionManager';
import { configure, MEET_CODE, setupHarness, T0, type Harness } from './harness';

const ID = sessionId(MEET_CODE, T0);
const ROUTE_DELAY = 2 * 60 * 1000;
const MINUTE = 60_000;

let h: Harness;
let m: SessionManager;

beforeEach(async () => {
  h = setupHarness();
  await configure({ autoTranscribe: false });
  m = h.createManager();
  await m.boot();
});

/** Records and ends a meeting; returns the routing prompt's window id. */
async function endMeeting(): Promise<number> {
  const tabId = await h.openMeetTab();
  await m.start(tabId);
  await m.onMeetLeft(tabId, { meetCode: MEET_CODE });
  expect((await getSession(ID))?.status).toBe('awaiting-route');
  const win = await h.windowsCreate.mock.results.at(-1)?.value;
  expect(win?.id).toBeTypeOf('number');
  return win.id as number;
}

const routeAlarm = () => fakeBrowser.alarms.get(`route:${ID}`);

const deadline = async () => (await getSession(ID))?.routeDeadline;

describe('pausing the default route', () => {
  it('clears the alarm while paused, and re-arms the full 2 minutes on resume', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    expect(await routeAlarm()).toBeUndefined();

    h.clock.advance(10 * MINUTE);
    await m.routeHold(ID, false);
    expect((await routeAlarm())?.scheduledTime).toBe(h.clock.now() + ROUTE_DELAY);
  });

  it('re-arms the default when the paused prompt is closed', async () => {
    const windowId = await endMeeting();
    await m.routeHold(ID, true);
    h.clock.advance(5 * MINUTE);
    await m.onWindowRemoved(windowId);
    expect((await routeAlarm())?.scheduledTime).toBe(h.clock.now() + ROUTE_DELAY);

    await m.onAlarm(`route:${ID}`);
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'team' });
  });

  it('leaves the countdown alone when a prompt that was not paused is closed', async () => {
    const windowId = await endMeeting();
    const armed = (await routeAlarm())?.scheduledTime;
    h.clock.advance(MINUTE);
    await m.onWindowRemoved(windowId);
    expect((await routeAlarm())?.scheduledTime).toBe(armed);
  });

  it('ignores other windows closing', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await m.onWindowRemoved(424242);
    expect(await routeAlarm()).toBeUndefined();
  });

  it('does not apply the default from an alarm that fired just as the prompt was paused', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await m.onAlarm(`route:${ID}`);
    expect((await getSession(ID))?.status).toBe('awaiting-route');
  });

  it('keeps the pause across a worker restart, instead of treating the missing alarm as fired', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await fakeBrowser.storage.session.set({ bootScanned: true });
    h.clock.advance(10 * MINUTE);

    const next = h.createManager();
    await next.boot();
    await next.idle();
    expect((await getSession(ID))?.status).toBe('awaiting-route');
    expect(await routeAlarm()).toBeUndefined();
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);
  });

  it('forgets the pause with the browser: the next start asks again with a new countdown', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await fakeBrowser.storage.session.clear(); // a browser restart empties storage.session
    h.clock.advance(60 * MINUTE);

    const next = h.createManager();
    await next.boot();
    expect((await routeAlarm())?.scheduledTime).toBe(h.clock.now() + ROUTE_DELAY);
    expect(h.windowsCreate).toHaveBeenCalledTimes(2);
  });

  it('clears everything once a destination is chosen', async () => {
    const windowId = await endMeeting();
    await m.routeHold(ID, true);
    await m.route(ID, 'personal');
    await m.onWindowRemoved(windowId);
    expect(await routeAlarm()).toBeUndefined();
    expect(await fakeBrowser.storage.session.get(`routing:${ID}`)).toEqual({});
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'personal' });
  });

  it('does nothing for a meeting that no longer waits for a destination', async () => {
    await endMeeting();
    await m.route(ID, 'team');
    await m.routeHold(ID, true);
    await m.routeHold(ID, false);
    expect(await routeAlarm()).toBeUndefined();
    await m.routeHold('nope', true);
  });

  it('forgets the prompt of a deleted meeting', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await m.remove(ID);
    expect(await fakeBrowser.storage.session.get(`routing:${ID}`)).toEqual({});
  });

  it('learns the window from the pause message when it did not open the prompt itself', async () => {
    h.windowsCreate.mockResolvedValueOnce(undefined as never);
    await endMeeting().catch(() => undefined);
    await m.routeHold(ID, true, 77);
    await m.onWindowRemoved(77);
    expect((await routeAlarm())?.scheduledTime).toBe(h.clock.now() + ROUTE_DELAY);
  });
});

describe('the default’s deadline on the meeting (routeDeadline)', () => {
  /** Pages read the deadline from the meta: it is always the alarm's time, or absent with no alarm. */
  async function expectMirrorsAlarm(): Promise<void> {
    const alarm = await routeAlarm();
    expect(await deadline()).toBe(alarm?.scheduledTime);
  }

  it('is written with the status, when the recording ends', async () => {
    const writes: SessionMeta[] = [];
    const stop = watchSessions((_id, meta) => {
      if (meta?.status === 'awaiting-route') writes.push(meta);
    });
    const endedAt = h.clock.now();
    await endMeeting();
    await new Promise((r) => setTimeout(r, 0));
    stop();
    // The first write a page sees already says when the default applies.
    expect(writes[0]?.routeDeadline).toBe(endedAt + ROUTE_DELAY);
    expect(await deadline()).toBe(endedAt + ROUTE_DELAY);
    await expectMirrorsAlarm();
  });

  it('goes while paused, and comes back with the new countdown on resume or when the paused prompt closes', async () => {
    const windowId = await endMeeting();
    await m.routeHold(ID, true);
    expect(await deadline()).toBeUndefined();
    await expectMirrorsAlarm();

    h.clock.advance(3 * MINUTE);
    await m.routeHold(ID, false);
    expect(await deadline()).toBe(h.clock.now() + ROUTE_DELAY);
    await expectMirrorsAlarm();

    await m.routeHold(ID, true);
    h.clock.advance(5 * MINUTE);
    await m.onWindowRemoved(windowId);
    expect(await deadline()).toBe(h.clock.now() + ROUTE_DELAY);
    await expectMirrorsAlarm();
  });

  it('goes once the meeting has a destination: chosen, or the default applied', async () => {
    await endMeeting();
    await m.route(ID, 'personal');
    expect(await deadline()).toBeUndefined();
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'personal' });
  });

  it('goes when the default applies', async () => {
    await endMeeting();
    await m.onAlarm(`route:${ID}`);
    expect(await getSession(ID)).toMatchObject({ status: 'ready', route: 'team' });
    expect(await deadline()).toBeUndefined();
  });

  it('goes when the meeting is transcribed before anyone chose', async () => {
    await endMeeting();
    await m.transcribe(ID);
    await m.idle();
    expect((await getSession(ID))?.status).not.toBe('awaiting-route');
    expect(await deadline()).toBeUndefined();
    await expectMirrorsAlarm();
  });

  it('follows a new countdown after a browser restart', async () => {
    await endMeeting();
    await m.routeHold(ID, true);
    await fakeBrowser.storage.session.clear();
    h.clock.advance(60 * MINUTE);
    const next = h.createManager();
    await next.boot();
    expect(await deadline()).toBe(h.clock.now() + ROUTE_DELAY);
    await expectMirrorsAlarm();
  });
});
