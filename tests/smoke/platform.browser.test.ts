import { describe, expect, it } from 'vitest';

// Guards the test infrastructure itself: these APIs must be real, not polyfilled.
describe('browser test platform', () => {
  it('has a real OPFS', async () => {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('smoke.txt', { create: true });
    const w = await file.createWritable();
    await w.write('hello');
    await w.close();
    expect(await (await file.getFile()).text()).toBe('hello');
    await root.removeEntry('smoke.txt');
  });

  it('records Opus WebM with MediaRecorder from a running AudioContext', async () => {
    expect(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')).toBe(true);
    const ctx = new AudioContext();
    await ctx.resume();
    expect(ctx.state).toBe('running');
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));
    rec.start(200);
    await new Promise((r) => setTimeout(r, 700));
    rec.stop();
    await stopped;
    await ctx.close();
    expect(chunks.length).toBeGreaterThan(1);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]); // EBML magic
  });
});
