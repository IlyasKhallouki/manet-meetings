import { describe, expect, it } from 'vitest';
import {
  adapterHealth,
  callEndedScreen,
  captionBlockOf,
  captionsEnabled,
  enableCaptions,
  findCaptionRegion,
  isInCall,
  isSelfLabel,
  meetingTitle,
  readCaptionBlock,
  readCaptionBlocks,
} from '@lib/meet/captionAdapter';
import callEnded from '../fixtures/captions/call-ended.html?raw';
import frenchUi from '../fixtures/captions/french-ui.html?raw';
import inCallOff from '../fixtures/captions/in-call-captions-off.html?raw';
import inCallOn from '../fixtures/captions/in-call-captions-on.html?raw';
import multiSpeaker from '../fixtures/captions/multi-speaker.html?raw';
import preJoin from '../fixtures/captions/pre-join.html?raw';
import rotated from '../fixtures/captions/rotated-classes.html?raw';
import selfYou from '../fixtures/captions/self-you.html?raw';
import singleSpeaker from '../fixtures/captions/single-speaker.html?raw';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

function region(html: string): Element {
  const r = findCaptionRegion(parse(html));
  if (!r) throw new Error('fixture has no caption region');
  return r;
}

const summary = (html: string) =>
  readCaptionBlocks(region(html)).map(({ speaker, text, self }) => ({ speaker, text, self }));

describe('findCaptionRegion', () => {
  it('finds the captions region in every fixture that shows captions', () => {
    for (const html of [singleSpeaker, multiSpeaker, selfYou, inCallOn, frenchUi, rotated]) {
      const r = findCaptionRegion(parse(html));
      expect(r?.getAttribute('role')).toBe('region');
      expect(r?.getAttribute('tabindex')).toBe('0');
    }
  });

  it('returns null when captions are not on screen, and never picks the call-controls region', () => {
    for (const html of [inCallOff, preJoin, callEnded]) expect(findCaptionRegion(parse(html))).toBeNull();
  });

  it('tolerates an empty document', () => {
    expect(findCaptionRegion(document.implementation.createHTMLDocument(''))).toBeNull();
  });
});

describe('readCaptionBlocks', () => {
  it('reads one speaker block', () => {
    expect(summary(singleSpeaker)).toEqual([
      {
        speaker: 'Camille Martin',
        text: "Let's look at the onboarding numbers first, then the roadmap.",
        self: false,
      },
    ]);
  });

  it('reads several speakers in order, with whitespace collapsed and the jump button skipped', () => {
    expect(summary(multiSpeaker)).toEqual([
      { speaker: 'Camille Martin', text: 'Kickoff is at ten.', self: false },
      { speaker: 'Hugo Bernard', text: "On garde la démo pour jeudi, c'est bon pour tout le monde ?", self: false },
      { speaker: "Riley O'Neil (Ops)", text: 'Works for me.', self: false },
      { speaker: 'Camille Martin', text: "Great, I'll send the invite.", self: false },
    ]);
  });

  it('returns the block element itself as node', () => {
    const blocks = readCaptionBlocks(region(multiSpeaker));
    expect(blocks.every((b) => b.node.classList.contains('nMcdL'))).toBe(true);
    expect(new Set(blocks.map((b) => b.node)).size).toBe(4);
  });

  it('flags the local user in English and French UIs', () => {
    expect(summary(selfYou)).toEqual([
      { speaker: 'Hugo Bernard', text: 'Can you share the deck?', self: false },
      { speaker: 'You', text: 'Sure, sharing it now.', self: true },
    ]);
    expect(summary(frenchUi)).toEqual([
      { speaker: 'Hugo Bernard', text: 'On commence par la démo de Manet ?', self: false },
      { speaker: 'Vous', text: 'Oui, je partage mon écran.', self: true },
    ]);
  });

  it('falls back to the block shape when Meet rotates its class names', () => {
    expect(summary(rotated)).toEqual([
      { speaker: 'Camille Martin', text: 'We should freeze the scope today.', self: false },
      { speaker: 'Hugo Bernard', text: 'Agreed.', self: false },
    ]);
  });

  it('skips blocks without text and never throws on odd input', () => {
    const r = region(selfYou);
    r.querySelector('.ygicle')!.textContent = '   ';
    expect(readCaptionBlocks(r).map((b) => b.speaker)).toEqual(['You']);
    expect(readCaptionBlocks(document.createElement('div'))).toEqual([]);
  });
});

