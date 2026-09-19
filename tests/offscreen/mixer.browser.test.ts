import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMixer, type Mixer } from '../../entrypoints/offscreen/mixer';
import { AUDIBLE_DB, SILENT_DB, audibleLevel, decode, levelDb, listen, sleep, speakerFeeds, tone } from './helpers';

const TAB_HZ = 440;
// Not a harmonic of TAB_HZ.
const MIC_HZ = 1000;

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function track(mixer: Mixer): Mixer {
  cleanups.push(() => mixer.close());
  return mixer;
}

async function playbackProbe() {
  const context = new AudioContext();
  await context.resume();
  const analyser = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
  cleanups.push(() => (context.state === 'closed' ? undefined : context.close()));
  return { context, analyser };
}

async function sources(opts: { tabChannel?: 'left' | 'right'; mic?: boolean } = {}) {
  const tab = await tone(TAB_HZ, { channel: opts.tabChannel });
  cleanups.push(() => tab.close());
  const mic = opts.mic ? await tone(MIC_HZ) : null;
  if (mic) cleanups.push(() => mic.close());
  return { tab, mic };
}

async function recordMs(stream: MediaStream, ms: number): Promise<AudioBuffer> {
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start();
  await sleep(ms);
  rec.stop();
  await stopped;
  return decode(new Blob(chunks));
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

describe('createMixer', () => {
  it('plays the tab back so the meeting stays audible, but never the mic', async () => {
    const { tab, mic } = await sources({ mic: true });
    const { context, analyser } = await playbackProbe();
    const mixer = track(
      createMixer({ tabStream: tab.stream, micStream: mic!.stream, playbackDestination: analyser, context }),
    );
    // The mic must be flowing (it reaches the mix) for its absence from playback to mean anything.
    const probe = await listen(mixer.stream);
    cleanups.push(() => probe.close());
    expect(await audibleLevel(probe.analyser, MIC_HZ)).toBeGreaterThan(AUDIBLE_DB);
    expect(await audibleLevel(analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    expect(await levelDb(analyser, MIC_HZ)).toBeLessThan(SILENT_DB);
  });

  it('mixes tab and mic into the recording stream', async () => {
    const { tab, mic } = await sources({ mic: true });
    const { context, analyser } = await playbackProbe();
    const mixer = track(
      createMixer({ tabStream: tab.stream, micStream: mic!.stream, playbackDestination: analyser, context }),
    );
    expect(mixer.stream.getAudioTracks()).toHaveLength(1);
    const probe = await listen(mixer.stream);
    cleanups.push(() => probe.close());
    expect(await audibleLevel(probe.analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    expect(await audibleLevel(probe.analyser, MIC_HZ)).toBeGreaterThan(AUDIBLE_DB);
  });

  it('records tab audio alone when there is no mic', async () => {
    const { tab } = await sources();
    const { context, analyser } = await playbackProbe();
    const mixer = track(createMixer({ tabStream: tab.stream, micStream: null, playbackDestination: analyser, context }));
    const probe = await listen(mixer.stream);
    cleanups.push(() => probe.close());
    expect(await audibleLevel(probe.analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    expect(await audibleLevel(analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
  });

  it('records mono, downmixing both channels of a stereo tab', async () => {
    // Tone on the right channel only: a discrete downmix would keep the silent left one.
    const { tab } = await sources({ tabChannel: 'right' });
    const { context, analyser } = await playbackProbe();
    const mixer = track(createMixer({ tabStream: tab.stream, micStream: null, playbackDestination: analyser, context }));
    expect(await audibleLevel(analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    const audio = await recordMs(mixer.stream, 1000);
    expect(audio.numberOfChannels).toBe(1);
    expect(rms(audio.getChannelData(0))).toBeGreaterThan(0.05);
  });

  it("plays the tab, and only the tab, through its own context's speakers by default", async () => {
    // Tab capture mutes the tab: without this route the user hears nothing of the meeting.
    const { tab, mic } = await sources({ mic: true });
    const fed = speakerFeeds();
    const mixer = track(createMixer({ tabStream: tab.stream, micStream: mic!.stream }));
    const feeds = fed();
    expect(feeds).toHaveLength(1);
    const { node, speakers } = feeds[0]!;
    expect(node).toBeInstanceOf(MediaStreamAudioSourceNode);
    expect((node as MediaStreamAudioSourceNode).mediaStream).toBe(tab.stream);
    expect(speakers).toBe(mixer.context.destination);
  });

  it('plays back through its own context by default and closes it on close()', async () => {
    const { tab } = await sources();
    const mixer = createMixer({ tabStream: tab.stream, micStream: null });
    expect(mixer.context).toBeInstanceOf(AudioContext);
    const probe = await listen(mixer.stream);
    cleanups.push(() => probe.close());
    expect(await audibleLevel(probe.analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    await mixer.close();
    expect(mixer.context.state).toBe('closed');
    expect(mixer.stream.getAudioTracks()[0]?.readyState).toBe('ended');
    await mixer.close();
  });

  it('leaves a context it was given open, but disconnects from it', async () => {
    const { tab } = await sources();
    const { context, analyser } = await playbackProbe();
    const mixer = createMixer({ tabStream: tab.stream, micStream: null, playbackDestination: analyser, context });
    expect(await audibleLevel(analyser, TAB_HZ)).toBeGreaterThan(AUDIBLE_DB);
    await mixer.close();
    await sleep(300);
    expect(context.state).toBe('running');
    expect(await levelDb(analyser, TAB_HZ)).toBeLessThan(SILENT_DB);
  });

  it('rejects a tab stream without audio and closes the context it made', async () => {
    const made: AudioContext[] = [];
    const Original = AudioContext;
    // Observe the context the mixer creates without replacing its behavior.
    globalThis.AudioContext = class extends Original {
      constructor(opts?: AudioContextOptions) {
        super(opts);
        made.push(this);
      }
    };
    try {
      expect(() => createMixer({ tabStream: new MediaStream(), micStream: null })).toThrow();
    } finally {
      globalThis.AudioContext = Original;
    }
    await sleep(50);
    expect(made).toHaveLength(1);
    expect(made[0]?.state).toBe('closed');
  });
});
