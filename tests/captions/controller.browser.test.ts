import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundProtocol, RecordingState } from '@lib/messages';
import type { CaptionSegment } from '@lib/types';
import { MeetController, type SendToBackground } from '../../entrypoints/content/controller';
import callEnded from '../fixtures/captions/call-ended.html?raw';
import inCallOff from '../fixtures/captions/in-call-captions-off.html?raw';
import inCallOn from '../fixtures/captions/in-call-captions-on.html?raw';
import preJoin from '../fixtures/captions/pre-join.html?raw';

const CALL_URL = 'https://meet.google.com/abc-defg-hij';
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

interface Sent {
  type: keyof BackgroundProtocol;
  payload: unknown;
}

/**
 * Stands in for chrome.runtime messaging to the background (the only stubbed API):
 * records every message and answers meet/joined.
 */
function fakeBackground(opts: { joined?: RecordingState | null; failBatches?: number } = {}) {
  const sent: Sent[] = [];
  let failBatches = opts.failBatches ?? 0;
  const send: SendToBackground = async (type, payload) => {
    sent.push({ type, payload: structuredClone(payload) });
    if (type === 'captions/batch' && failBatches > 0) {
      failBatches--;
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }
    return (type === 'meet/joined' ? (opts.joined ?? null) : undefined) as never;
  };
  const batches = () =>
    sent
      .filter((m) => m.type === 'captions/batch')
      .map((m) => m.payload as { sessionId: string; segments: CaptionSegment[] });
  return { sent, send, batches, types: () => sent.map((m) => m.type) };
}

const frames: HTMLIFrameElement[] = [];