describe('readCaptionBlock', () => {
  it('reads a single block element and rejects non-blocks or empty text', () => {
    const r = region(selfYou);
    const [hugo, me] = readCaptionBlocks(r);
    expect(readCaptionBlock(me!.node)).toEqual({ node: me!.node, speaker: 'You', text: 'Sure, sharing it now.', self: true });
    hugo!.node.querySelector('.ygicle')!.textContent = '';
    expect(readCaptionBlock(hugo!.node)).toBeNull();
    expect(readCaptionBlock(r.querySelector('button')!)).toBeNull();
  });
});

describe('captionBlockOf', () => {
  it('maps a text node or any descendant to its block, and rejects the jump button', () => {
    const r = region(multiSpeaker);
    const blocks = readCaptionBlocks(r);
    const second = blocks[1]!.node;
    const textNode = second.querySelector('.ygicle')!.firstChild!;
    expect(captionBlockOf(textNode, r)).toBe(second);
    expect(captionBlockOf(second.querySelector('.NWpY1d')!, r)).toBe(second);
    expect(captionBlockOf(second, r)).toBe(second);
    expect(captionBlockOf(r.querySelector('button')!, r)).toBeNull();
    expect(captionBlockOf(r, r)).toBeNull();
  });

  it('works with the structural fallback too', () => {
    const r = region(rotated);
    const first = readCaptionBlocks(r)[0]!.node;
    expect(captionBlockOf(first.querySelector('.yyy999')!.firstChild!, r)).toBe(first);
    expect(captionBlockOf(r.querySelector('button')!, r)).toBeNull();
  });
});

describe('isSelfLabel', () => {
  it('recognises the local-user label in English and French only', () => {
    for (const name of ['You', 'you', ' Vous ', 'VOUS']) expect(isSelfLabel(name)).toBe(true);
    for (const name of ['Youssef', 'Camille Martin', 'Vousmet', '']) expect(isSelfLabel(name)).toBe(false);
  });
});

describe('isInCall', () => {
  it('is true on in-call pages and false before joining or after leaving', () => {
    expect(isInCall(parse(inCallOff))).toBe(true);
    expect(isInCall(parse(inCallOn))).toBe(true);
    expect(isInCall(parse(frenchUi))).toBe(true);
    expect(isInCall(parse(rotated))).toBe(true);
    expect(isInCall(parse(preJoin))).toBe(false);
    expect(isInCall(parse(callEnded))).toBe(false);
    expect(isInCall(parse(singleSpeaker))).toBe(false);
  });

  it('falls back from the jsname to the label, then to the call_end icon', () => {
    const doc = parse(inCallOff);
    const leave = doc.querySelector('[jsname="CQylAd"]')!;
    leave.removeAttribute('jsname');
    expect(isInCall(doc)).toBe(true);
    leave.removeAttribute('aria-label');
    leave.removeAttribute('data-tooltip');
    expect(isInCall(doc)).toBe(true);
    leave.remove();
    expect(isInCall(doc)).toBe(false);
  });
});

describe('callEndedScreen', () => {
  it("recognises Meet's post-call screen in English and French, and nothing else", () => {
    expect(callEndedScreen(parse(callEnded))).toBe(true);
    const french = parse(callEnded);
    french.querySelector('h1')!.textContent = 'Vous avez quitté la réunion';
    for (const b of french.querySelectorAll('button')) b.remove();
    expect(callEndedScreen(french)).toBe(true);
    const buttonOnly = parse(callEnded);
    buttonOnly.querySelector('h1')!.remove();
    buttonOnly.querySelector('button')!.textContent = 'Revenir à l’écran d’accueil';
    buttonOnly.querySelectorAll('button')[1]!.remove();
    expect(callEndedScreen(buttonOnly)).toBe(true);
    for (const html of [inCallOff, inCallOn, frenchUi, rotated, preJoin, singleSpeaker]) {
      expect(callEndedScreen(parse(html))).toBe(false);
    }
  });
});

