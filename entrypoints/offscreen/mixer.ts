/**
 * Mixes the captured tab with the local mic into one mono stream for the recorder.
 *
 * Tab capture mutes the tab for the user, so tab audio is also routed to a playback
 * destination (the speakers). The mic only goes into the mix: playing it back would
 * echo the user's own voice.
 */

export interface MixerOptions {
  tabStream: MediaStream;
  micStream: MediaStream | null;
  /** Where tab audio is played. Defaults to the context's speakers. Must belong to `context`. */
  playbackDestination?: AudioNode;
  /** Defaults to a new AudioContext, which close() then closes. A context passed in stays open. */
  context?: AudioContext;
}

export interface Mixer {
  /** Mono mix of tab + mic. */
  stream: MediaStream;
  context: AudioContext;
  /** Disconnects everything and ends `stream`. Does not stop the input tracks. Idempotent. */
  close(): Promise<void>;
}

export function createMixer(opts: MixerOptions): Mixer {
  const ownsContext = !opts.context;
  const context = opts.context ?? new AudioContext();
  const nodes: AudioNode[] = [];
  try {
    // 'speakers' downmixes stereo to (L + R) / 2 instead of keeping only the left channel.
    const mix = new MediaStreamAudioDestinationNode(context, {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    nodes.push(mix);
    const tab = context.createMediaStreamSource(opts.tabStream);
    nodes.push(tab);
    tab.connect(opts.playbackDestination ?? context.destination);
    tab.connect(mix);
    if (opts.micStream) {
      const mic = context.createMediaStreamSource(opts.micStream);
      nodes.push(mic);
      mic.connect(mix);
    }

    let closing: Promise<void> | null = null;
    return {
      stream: mix.stream,
      context,
      close() {
        closing ??= (async () => {
          for (const node of nodes) node.disconnect();
          for (const t of mix.stream.getTracks()) t.stop();
          if (ownsContext && context.state !== 'closed') await context.close();
        })();
        return closing;
      },
    };
  } catch (err) {
    for (const node of nodes) node.disconnect();
    if (ownsContext) void context.close();
    throw err;
  }
}
