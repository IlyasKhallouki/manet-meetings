import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCaptureHost,
  openMicIfGranted,
  openTabStream,
  type CaptureDeps,
  type CaptureHost,
} from '../../entrypoints/offscreen/capture';
import { endable, sleep, speakerFeeds, testStore, tone, type EndableStream } from './helpers';

const SESSION = 'abc-defg-hij_20260919T101500Z';
const OTHER = 'xyz-abcd-efg_20260919T111500Z';

type Chunk = Parameters<CaptureDeps['onChunk']>[0];
type Stopped = Parameters<CaptureDeps['onStopped']>[0];

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

/** A synthetic tab: a tone whose track can end like a closed tab's. */
async function fakeTab(hz = 440): Promise<EndableStream> {
  const t = await tone(hz);
  cleanups.push(() => t.close());
  return endable(t);
}

async function setup(overrides: Partial<CaptureDeps> = {}) {
  const { store, cleanup } = await testStore();
  cleanups.push(cleanup);
  const tabs: EndableStream[] = [];
  const chunks: Chunk[] = [];
  const stops: Stopped[] = [];
  const waiters: ((s: Stopped) => void)[] = [];
  const deps: CaptureDeps = {
    store,
    openTabStream: vi.fn(async () => {
      const tab = await fakeTab();
      tabs.push(tab);
      return tab.stream;
    }),
    openMicStream: vi.fn(openMicIfGranted),
    onChunk: (c) => chunks.push(c),
    onStopped: (s) => {
      stops.push(s);
      for (const w of waiters.splice(0)) w(s);
    },
    ...overrides,
  };
  const host: CaptureHost = createCaptureHost(deps);
  cleanups.push(() => Promise.all(host.sessionIds().map((id) => host.stop(id))));
  const nextStop = () => new Promise<Stopped>((r) => waiters.push(r));
  return { host, deps, store, tabs, chunks, stops, nextStop };
}

const startReq = (sessionId = SESSION, includeMic = true) => ({
  sessionId,
  streamId: 'stream-1',
  timesliceMs: 250,
  includeMic,
});

describe('openMicIfGranted', () => {
  it('never asks for the mic unless permission was already granted', async () => {
    const perm = await navigator.permissions.query({ name: 'microphone' });
    expect(perm.state).not.toBe('granted');
    const gum = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    expect(await openMicIfGranted()).toBeNull();
    expect(gum).not.toHaveBeenCalled();
  });
});

describe('openTabStream', () => {
  it('asks Chrome for tab capture by stream id and surfaces its refusal', async () => {
    const gum = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    await expect(openTabStream('not-a-real-stream-id')).rejects.toThrow(/tab capture/i);
    expect(gum).toHaveBeenCalledWith({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'not-a-real-stream-id' } },
    });
  });
});