/** A live document (real browsing context) holding a Meet fixture. */
function openPage(html: string): Document {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  frames.push(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  return doc;
}

/** SPA navigation: Meet swaps the page content without reloading. */
function navigate(doc: Document, html: string): void {
  const next = parse(html);
  doc.title = next.title;
  doc.body.replaceChildren(...[...next.body.childNodes].map((n) => doc.importNode(n, true)));
}

/** Makes the fixture's CC button behave like Meet's: toggles its icon/label and the captions panel. */
function wireCaptionsToggle(doc: Document): { clicks: () => number } {
  let clicks = 0;
  const cc = doc.querySelector('[jsname="RrG0hf"]')!;
  cc.addEventListener('click', () => {
    clicks++;
    const icon = cc.querySelector('i')!;
    const wasOn = icon.textContent === 'closed_caption';
    icon.textContent = wasOn ? 'closed_caption_off' : 'closed_caption';
    cc.setAttribute('aria-label', wasOn ? 'Turn on captions' : 'Turn off captions');
    if (wasOn) doc.querySelector('[jsname="dsyhDe"]')?.remove();
    else doc.body.prepend(doc.importNode(parse(inCallOn).querySelector('[jsname="dsyhDe"]')!, true));
  });
  return { clicks: () => clicks };
}

function editCaption(doc: Document, speaker: string, text: string): void {
  const block = [...doc.querySelectorAll('.nMcdL')].find((b) => b.querySelector('.NWpY1d')?.textContent === speaker)!;
  (block.querySelector('.ygicle')!.firstChild as Text).data = text;
}

function setup(html: string, bg = fakeBackground()) {
  const doc = openPage(html);
  const clock = { now: 1_789_000_000_000 };
  const url = { href: CALL_URL };
  const logs: string[] = [];
  const ctl = new MeetController({
    doc,
    url: () => url.href,
    send: bg.send,
    clock: () => clock.now,
    log: (message) => logs.push(message),
  });
  return { doc, clock, url, logs, ctl, bg };
}

afterEach(() => {
  for (const f of frames.splice(0)) f.remove();
});

/** What the background keeps: the highest rev per id. */
function fold(batches: { segments: CaptionSegment[] }[]): CaptionSegment[] {
  const best = new Map<string, CaptionSegment>();
  for (const seg of batches.flatMap((b) => b.segments)) {
    const prev = best.get(seg.id);
    if (!prev || seg.rev > prev.rev) best.set(seg.id, seg);
  }
  return [...best.values()].sort((a, b) => a.tStart - b.tStart);
}

describe('MeetController', () => {
  it('stays quiet outside a call', async () => {
    const { ctl, bg, url } = setup(preJoin);
    await ctl.tick();
    url.href = 'https://meet.google.com/landing';
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.sent).toEqual([]);
  });

  it('announces the call once, with its title, and captures nothing without a recording', async () => {
    const { ctl, bg, doc } = setup(inCallOff);
    const toggle = wireCaptionsToggle(doc);
    await ctl.tick();
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.sent).toEqual([{ type: 'meet/joined', payload: { meetCode: 'abc-defg-hij', title: 'Weekly product sync' } }]);
    expect(toggle.clicks()).toBe(0);
  });

  it('waits briefly for Meet to show the title, then joins without one', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    doc.querySelector('[jsname="NeC6gb"]')!.textContent = 'abc-defg-hij';
    doc.title = 'Meet - abc-defg-hij';
    await ctl.tick();
    clock.now += 1000;
    await ctl.tick();
    expect(bg.sent).toEqual([]);
    clock.now += 2500;
    await ctl.tick();
    expect(bg.sent).toEqual([{ type: 'meet/joined', payload: { meetCode: 'abc-defg-hij' } }]);
  });

  it('turns captions on once and batches post-start captions timed from startedAt', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    const toggle = wireCaptionsToggle(doc);
    await ctl.tick();
    const startedAt = clock.now;
    ctl.setRecording({ sessionId: 's1', startedAt });
    expect(toggle.clicks()).toBe(1);

    clock.now += 1500;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([
      {
        sessionId: 's1',
        segments: [
          expect.objectContaining({ speaker: 'Camille Martin', text: 'Can everyone see my screen?', self: false, tStart: 1500, rev: 0 }),
          expect.objectContaining({ speaker: 'You', text: 'Yes, looks good.', self: true, tStart: 1500, rev: 0 }),
        ],
      },
    ]);

    clock.now += 800;
    editCaption(doc, 'Camille Martin', 'Can everyone see my screen now?');
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()[1]).toEqual({
      sessionId: 's1',
      segments: [expect.objectContaining({ text: 'Can everyone see my screen now?', tStart: 1500, tEnd: 2300, rev: 1 })],
    });

    for (let i = 0; i < 5; i++) {
      clock.now += 1000;
      await ctl.tick();
    }
    await ctl.flushCaptions();
    expect(toggle.clicks()).toBe(1);
    expect(bg.batches()).toHaveLength(2);
  });

  it('retries the toggle while the toolbar loads, without double-clicking', async () => {
    const { ctl, doc, clock } = setup(inCallOff);
    const toolbar = doc.querySelector('[role="region"][aria-label="Call controls"]')!;
    const parent = toolbar.parentNode!;
    toolbar.remove();
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    parent.append(toolbar);
    const toggle = wireCaptionsToggle(doc);
    clock.now += 1000;
    await ctl.tick();
    clock.now += 1000;
    await ctl.tick();
    expect(toggle.clicks()).toBe(1);
  });

  it('ignores captions already on screen when recording starts, then ships only words added to them', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOn);
    const toggle = wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([]);
    expect(toggle.clicks()).toBe(0);

    // Meet corrects a finished pre-recording block: that speech predates t = 0.
    clock.now += 1000;
    editCaption(doc, 'Camille Martin', 'Can anyone see my screen?');
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([]);

    // The local user keeps talking in a block that started before the recording.
    editCaption(doc, 'You', 'Yes, looks good to me.');
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([
      { sessionId: 's1', segments: [expect.objectContaining({ speaker: 'You', text: 'to me.', tStart: 2000, rev: 0 })] },
    ]);
    clock.now += 500;
    editCaption(doc, 'You', 'Yes, looks good to me. Ship it.');
    await ctl.flushCaptions();
    expect(bg.batches()[1]!.segments).toEqual([
      expect.objectContaining({ text: 'to me. Ship it.', tStart: 2000, tEnd: 2500, rev: 1 }),
    ]);
  });

  it('keeps unsent segments after a failed batch and resends their latest revision', async () => {
    const bg = fakeBackground({ failBatches: 1 });
    const { ctl, doc, clock } = setup(inCallOff, bg);
    wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toHaveLength(1);

    clock.now += 1000;
    editCaption(doc, 'Camille Martin', 'Can everyone see my screen now?');
    await ctl.flushCaptions();
    const retry = bg.batches()[1]!;
    expect(retry.segments.map((s) => [s.text, s.rev])).toEqual([
      ['Can everyone see my screen now?', 1],
      ['Yes, looks good.', 0],
    ]);
  });

  it('flushes captions, then sends meet/left, when the call ends', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Bye everyone!');
    navigate(doc, callEnded);
    clock.now += 1000;
    await ctl.tick();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'meet/left']);
    expect(bg.batches()[0]!.segments.map((s) => s.text)).toEqual(['Can everyone see my screen?', 'Bye everyone!']);
    expect(bg.sent.at(-1)).toEqual({ type: 'meet/left', payload: { meetCode: 'abc-defg-hij' } });

    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.sent).toHaveLength(3);
  });

  it('on pagehide sends the last batch immediately but not meet/left, so a reload keeps recording', async () => {
    const bg = fakeBackground({ joined: { sessionId: 's1', startedAt: 1_789_000_000_000 } });
    const { ctl, doc, clock } = setup(inCallOff, bg);
    wireCaptionsToggle(doc);
    await ctl.tick();
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Reloading, one second.');
    ctl.pageHide();
    // Closing the tab or navigating away is seen by the background (tabs.onRemoved / onUpdated).
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch']);
    expect(bg.batches()[0]!.segments.map((s) => s.text)).toContain('Reloading, one second.');
    editCaption(doc, 'You', 'Not captured after pagehide.');
    await ctl.flushCaptions();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch']);

    // Restored from the back/forward cache: the page asks again and resumes capturing.
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Not captured after pagehide. Back again.');
    await ctl.flushCaptions();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'meet/joined', 'captions/batch']);
    expect(bg.batches()[1]!.segments.map((s) => s.text)).toEqual(['Back again.']);
  });

  it('keeps the call through a brief toolbar outage and leaves once it stays gone', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    const toolbar = doc.querySelector('[role="region"][aria-label="Call controls"]')!;
    const parent = toolbar.parentNode!;

    // Meet re-renders its toolbar: two ticks without a leave button.
    toolbar.remove();
    for (let i = 0; i < 2; i++) {
      clock.now += 1000;
      await ctl.tick();
    }
    editCaption(doc, 'You', 'Still talking during the re-render.');
    parent.append(toolbar);
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'captions/batch']);
    expect(bg.batches()[1]!.segments.map((s) => s.text)).toEqual(['Still talking during the re-render.']);

    // Gone for good (no call-ended screen recognised): leave after three missed ticks.
    toolbar.remove();
    for (let i = 0; i < 2; i++) {
      clock.now += 1000;
      await ctl.tick();
    }
    expect(bg.types()).not.toContain('meet/left');
    clock.now += 1000;
    await ctl.tick();
    expect(bg.types().at(-1)).toBe('meet/left');
  });

  it('leaves at once when the call-ended screen shows or the tab leaves the call URL', async () => {
    const ended = setup(inCallOff);
    await ended.ctl.tick();
    navigate(ended.doc, callEnded);
    await ended.ctl.tick();
    expect(ended.bg.types()).toEqual(['meet/joined', 'meet/left']);

    const home = setup(inCallOff);
    await home.ctl.tick();
    home.url.href = 'https://meet.google.com/landing';
    await home.ctl.tick();
    expect(home.bg.types()).toEqual(['meet/joined', 'meet/left']);
  });

  it("adopts the recorder's t = 0 when the same session arrives with a corrected startedAt", async () => {
    const requestedAt = 1_789_000_000_000;
    const bg = fakeBackground({ joined: { sessionId: 's1', startedAt: requestedAt } });
    const { ctl, doc, clock } = setup(inCallOff, bg);
    wireCaptionsToggle(doc);
    await ctl.tick();
    clock.now += 2000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()[0]!.segments.map((s) => s.tStart)).toEqual([2000, 2000]);

    // The recorder really started 1.5 s after the request.
    ctl.setRecording({ sessionId: 's1', startedAt: requestedAt + 1500 });
    clock.now += 1000;
    editCaption(doc, 'You', 'Yes, looks good. Thanks.');
    await ctl.flushCaptions();
    // Already-sent segments come back with a higher rev, so the background replaces them.
    expect(fold(bg.batches()).map((s) => [s.speaker, s.tStart, s.tEnd])).toEqual([
      ['Camille Martin', 500, 500],
      ['You', 500, 1500],
    ]);
  });

  it('ignores a meet/joined reply that a newer recording-state push overtook', async () => {
    const requestedAt = 1_789_000_000_000;
    const bg = fakeBackground();
    let reply: (state: RecordingState | null) => void = () => {};
    const send: SendToBackground = async (type, payload) => {
      if (type !== 'meet/joined') return bg.send(type, payload);
      await bg.send(type, payload);
      return new Promise<RecordingState | null>((resolve) => (reply = resolve)) as never;
    };
    const { ctl, doc, clock } = setup(inCallOff, { ...bg, send });
    const toggle = wireCaptionsToggle(doc);

    // The recording stopped while meet/joined was in flight: the stale reply must not restart capture.
    const joining = ctl.tick();
    await Promise.resolve();
    ctl.setRecording(null);
    reply({ sessionId: 's1', startedAt: requestedAt });
    await joining;
    expect(toggle.clicks()).toBe(0);
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([]);
  });

  it('treats an SPA navigation to another meeting code as leaving one call and joining the next', async () => {
    const { ctl, bg, url } = setup(inCallOff);
    await ctl.tick();
    url.href = 'https://meet.google.com/xyz-abcd-efg?authuser=0';
    await ctl.tick();
    expect(bg.sent.map((m) => [m.type, (m.payload as { meetCode: string }).meetCode])).toEqual([
      ['meet/joined', 'abc-defg-hij'],
      ['meet/left', 'abc-defg-hij'],
      ['meet/joined', 'xyz-abcd-efg'],
    ]);
  });

  it('resumes capturing when meet/joined reports a recording already running', async () => {
    const startedAt = 1_789_000_000_000 - 60_000;
    const bg = fakeBackground({ joined: { sessionId: 's9', startedAt } });
    const { ctl, doc, clock } = setup(inCallOn, bg);
    await ctl.tick();
    clock.now += 500;
    editCaption(doc, 'Camille Martin', 'Can everyone see my screen? Hello?');
    await ctl.flushCaptions();
    // What was on screen when capture resumed is skipped, as at a fresh start.
    expect(bg.batches()).toEqual([
      { sessionId: 's9', segments: [expect.objectContaining({ tStart: 60_500, text: 'Hello?' })] },
    ]);
  });

  it('stops capturing when the recording stops', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Stopping the recording.');
    ctl.setRecording(null);
    expect(bg.batches()).toHaveLength(1);
    expect(bg.batches()[0]!.segments.map((s) => s.text)).toContain('Stopping the recording.');

    editCaption(doc, 'You', 'This is not recorded.');
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toHaveLength(1);
  });

  it('logs adapter health once per call', async () => {
    const { ctl, doc, clock, logs } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    for (let i = 0; i < 4; i++) {
      clock.now += 1000;
      await ctl.tick();
    }
    expect(logs.filter((l) => l.includes('health'))).toHaveLength(1);
  });

  it('survives a page with no Meet UI and a background that is down', async () => {
    const bg = fakeBackground();
    const failing: SendToBackground = async (type, payload) => {
      await bg.send(type, payload);
      throw new Error('Extension context invalidated.');
    };
    const empty = new MeetController({
      doc: openPage('<!doctype html><title>x</title><p>nothing</p>'),
      url: () => CALL_URL,
      send: failing,
      log: () => {},
    });
    await expect(empty.tick()).resolves.toBeUndefined();
    expect(() => empty.setRecording({ sessionId: 's', startedAt: Date.now() })).not.toThrow();
    await expect(empty.flushCaptions()).resolves.toBeUndefined();
    empty.pageHide();
    empty.dispose();

    const doc = openPage(inCallOn);
    const ctl = new MeetController({ doc, url: () => CALL_URL, send: failing, log: () => {} });
    await expect(ctl.tick()).resolves.toBeUndefined();
    ctl.setRecording({ sessionId: 's', startedAt: Date.now() });
    editCaption(doc, 'You', 'Yes, looks good. Is anyone there?');
    await expect(ctl.flushCaptions()).resolves.toBeUndefined();
    ctl.pageHide();
    ctl.dispose();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'captions/batch']);
  });
});
