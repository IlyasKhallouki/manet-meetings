/**
 * Synthetic audio for the offscreen tests: oscillator MediaStreams stand in for the
 * tab and the mic, so everything runs in real Chrome without devices.
 */
import { vi } from 'vitest';
import { createOpfsAudioStore } from '@lib/storage/opfsAudioStore';
import type { AudioStore } from '@lib/types';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Tone {
  stream: MediaStream;
  track: MediaStreamTrack;
  context: AudioContext;
  close(): Promise<void>;
}

/**
 * A live MediaStream playing sine tones. `channel` puts the tone on one side of a
 * stereo stream; without it the stream is mono.
 */
export async function tone(hz: number, opts: { channel?: 'left' | 'right'; gain?: number } = {}): Promise<Tone> {
  const context = new AudioContext();
  await context.resume();
  const osc = new OscillatorNode(context, { frequency: hz });
  const gain = new GainNode(context, { gain: opts.gain ?? 0.5 });
  osc.connect(gain);
  let dest: MediaStreamAudioDestinationNode;
  if (opts.channel) {
    dest = new MediaStreamAudioDestinationNode(context, { channelCount: 2 });
    const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
    gain.connect(merger, 0, opts.channel === 'left' ? 0 : 1);
    merger.connect(dest);
  } else {
    dest = new MediaStreamAudioDestinationNode(context, { channelCount: 1 });
    gain.connect(dest);
  }
  osc.start();
  const track = dest.stream.getAudioTracks()[0];
  if (!track) throw new Error('no audio track');
  return { stream: dest.stream, track, context, close: () => context.close() };
}

// Chrome's insertable streams; not in the TS DOM lib.
interface TrackProcessor {
  readable: ReadableStream<unknown>;
}
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<unknown>;
}
declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => TrackProcessor;
declare const MediaStreamTrackGenerator: new (init: { kind: 'audio' }) => TrackGenerator;

export interface EndableStream {
  stream: MediaStream;
  track: MediaStreamTrack;
  /** Ends the track from its source, like a closed tab: fires a real 'ended' event. */
  end(): void;
}

/**
 * Re-publishes a tone through a MediaStreamTrackGenerator. Unlike track.stop(), which
 * never fires 'ended', stopping the source closes the generator and ends its track the
 * way a tab capture track ends when the tab goes away.
 */
export function endable(source: Tone): EndableStream {
  const track = new MediaStreamTrackGenerator({ kind: 'audio' });
  void new MediaStreamTrackProcessor({ track: source.track }).readable.pipeTo(track.writable).catch(() => undefined);
  return { stream: new MediaStream([track]), track, end: () => source.track.stop() };
}

/**
 * Level in dB around `hz` on an analyser with smoothing off: the median of a few frames,
 * so a single glitch (a click is broadband) cannot decide a test.
 */
export async function levelDb(analyser: AnalyserNode, hz: number, frames = 5): Promise<number> {
  const bins = new Float32Array(analyser.frequencyBinCount);
  const binHz = analyser.context.sampleRate / analyser.fftSize;
  const center = Math.round(hz / binHz);
  const peaks: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (f > 0) await sleep(60);
    analyser.getFloatFrequencyData(bins);
    let peak = -Infinity;
    for (let i = center - 2; i <= center + 2; i++) peak = Math.max(peak, bins[i] ?? -Infinity);
    peaks.push(peak);
  }
  peaks.sort((a, b) => a - b);
  return peaks[Math.floor(peaks.length / 2)] ?? -Infinity;
}

/**
 * Polls until the tone at `hz` is audible, up to `timeoutMs`, and returns the last level.
 * Audio takes a moment to start flowing between contexts, longer under load.
 */
export async function audibleLevel(analyser: AnalyserNode, hz: number, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let level = await levelDb(analyser, hz);
  while (level <= AUDIBLE_DB && Date.now() < deadline) {
    await sleep(100);
    level = await levelDb(analyser, hz);
  }
  return level;
}

/** An analyser listening to a MediaStream in its own context. */
export async function listen(stream: MediaStream): Promise<{ analyser: AnalyserNode; close(): Promise<void> }> {
  const context = new AudioContext();
  await context.resume();
  const analyser = new AnalyserNode(context, { fftSize: 4096, smoothingTimeConstant: 0 });
  context.createMediaStreamSource(stream).connect(analyser);
  return { analyser, close: () => context.close() };
}

export const AUDIBLE_DB = -40;
/** A leaked tone would sit around -20 dB. */
export const SILENT_DB = -60;

/**
 * Records every connection made straight to an AudioDestinationNode (the speakers) from
 * here on; call the returned function to read them. Headless Chrome gives no way to
 * listen to the real output, so the wiring is observed instead: connect() still runs.
 * Undo with vi.restoreAllMocks().
 */
export function speakerFeeds(): () => { node: AudioNode; speakers: AudioDestinationNode }[] {
  const connect = vi.spyOn(AudioNode.prototype, 'connect');
  return () =>
    connect.mock.calls.flatMap(([target], i) =>
      target instanceof AudioDestinationNode ? [{ node: connect.mock.contexts[i] as AudioNode, speakers: target }] : [],
    );
}

export function decode(blob: Blob): Promise<AudioBuffer> {
  return blob.arrayBuffer().then((buf) => new OfflineAudioContext(1, 1, 48_000).decodeAudioData(buf));
}

/** An OPFS audio store rooted in a fresh directory of its own. */
export async function testStore(): Promise<{
  store: AudioStore;
  /** Removes the root directory out from under the store: later writes fail. */
  removeRoot(): Promise<void>;
  cleanup(): Promise<void>;
}> {
  const opfs = await navigator.storage.getDirectory();
  const name = `offscreen-test-${crypto.randomUUID()}`;
  const root = await opfs.getDirectoryHandle(name, { create: true });
  const removeRoot = async () => {
    try {
      await opfs.removeEntry(name, { recursive: true });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
    }
  };
  return { store: createOpfsAudioStore(async () => root), removeRoot, cleanup: removeRoot };
}