describe('captionsEnabled', () => {
  it('reads the toggle state from the CC icon', () => {
    expect(captionsEnabled(parse(inCallOff))).toBe(false);
    expect(captionsEnabled(parse(inCallOn))).toBe(true);
    expect(captionsEnabled(parse(frenchUi))).toBe(true);
    expect(captionsEnabled(parse(rotated))).toBe(true);
    expect(captionsEnabled(parse(preJoin))).toBeNull();
  });

  it('falls back to aria-pressed, then to the English or French label', () => {
    const doc = parse(inCallOff);
    const cc = doc.querySelector('[jsname="RrG0hf"]')!;
    cc.querySelector('i')!.remove();
    expect(captionsEnabled(doc)).toBe(false);
    cc.setAttribute('aria-pressed', 'true');
    expect(captionsEnabled(doc)).toBe(true);
    cc.removeAttribute('aria-pressed');
    cc.setAttribute('aria-label', 'Désactiver les sous-titres');
    cc.removeAttribute('data-tooltip');
    expect(captionsEnabled(doc)).toBe(true);
    cc.setAttribute('aria-label', 'Activer les sous-titres');
    expect(captionsEnabled(doc)).toBe(false);
    cc.setAttribute('aria-label', 'Something else');
    expect(captionsEnabled(doc)).toBeNull();
  });

  it('never mistakes the jump-to-captions button in the region for the toggle', () => {
    const doc = parse(inCallOn);
    doc.querySelector('[role="region"] button')!.setAttribute('aria-label', 'Jump to the most recent captions');
    const cc = doc.querySelector('[jsname="RrG0hf"]')!;
    cc.removeAttribute('jsname');
    cc.querySelector('i')!.remove();
    expect(captionsEnabled(doc)).toBe(true);
    expect(adapterHealth(doc).captionsButton).toBe('label');
  });

  it('does not trust a jsname match that shows no caption icon or label', () => {
    const doc = parse(inCallOff);
    // A later build moves the old CC jsname onto the microphone toggle.
    const mic = doc.querySelector('[jsname="hw0c9"]')!;
    mic.setAttribute('jsname', 'r8qRAd');
    mic.setAttribute('aria-pressed', 'false');
    doc.querySelector('[jsname="RrG0hf"]')!.removeAttribute('jsname');
    expect(captionsEnabled(doc)).toBe(false);
    expect(adapterHealth(doc).captionsButton).toBe('icon');

    const noCc = parse(inCallOff);
    const mic2 = noCc.querySelector('[jsname="hw0c9"]')!;
    mic2.setAttribute('jsname', 'RrG0hf');
    mic2.setAttribute('aria-pressed', 'false');
    noCc.querySelector('[aria-label="Turn on captions"]')!.remove();
    expect(captionsEnabled(noCc)).toBeNull();
    expect(adapterHealth(noCc).captionsButton).toBeNull();
  });

  it('finds the pre-2026 toggle by its old jsname', () => {
    const doc = parse(inCallOff);
    const cc = doc.querySelector('[jsname="RrG0hf"]')!;
    cc.setAttribute('jsname', 'r8qRAd');
    cc.setAttribute('aria-label', 'Captions');
    cc.setAttribute('aria-pressed', 'false');
    cc.querySelector('i')!.remove();
    expect(captionsEnabled(doc)).toBe(false);
  });
});

