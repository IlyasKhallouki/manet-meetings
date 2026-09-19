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
    await ctl.setRecording({ sessionId: 's1', startedAt });
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
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
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

  it('ignores captions already on screen when recording starts, until they change', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOn);
    const toggle = wireCaptionsToggle(doc);
    await ctl.tick();
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([]);
    expect(toggle.clicks()).toBe(0);

    clock.now += 1000;
    editCaption(doc, 'You', 'Yes, looks good to me.');
    await ctl.flushCaptions();
    expect(bg.batches()).toEqual([
      { sessionId: 's1', segments: [expect.objectContaining({ speaker: 'You', text: 'Yes, looks good to me.', tStart: 2000 })] },
    ]);
  });

  it('keeps unsent segments after a failed batch and resends their latest revision', async () => {
    const bg = fakeBackground({ failBatches: 1 });
    const { ctl, doc, clock } = setup(inCallOff, bg);
    wireCaptionsToggle(doc);
    await ctl.tick();
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
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
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
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

  it('on pagehide sends the last batch and meet/left immediately, in that order', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Closing the tab now.');
    ctl.pageHide();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'meet/left']);
    expect(bg.batches()[0]!.segments.map((s) => s.text)).toContain('Closing the tab now.');
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
    expect(bg.batches()).toEqual([
      { sessionId: 's9', segments: [expect.objectContaining({ tStart: 60_500, text: 'Can everyone see my screen? Hello?' })] },
    ]);
  });

  it('stops capturing when the recording stops', async () => {
    const { ctl, bg, doc, clock } = setup(inCallOff);
    wireCaptionsToggle(doc);
    await ctl.tick();
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
    clock.now += 1000;
    await ctl.tick();
    editCaption(doc, 'You', 'Stopping the recording.');
    await ctl.setRecording(null);
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
    await ctl.setRecording({ sessionId: 's1', startedAt: clock.now });
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
    await expect(empty.setRecording({ sessionId: 's', startedAt: Date.now() })).resolves.toBeUndefined();
    await expect(empty.flushCaptions()).resolves.toBeUndefined();
    empty.pageHide();
    empty.dispose();

    const doc = openPage(inCallOn);
    const ctl = new MeetController({ doc, url: () => CALL_URL, send: failing, log: () => {} });
    await expect(ctl.tick()).resolves.toBeUndefined();
    await ctl.setRecording({ sessionId: 's', startedAt: Date.now() });
    editCaption(doc, 'You', 'Is anyone there?');
    await expect(ctl.flushCaptions()).resolves.toBeUndefined();
    ctl.pageHide();
    ctl.dispose();
    expect(bg.types()).toEqual(['meet/joined', 'captions/batch', 'captions/batch', 'meet/left']);
  });
});