describe('createCaptureHost', () => {
  it('records the tab alone when the mic is not granted, with a heartbeat per chunk', async () => {
    const { host, deps, store, tabs, chunks, stops } = await setup();
    const gum = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const before = Date.now();
    const res = await host.start(startReq());
    expect(res).toEqual({
      ok: true,
      startedAt: expect.any(Number),
      micIncluded: false,
      mimeType: expect.stringMatching(/^audio\/webm/),
    });
    if (!res.ok) return;
    expect(res.startedAt).toBeGreaterThanOrEqual(before);
    expect(deps.openTabStream).toHaveBeenCalledWith('stream-1');
    expect(deps.openMicStream).toHaveBeenCalledTimes(1);
    expect(gum).not.toHaveBeenCalled();
    expect(host.sessionIds()).toEqual([SESSION]);
    expect(host.isRecording(SESSION)).toBe(true);

    await sleep(1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    let prev = 0;
    chunks.forEach((c, i) => {
      expect(c.sessionId).toBe(SESSION);
      expect(c.index).toBe(i);
      expect(c.bytes).toBeGreaterThan(prev);
      prev = c.bytes;
    });

    const counts = await host.stop(SESSION);
    expect(counts).toEqual(await store.stat(SESSION));
    expect(counts.chunkCount).toBe(chunks.length);
    expect(stops).toEqual([{ sessionId: SESSION, reason: 'requested', ...counts }]);
    expect(host.sessionIds()).toEqual([]);
    // Releasing the capture track is what un-mutes the tab.
    expect(tabs[0]?.track.readyState).toBe('ended');
  });

  it('mixes in the mic when one is available, and releases it on stop', async () => {
    const mic = await tone(1000);
    cleanups.push(() => mic.close());
    const { host, deps } = await setup({ openMicStream: vi.fn(async () => mic.stream) });
    const res = await host.start(startReq());
    expect(res).toMatchObject({ ok: true, micIncluded: true });
    await sleep(300);
    await host.stop(SESSION);
    expect(deps.openMicStream).toHaveBeenCalledTimes(1);
    expect(mic.track.readyState).toBe('ended');
  });

  it('plays the captured tab back to the speakers, but never the mic', async () => {
    // Tab capture mutes the tab: without this route the user hears nothing of the meeting.
    const mic = await tone(1000);
    cleanups.push(() => mic.close());
    const { host, tabs } = await setup({ openMicStream: vi.fn(async () => mic.stream) });
    const fed = speakerFeeds();
    expect(await host.start(startReq())).toMatchObject({ ok: true, micIncluded: true });
    const feeds = fed();
    expect(feeds).toHaveLength(1);
    const { node, speakers } = feeds[0]!;
    expect(node).toBeInstanceOf(MediaStreamAudioSourceNode);
    expect((node as MediaStreamAudioSourceNode).mediaStream).toBe(tabs[0]?.stream);
    expect(speakers).toBe(node.context.destination);
    await host.stop(SESSION);
  });

  it('does not touch the mic when the user turned it off', async () => {
    const { host, deps } = await setup();
    const res = await host.start(startReq(SESSION, false));
    expect(res).toMatchObject({ ok: true, micIncluded: false });
    expect(deps.openMicStream).not.toHaveBeenCalled();
  });

  it("reports 'track-ended' when the tab goes away and keeps the audio", async () => {
    const { host, store, tabs, stops, nextStop } = await setup();
    await host.start(startReq());
    await sleep(800);
    const stopped = nextStop();
    tabs[0]!.end();
    const s = await stopped;
    expect(s).toMatchObject({ sessionId: SESSION, reason: 'track-ended' });
    expect(s.chunkCount).toBeGreaterThan(0);
    expect(host.sessionIds()).toEqual([]);
    // A later stop request (the background learning of it) gets what is on disk.
    expect(await host.stop(SESSION)).toEqual({ chunkCount: s.chunkCount, bytes: s.bytes });
    expect(await store.stat(SESSION)).toEqual({ chunkCount: s.chunkCount, bytes: s.bytes });
    expect(stops).toHaveLength(1);
  });

  it('fails cleanly when Chrome refuses the tab capture stream', async () => {
    const { host, deps, store, stops } = await setup({ openTabStream: vi.fn(openTabStream) });
    const res = await host.start({ ...startReq(), streamId: 'expired-stream-id' });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/tab capture/i) });
    expect(deps.openMicStream).not.toHaveBeenCalled();
    expect(host.sessionIds()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(stops).toEqual([]);
  });

  it('releases the tab and mic when the recorder cannot start', async () => {
    const mic = await tone(1000);
    cleanups.push(() => mic.close());
    const { host, tabs, stops } = await setup({ openMicStream: async () => mic.stream });
    const res = await host.start({ ...startReq(), timesliceMs: 0 });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/timeslice/i) });
    expect(tabs[0]?.track.readyState).toBe('ended');
    expect(mic.track.readyState).toBe('ended');
    expect(host.sessionIds()).toEqual([]);
    expect(stops).toEqual([]);
  });

  it('starts each session once, even when asked twice at the same time', async () => {
    const { host, deps, chunks } = await setup();
    const [a, b] = await Promise.all([host.start(startReq()), host.start(startReq())]);
    expect(a).toEqual(b);
    expect(await host.start(startReq())).toEqual(a);
    expect(deps.openTabStream).toHaveBeenCalledTimes(1);
    await sleep(600);
    await host.stop(SESSION);
    expect(chunks.map((c) => c.index)).toEqual([...chunks.keys()]);
  });

  it('records separate sessions side by side', async () => {
    const { host, store } = await setup();
    await host.start(startReq(SESSION));
    await host.start(startReq(OTHER));
    expect(host.sessionIds().sort()).toEqual([SESSION, OTHER].sort());
    await sleep(600);
    await host.stop(SESSION);
    expect(host.sessionIds()).toEqual([OTHER]);
    await host.stop(OTHER);
    expect((await store.list()).map((s) => s.sessionId)).toEqual([SESSION, OTHER].sort());
  });

  it('a stop that races a start still stops the recording', async () => {
    const { host, stops } = await setup();
    const started = host.start(startReq());
    const counts = await host.stop(SESSION);
    expect(await started).toMatchObject({ ok: true });
    expect(host.sessionIds()).toEqual([]);
    expect(stops).toEqual([{ sessionId: SESSION, reason: 'requested', ...counts }]);
  });

  it('refuses to delete audio that is still being recorded', async () => {
    const { host } = await setup();
    await host.start(startReq());
    await sleep(600);
    await expect(host.deleteAudio(SESSION)).rejects.toThrow(/still recording/);
    await host.stop(SESSION);
    const scan = await host.scanAudio();
    expect(scan).toHaveLength(1);
    expect(scan[0]).toMatchObject({ sessionId: SESSION, chunkCount: expect.any(Number) });
    await host.deleteAudio(SESSION);
    expect(await host.scanAudio()).toEqual([]);
  });
});