describe('enableCaptions', () => {
  const clicks = (doc: Document) => {
    const seen: string[] = [];
    doc.addEventListener('click', (e) => seen.push((e.target as Element).getAttribute('aria-label') ?? '?'));
    return seen;
  };

  it('clicks the CC toggle (not caption settings) only when captions are off', () => {
    const doc = parse(inCallOff);
    const seen = clicks(doc);
    expect(enableCaptions(doc)).toBe(true);
    expect(seen).toEqual(['Turn on captions']);
  });

  it('does nothing when captions are already on, the state is unknown, or there is no toggle', () => {
    for (const html of [inCallOn, frenchUi, preJoin]) {
      const doc = parse(html);
      const seen = clicks(doc);
      expect(enableCaptions(doc)).toBe(false);
      expect(seen).toEqual([]);
    }
    const unknown = parse(inCallOff);
    const cc = unknown.querySelector('[jsname="RrG0hf"]')!;
    cc.querySelector('i')!.remove();
    cc.setAttribute('aria-label', 'Captions');
    cc.removeAttribute('data-tooltip');
    const seen = clicks(unknown);
    expect(enableCaptions(unknown)).toBe(false);
    expect(seen).toEqual([]);
  });

  it('never clicks a toggle that only aria-pressed says is off', () => {
    // The CC jsname landed on the microphone toggle (muted: aria-pressed="false").
    const doc = parse(inCallOff);
    const mic = doc.querySelector('[jsname="hw0c9"]')!;
    mic.setAttribute('jsname', 'RrG0hf');
    mic.setAttribute('aria-pressed', 'false');
    doc.querySelector('[aria-label="Turn on captions"]')!.removeAttribute('jsname');
    const seen = clicks(doc);
    expect(enableCaptions(doc)).toBe(true);
    expect(seen).toEqual(['Turn on captions']);

    const noCc = parse(inCallOff);
    const mic2 = noCc.querySelector('[jsname="hw0c9"]')!;
    mic2.setAttribute('jsname', 'RrG0hf');
    mic2.setAttribute('aria-pressed', 'false');
    noCc.querySelector('[aria-label="Turn on captions"]')!.remove();
    const seen2 = clicks(noCc);
    expect(enableCaptions(noCc)).toBe(false);
    expect(seen2).toEqual([]);
  });
});

describe('meetingTitle', () => {
  it('reads the title element, falling back to document.title', () => {
    expect(meetingTitle(parse(inCallOn))).toBe('Weekly product sync');
    expect(meetingTitle(parse(frenchUi))).toBe('Point hebdo produit');
    const doc = parse(inCallOn);
    doc.querySelector('[jsname="NeC6gb"]')!.remove();
    expect(meetingTitle(doc)).toBe('Weekly product sync');
    expect(meetingTitle(parse(rotated))).toBe('Wöchentlicher Produkt-Sync');
  });

  it('returns null when Meet only shows the meeting code or its own name', () => {
    expect(meetingTitle(parse(preJoin))).toBeNull();
    expect(meetingTitle(parse(callEnded))).toBeNull();
  });
});

describe('adapterHealth', () => {
  it('reports which hooks matched on the current Meet DOM', () => {
    expect(adapterHealth(parse(inCallOn))).toEqual({
      inCall: 'jsname',
      captionsButton: 'jsname',
      captionsState: 'icon',
      captionsOn: true,
      region: 'jsname',
      blockStrategy: 'class',
      blocks: 2,
      speaker: 'class',
      text: 'class',
      title: 'jsname',
    });
  });

  it('reports the fallbacks used on a rotated, unknown-language DOM', () => {
    expect(adapterHealth(parse(rotated))).toEqual({
      inCall: 'icon',
      captionsButton: 'icon',
      captionsState: 'icon',
      captionsOn: true,
      region: 'structure',
      blockStrategy: 'structure',
      blocks: 2,
      speaker: 'structure',
      text: 'structure',
      title: 'document',
    });
  });

  it('reports nulls on a page without a call', () => {
    expect(adapterHealth(parse(callEnded))).toMatchObject({
      inCall: null,
      captionsButton: null,
      captionsOn: null,
      region: null,
      blocks: 0,
      title: null,
    });
  });
});
