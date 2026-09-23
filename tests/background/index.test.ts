import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { sendToBackground, type Envelope } from '@lib/messages';
import { getActiveRecording, getSession, putSession, updateSession } from '@lib/storage/sessionStore';
import { idempotencyKey } from '@lib/util/ids';
import background from '@/entrypoints/background/index';
import { configure, MEET_CODE, MEET_URL, resultFor, seg, setupHarness, type Harness } from './harness';

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
    await fromTab(tabId, 'captions/batch', { sessionId: id, segments: [seg('c1', 'Alice', 0, 'Salut')] });
    await sendToBackground('offscreen/recorder-chunk', { sessionId: id, index: 0, bytes: 1000 });
    expect(await getSession(id)).toMatchObject({ captionCount: 1, audio: { chunkCount: 1, bytes: 1000 } });

    // Transcribed and saved as soon as the call ends.
    await fakeBrowser.tabs.onRemoved.trigger(tabId, { isWindowClosing: false, windowId: 0 });
    await vi.waitFor(async () => expect(await statusOf(id)).toBe('saved'));
    expect((await getSession(id))?.profileId).toBe('team');
    expect(h.windowsCreated()).toEqual([]);

    await updateSession(id, { purgeAudioAt: Date.now() - 1 });
    await fakeBrowser.alarms.onAlarm.trigger({ name: 'retention', scheduledTime: Date.now(), persistAcrossSessions: false });
    await vi.waitFor(async () => expect((await getSession(id))?.audio.deletedAt).toBeDefined());

    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    await fakeBrowser.notifications.onClicked.trigger(`manet:${id}`);
    await vi.waitFor(() => expect(create).toHaveBeenCalledWith({ url: 'https://www.notion.so/page-1' }));

    await sendToBackground('session/delete', { sessionId: id });
    expect(await getSession(id)).toBeNull();
  });

  it('passes "anyway" requests on to the jobs', async () => {
    await startWorker();
    const tabId = await h.openMeetTab();
    h.offscreen.process = (job) =>
      job.force
        ? { status: 'processed', result: resultFor(job, Date.now()) }
        : { status: 'duplicate', existing: { pageId: 'p1', url: 'https://www.notion.so/p1', recordedBy: 'Alice' } };
    const res = await sendToBackground('session/start', { tabId });
    if (!res.ok) throw new Error(res.error);
    await sendToBackground('session/stop', { sessionId: res.sessionId });
    await vi.waitFor(async () => expect(await statusOf(res.sessionId)).toBe('duplicate'));

    await sendToBackground('session/transcribe', { sessionId: res.sessionId, force: true });
    await vi.waitFor(async () => expect(await statusOf(res.sessionId)).toBe('saved'));
    expect(h.offscreen.callsOf('offscreen/save').at(-1)?.force).toBe(true);
  });

  it('toggles recording from the keyboard command and stops when the tab leaves the call', async () => {
    await configure({ autoTranscribe: false });
    await startWorker();
    const tabId = await h.openMeetTab();

    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect(await getActiveRecording()).toMatchObject({ tabId }));
    const { sessionId: id } = (await getActiveRecording())!;
    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect(await statusOf(id)).toBe('ready'));

    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect((await getActiveRecording())?.sessionId).toBeDefined());
    const second = (await getActiveRecording())!.sessionId;
    expect(second).not.toBe(id);
    await fakeBrowser.tabs.update(tabId, { url: 'https://meet.google.com/landing' });
    await vi.waitFor(async () => expect(await statusOf(second)).toBe('ready'));
  });

  it('stays quiet about work the browser cuts off while shutting down', async () => {
    await startWorker();
    const tabId = await h.openMeetTab();
    for (const l of commands) l('toggle-recording', { id: tabId });
    await vi.waitFor(async () => expect(await getActiveRecording()).toMatchObject({ tabId }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shuttingDown = () => Promise.reject(new Error('The browser is shutting down.'));
    vi.spyOn(fakeBrowser.storage.session, 'get').mockImplementation(shuttingDown as never);
    vi.spyOn(fakeBrowser.storage.session, 'remove').mockImplementation(shuttingDown as never);

    await fakeBrowser.tabs.onRemoved.trigger(tabId, { isWindowClosing: true, windowId: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect(errors).not.toHaveBeenCalled();
  });

  it('sends handler errors back to the caller', async () => {
    await startWorker();
    await expect(sendToBackground('session/transcribe', { sessionId: 'nope' })).rejects.toThrow(
      'This meeting was deleted.',
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
    expect(h.windowsCreated()).toEqual([]);
  });

  it('restricts storage.local to trusted contexts before anything else', async () => {
    const get = vi.spyOn(fakeBrowser.storage.local, 'get');
    await startWorker();
    expect(h.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(h.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(get.mock.invocationCallOrder[0]!);
  });

  it('still starts when the access level cannot be set', async () => {
    h.setAccessLevel.mockRejectedValueOnce(new Error('Not supported for this storage area'));
    await startWorker();
    const tabId = await h.openMeetTab();
    expect(await sendToBackground('session/start', { tabId })).toMatchObject({ ok: true });
  });

  it('opens Settings on a first install only', async () => {
    await startWorker();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.0.0' } as never);
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'chrome_update' } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.openOptionsPage).not.toHaveBeenCalled();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' } as never);
    await vi.waitFor(() => expect(h.openOptionsPage).toHaveBeenCalledTimes(1));
  });

  it('says why the keyboard shortcut could not start a recording', async () => {
    await startWorker();
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    for (const l of commands) l('toggle-recording', { id: tab.id });
    await vi.waitFor(() =>
      expect(h.notifications()).toEqual([
        { id: 'manet:start', title: "Couldn’t start recording", message: 'This tab isn’t a Google Meet call.' },
      ]),
    );
  });

  it('gives Meet tabs that predate an install or update a content script', async () => {
    const stale = await h.openMeetTab(MEET_URL, { contentScript: false });
    await h.openMeetTab('https://meet.google.com/xyz-abcd-efg');
    await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    await startWorker();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.0.0' } as never);
    await vi.waitFor(() => expect(h.executeScript).toHaveBeenCalledTimes(1));
    expect(h.executeScript).toHaveBeenCalledWith({ target: { tabId: stale }, files: ['content-scripts/content.js'] });
  });
});
