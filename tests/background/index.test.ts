import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendToBackground, type Envelope } from '@lib/messages';
import { getActiveRecording, getSession, putSession } from '@lib/storage/sessionStore';
import { idempotencyKey } from '@lib/util/ids';
import background from '@/entrypoints/background/index';
import { configure, MEET_CODE, seg, setupHarness, type Harness } from './harness';

type CommandListener = (command: string, tab?: { id?: number }) => void;

let h: Harness;
let commands: CommandListener[];

beforeEach(async () => {
  h = setupHarness();
  // chrome.commands is not implemented by fakeBrowser.
  commands = [];
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(((l: CommandListener) => {
    commands.push(l);
  }) as never);
  await configure();
});

/** Runs the worker's main() and waits for its startup recovery to finish. */
async function startWorker() {
  background.main();
  await vi.waitFor(async () => {
    expect(h.offscreen.callsOf('offscreen/audio-scan')).toHaveLength(1);
    expect(await fakeBrowser.alarms.get('retention')).toBeDefined();
  });
}

/** A content-script message: unlike sendToBackground, it carries the sender's tab. */
function fromTab(tabId: number, type: string, payload: unknown): Promise<unknown> {
  const envelope: Envelope = { __manet: true, target: 'background', type, payload };
  return new Promise((resolve) => {
    void fakeBrowser.runtime.onMessage.trigger(envelope, { tab: { id: tabId } as never }, resolve);
  });
}

async function statusOf(id: string) {
  return (await getSession(id))?.status;
}

describe('background entrypoint', () => {
  it('routes messages, tab events, alarms and notification clicks to the session manager', async () => {
    await startWorker();
    const tabId = await h.openMeetTab();

    const res = await sendToBackground('session/start', { tabId });
    if (!res.ok) throw new Error(res.error);
    const id = res.sessionId;
    expect(await statusOf(id)).toBe('recording');

    expect(await fromTab(tabId, 'meet/joined', { meetCode: MEET_CODE })).toEqual({
      ok: true,
      value: { sessionId: id, startedAt: expect.any(Number) },
    });
    await sendToBackground('captions/batch', { sessionId: id, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await sendToBackground('offscreen/recorder-chunk', { sessionId: id, index: 0, bytes: 1000 });
    expect(await getSession(id)).toMatchObject({ captionCount: 1, audio: { chunkCount: 1, bytes: 1000 } });

    await fakeBrowser.tabs.onRemoved.trigger(tabId, { isWindowClosing: false, windowId: 0 });
    await vi.waitFor(async () => expect(await statusOf(id)).toBe('awaiting-route'));
    expect(h.windowsCreate).toHaveBeenCalledTimes(1);

    await fakeBrowser.alarms.onAlarm.trigger({ name: `route:${id}`, scheduledTime: Date.now() });
    await vi.waitFor(async () => expect(await statusOf(id)).toBe('saved'));
    expect((await getSession(id))?.route).toBe('team');

    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await fakeBrowser.notifications.onClicked.trigger(`manet:${id}`);
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: 'https://www.notion.so/page-1' }));

    await sendToBackground('session/delete', { sessionId: id });
    expect(await getSession(id)).toBeNull();
  });

  it('toggles recording from the keyboard command and stops when the tab leaves the call', async () => {
    await startWorker();
    const tabId = await h.openMeetTab();

    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect(await getActiveRecording()).toMatchObject({ tabId }));
    const { sessionId: id } = (await getActiveRecording())!;
    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect(await statusOf(id)).toBe('awaiting-route'));

    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect((await getActiveRecording())?.sessionId).toBeDefined());
    const second = (await getActiveRecording())!.sessionId;
    expect(second).not.toBe(id);
    await fakeBrowser.tabs.update(tabId, { url: 'https://meet.google.com/landing' });
    await vi.waitFor(async () => expect(await statusOf(second)).toBe('awaiting-route'));
  });

  it('sends handler errors back to the caller', async () => {
    await startWorker();
    await expect(sendToBackground('session/route', { sessionId: 'nope', route: 'team' })).rejects.toThrow(
      /Unknown session/,
    );
    expect(await sendToBackground('session/start', { tabId: 12345 })).toMatchObject({ ok: false });
  });

  it('recovers orphaned recordings when the browser starts', async () => {
    await configure({ autoTranscribe: false });
    await startWorker();
    const startedAt = Date.now() - 60_000;
    const id = `${MEET_CODE}_20260919T090000Z`;
    await putSession({
      id,
      meetCode: MEET_CODE,
      startedAt,
      status: 'recording',
      idempotencyKey: idempotencyKey(MEET_CODE, startedAt),
      audio: { mimeType: 'audio/webm', chunkCount: 4, bytes: 400, micIncluded: true },
      captionCount: 0,
      lastHeartbeat: startedAt + 20_000,
    });

    await fakeBrowser.runtime.onStartup.trigger();
    await vi.waitFor(async () =>
      expect(await getSession(id)).toMatchObject({ status: 'ready', recovered: true, durationMs: 20_000 }),
    );
  });
});
