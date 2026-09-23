import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '@lib/ui/styles.css';
import type { SessionMeta, SpeakerInfo } from '@lib/types';
import {
  createPopupView,
  HERO_GUARD_MS,
  LOADING_DELAY_MS,
  type PopupHandlers,
  type PopupModel,
  type PopupState,
} from '@lib/ui/popupView';

const T0 = Date.UTC(2026, 8, 19, 8, 0, 0);
const TAB_ID = 7;
const SESSION_ID = 's1';
/** Where the popup keeps its pick for the browser session. */
const PROFILE_KEY = 'manet:popup-profile';
const FMT = { locale: 'en-GB', timeZone: 'UTC' };

function handlers() {
  const calls: string[] = [];
  const settle: { resolve: () => void; reject: (e: Error) => void }[] = [];
  const deferred = (name: string) =>
    new Promise<void>((resolve, reject) => {
      calls.push(name);
      settle.push({ resolve, reject });
    });
  const h: PopupHandlers = {
    record: (tabId, profileId) => deferred(`record:${tabId}:${profileId}`),
    stop: (id) => deferred(`stop:${id}`),
    setProfile: (id, profileId) => deferred(`setProfile:${id}:${profileId}`),
    goToCall: (tabId) => void calls.push(`goToCall:${tabId}`),
    grantMic: () => void calls.push('grantMic'),
    openSettings: () => void calls.push('openSettings'),
    openDashboard: () => void calls.push('openDashboard'),
    openNotion: (url) => void calls.push(`openNotion:${url}`),
  };
  return { calls, settle, handlers: h };
}

const speaker = (name: string, firstAt: number, lastAt: number, self = false): SpeakerInfo => ({
  name,
  self,
  firstAt,
  lastAt,
  talkMs: lastAt - firstAt,
});

const onCall: PopupState = { kind: 'idle', tabId: 7, meetCode: 'abc-defg-hij', title: 'Weekly sync' };

function recording(patch: Partial<Extract<PopupState, { kind: 'recording' }>> = {}): PopupState {
  return {
    kind: 'recording',
    sessionId: 's1',
    startedAt: T0,
    meetCode: 'abc-defg-hij',
    title: 'Weekly sync',
    thisTab: true,
    tabId: 7,
    micIncluded: true,
    lastChunkAt: T0 + 60_000,
    captionCount: 4,
    speakers: [speaker('Marie Curie', 1000, 50_000), speaker('Tom Martin', 3000, 60_000), speaker('You', 4000, 20_000, true)],
    ...patch,
  };
}

function model(patch: Partial<PopupModel> = {}): PopupModel {
  return {
    state: onCall,
    mic: 'granted',
    includeMic: true,
    setup: [],
    profiles: [
      { id: 'team', name: 'Team' },
      { id: 'personal', name: 'Personal' },
    ],
    defaultProfileId: 'team',
    geminiKeyMissing: false,
    recent: [],
    needsYou: 0,
    shortcut: 'Alt+Shift+R',
    ...patch,
  };
}

function meta(id: string, patch: Partial<SessionMeta>): SessionMeta {
  return {
    id,
    meetCode: 'abc-defg-hij',
    startedAt: T0 - 60 * 60_000,
    durationMs: 32 * 60_000,
    status: 'ready',
    route: 'team',
    profileId: 'team',
    idempotencyKey: 'abc-defg-hij-2026-09-19',
    audio: { mimeType: 'audio/webm;codecs=opus', chunkCount: 10, bytes: 1000, micIncluded: true },
    captionCount: 12,
    ...patch,
  };
}

let root: HTMLElement;
let time = 0;
const clock = () => time;

beforeEach(() => {
  time = 1_000_000;
  document.body.className = 'popup';
  root = document.createElement('div');
  root.className = 'popup-root';
  document.body.append(root);
});
afterEach(() => {
  root.remove();
  document.body.className = '';
  sessionStorage.removeItem(PROFILE_KEY);
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What is rendered (and read): innerText skips [hidden] and SVG titles, keeps visually hidden text. */
const text = (el: Element | null | undefined) =>
  (el instanceof HTMLElement ? el.innerText : el?.textContent)?.replace(/\s+/g, ' ').trim() ?? '';
const button = (label: string | RegExp) =>
  [...root.querySelectorAll('button')].find((b) => (typeof label === 'string' ? text(b) === label : label.test(text(b))));
const hero = () => root.querySelector<HTMLButtonElement>('[data-role="hero"] button')!;
const fact = (name: 'speakers' | 'audio') => root.querySelector<HTMLElement>(`[data-fact="${name}"]`);
const view = (h = handlers().handlers) => createPopupView(root, h, { format: FMT, clock });

describe('popup: loading and focus', () => {
  it('paints the footer at once and says it is checking only after 300 ms', async () => {
    view();
    expect(button('Meetings')).toBeDefined();
    expect(button('Settings')).toBeDefined();
    expect(text(root)).not.toMatch(/Checking/);
    await sleep(LOADING_DELAY_MS + 50);
    expect(text(root.querySelector('[data-role="state"]'))).toBe('Checking this tab…');
  });

  it('never shows the loading line when the state arrives quickly', async () => {
    view().update(model(), T0);
    await sleep(LOADING_DELAY_MS + 50);
    expect(text(root)).not.toMatch(/Checking/);
  });

  it('focuses nothing, so Enter can never start or stop a recording', () => {
    const v = view();
    v.update(model(), T0);
    expect(document.activeElement).toBe(document.body);
    v.update(model({ state: recording() }), T0 + 60_000);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('popup: the states', () => {
  it('away from a call: says what to do, no button', () => {
    const v = view();
    v.update(model({ state: { kind: 'not-meet', onMeet: false } }), T0);
    expect(text(root.querySelector('h1'))).toBe('No call in this tab');
    expect(text(root.querySelector('[data-role="state"]'))).toContain('Open a Google Meet call to record it.');
    expect(root.querySelector<HTMLElement>('[data-role="hero"]')!.hidden).toBe(true);
    v.update(model({ state: { kind: 'not-meet', onMeet: true } }), T0);
    expect(text(root.querySelector('[data-role="state"]'))).toContain('Join the call to record it.');
  });

  it('on a call: the title, the facts and one navy button', () => {
    view().update(model({ state: onCall }), T0);
    expect(text(root.querySelector('h1'))).toBe('Weekly sync');
    expect(text(root.querySelector('.state-sub'))).toBe('Meet call abc-defg-hij');
    expect(text(fact('speakers'))).toBe('From Meet’s captions Captions turn on when you record.');
    expect(text(fact('audio'))).toBe('Call and your mic');
    expect(hero().classList.contains('prominent')).toBe(true);
    expect(text(hero())).toBe('Record this call');
    expect(text(root.querySelector('.hero-hint'))).toBe('Let everyone know you’re recording. Shortcut: Alt+Shift+R');
    expect(hero().getAttribute('aria-keyshortcuts')).toBe('Alt+Shift+R');
  });

  it('omits the shortcut when none is set', () => {
    view().update(model({ shortcut: null }), T0);
    expect(root.querySelector('kbd')).toBeNull();
    expect(hero().hasAttribute('aria-keyshortcuts')).toBe(false);
  });

  it('recording: the red headline, a silent timer and Stop', () => {
    const v = view();
    v.update(model({ state: recording() }), T0 + 65_000);
    const headline = root.querySelector('h1')!;
    expect(text(headline)).toBe('Recording');
    expect(headline.classList.contains('is-live')).toBe(true);
    const timer = root.querySelector('[role="timer"]')!;
    expect(text(timer)).toBe('01:05');
    expect(timer.getAttribute('aria-live')).toBe('off');
    expect(text(root.querySelector('.state-sub'))).toBe('Weekly sync · abc-defg-hij');
    expect(hero().classList.contains('live')).toBe(true);
    expect(text(hero())).toBe('Stop recording');
    expect(text(root.querySelector('.hero-hint'))).toContain('You’ll choose Team or Personal next.');

    // A clock tick touches only the clock: Stop is the same element, the sub line too.
    const stop = hero();
    const sub = root.querySelector('.state-sub');
    v.update(model({ state: recording() }), T0 + 3_725_000);
    expect(text(timer)).toBe('1:02:05');
    expect(hero()).toBe(stop);
    expect(root.querySelector('.state-sub')).toBe(sub);
  });

  it('recording in another tab: says so, with Go to call', () => {
    const h = handlers();
    view(h.handlers).update(model({ state: recording({ thisTab: false }) }), T0 + 60_000);
    expect(text(root.querySelector('.state-sub-text'))).toBe('Weekly sync · in another tab');
    button('Go to call')!.click();
    expect(h.calls).toEqual(['goToCall:7']);
    expect(text(hero())).toBe('Stop recording');
  });
});

describe('popup: Record and Stop', () => {
  it('keeps focus on Record while it reads Starting…, then reports a failure', async () => {
    const h = handlers();
    view(h.handlers).update(model(), T0);
    const record = hero();
    record.focus();
    record.click();
    expect(h.calls).toEqual(['record:7:team']);
    expect(text(record)).toBe('Starting…');
    expect(record.getAttribute('aria-disabled')).toBe('true');
    expect(record.disabled).toBe(false);
    expect(document.activeElement).toBe(record);
    record.click(); // pending: ignored
    expect(h.calls).toEqual(['record:7:team']);

    h.settle[0]!.reject(new Error('Another tab is already recording.'));
    await flush();
    const alert = root.querySelector('[role="alert"]')!;
    expect(text(alert)).toBe('Couldn’t start recording: Another tab is already recording.');
    expect(alert.querySelector('svg.glyph-caution')).not.toBeNull();
    expect(text(record)).toBe('Record this call');
    expect(record.hasAttribute('aria-disabled')).toBe(false);
    expect(document.activeElement).toBe(record);
  });

  it('turns Record into Stop in place, and ignores clicks for 800 ms after', async () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model(), T0);
    const record = hero();
    record.focus();
    record.click();
    v.update(model({ state: recording({ startedAt: T0, speakers: [], captionCount: 0 }) }), T0 + 1000);
    h.settle[0]!.resolve();
    await flush();

    expect(hero()).toBe(record);
    expect(document.activeElement).toBe(record);
    expect(text(record)).toBe('Stop recording');
    expect(record.classList.contains('live')).toBe(true);
    expect(record.classList.contains('prominent')).toBe(false);

    // The impatient double click.
    time += HERO_GUARD_MS - 1;
    record.click();
    expect(h.calls).toEqual(['record:7:team']);
    time += 1;
    record.click();
    expect(h.calls).toEqual(['record:7:team', 'stop:s1']);
    expect(text(record)).toBe('Stopping…');
  });

  it('after Stop, says where the choice happens and guards the Record that appears', async () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ state: recording() }), T0 + 60_000);
    hero().click();
    h.settle[0]!.resolve();
    await flush();
    v.update(model({ state: onCall }), T0 + 61_000);
    expect(text(root.querySelector('[data-role="stopped"]'))).toBe('Stopped. Choose Team or Personal in the window that opened.');
    expect(text(hero())).toBe('Record this call');
    hero().click();
    expect(h.calls).toEqual(['stop:s1']);
    time += HERO_GUARD_MS;
    hero().click();
    expect(h.calls).toEqual(['stop:s1', 'record:7:team']);
    expect(root.querySelector('[data-role="stopped"]')).toBeNull();
  });

  it('announces the change of state, not every update', () => {
    const v = view();
    const status = root.querySelector('[data-role="announce"]')!;
    expect(status.getAttribute('role')).toBe('status');
    v.update(model(), T0);
    expect(text(status)).toBe('');
    v.update(model({ state: recording() }), T0 + 60_000);
    expect(text(status)).toBe('Recording');
    v.update(model({ state: recording() }), T0 + 61_000);
    expect(text(status)).toBe('Recording');
    v.update(model(), T0 + 62_000);
    expect(text(status)).toBe('Recording stopped');
  });
});

describe('popup: the Profile row', () => {
  const profiles = [
    { id: 'team', name: 'Team' },
    { id: 'client', name: 'Client meeting' },
  ];
  const profile = () => root.querySelector<HTMLButtonElement>('[data-key="profile"]');
  const menu = () => root.querySelector<HTMLElement>('.menu')!;
  const choose = (id: string) => document.querySelector<HTMLElement>(`[data-key="profile-${id}"]`)!.click();
  const checked = () => [...menu().querySelectorAll('[aria-checked="true"]')].map((el) => text(el));

  it('records with the profile picked in the popup', () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ state: onCall, profiles, defaultProfileId: 'team' }), T0);
    const row = profile()!;
    expect(row.textContent).toBe('Team');
    expect(text(row.closest('[data-role="profile"]'))).toBe('Profile Team');
    row.click();
    expect(checked()).toEqual(['Team']);
    choose('client');
    v.update(model({ state: onCall, profiles, defaultProfileId: 'team' }), T0 + 1000);
    expect(profile()!.textContent).toBe('Client meeting');
    root.querySelector<HTMLButtonElement>('[data-key="record"]')!.click();
    expect(h.calls).toEqual([`record:${TAB_ID}:client`]);
  });

  it('changes the profile of the recording', () => {
    const h = handlers();
    view(h.handlers).update(model({ state: recording({ profileId: 'team' }), profiles, defaultProfileId: 'team' }), T0 + 60_000);
    profile()!.click();
    choose('client');
    expect(h.calls).toEqual([`setProfile:${SESSION_ID}:client`]);
  });

  it('hides the row when there is only one profile, or no call', () => {
    const v = view();
    v.update(model({ state: onCall, profiles: [profiles[0]!], defaultProfileId: 'team' }), T0);
    expect(profile()).toBeNull();
    v.update(model({ state: { kind: 'not-meet', onMeet: true }, profiles }), T0);
    expect(profile()).toBeNull();
    v.update(model({ state: onCall, profiles }), T0);
    expect(profile()).not.toBeNull();
  });

  it('sits right above the hero, one line tall, and stays put from Record to Stop', () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ state: onCall, profiles }), T0);
    const row = root.querySelector<HTMLElement>('[data-role="profile"]')!;
    const button = profile()!;
    expect(row.nextElementSibling).toBe(root.querySelector('[data-role="hero"]'));
    const dd = row.querySelector('dd')!;
    const lineHeight = parseFloat(getComputedStyle(dd).lineHeight);
    expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight + 0.5);
    // Its label lines up with the facts' labels in the card above.
    const factLabel = root.querySelector('[data-role="state"] dt')!.getBoundingClientRect();
    expect(row.querySelector('dt')!.getBoundingClientRect().left).toBeCloseTo(factLabel.left, 0);
    const heroTop = hero().getBoundingClientRect().top;

    hero().click();
    // Starting…: nothing above the hero moves.
    expect(hero().getBoundingClientRect().top).toBe(heroTop);
    v.update(model({ state: recording({ profileId: 'team' }), profiles }), T0 + 1000);
    expect(profile()).toBe(button);
    expect(root.querySelector('[data-role="profile"]')).toBe(row);
    expect(text(button)).toBe('Team');
  });

  it('shows the recording’s own profile, whatever the popup had picked', () => {
    const v = view();
    v.update(model({ state: onCall, profiles }), T0);
    profile()!.click();
    choose('client');
    // Recorded with the shortcut: the default profile.
    v.update(model({ state: recording({ profileId: 'team' }), profiles }), T0 + 60_000);
    expect(profile()!.textContent).toBe('Team');
    profile()!.click();
    expect(checked()).toEqual(['Team']);
  });

  it('closes the menu on a choice and puts focus back on the Profile button', () => {
    view().update(model({ state: onCall, profiles }), T0);
    const button = profile()!;
    button.focus();
    button.click();
    expect(menu().matches(':popover-open')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    choose('client');
    expect(menu().matches(':popover-open')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('Profile: Client meeting');
  });

  it('shows a failed change in the hero’s error line, and leaves Stop alone meanwhile', async () => {
    const h = handlers();
    view(h.handlers).update(model({ state: recording({ profileId: 'team' }), profiles }), T0 + 60_000);
    const button = profile()!;
    const stop = hero();
    button.click();
    choose('client');
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(stop.hasAttribute('aria-disabled')).toBe(false);
    button.click(); // pending: no second menu
    expect(menu().matches(':popover-open')).toBe(false);

    h.settle[0]!.reject(new Error('That profile no longer exists. Reload the page and choose another.'));
    await flush();
    expect(text(root.querySelector('[role="alert"]'))).toBe(
      'Couldn’t change the profile: That profile no longer exists. Reload the page and choose another.',
    );
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(hero()).toBe(stop);
  });

  it('leaves an open menu alone on a clock tick, and closes it when the profiles change', () => {
    const v = view();
    v.update(model({ state: recording({ profileId: 'team' }), profiles }), T0 + 60_000);
    const button = profile()!;
    button.focus();
    button.click();
    v.update(model({ state: recording({ profileId: 'team' }), profiles }), T0 + 61_000);
    expect(menu().matches(':popover-open')).toBe(true);
    v.update(model({ state: recording({ profileId: 'team' }), profiles: [...profiles, { id: 'x', name: 'Board' }] }), T0 + 62_000);
    expect(menu().matches(':popover-open')).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it('keeps the pick for the next popup, and forgets a profile deleted since', () => {
    view().update(model({ state: onCall, profiles }), T0);
    profile()!.click();
    choose('client');
    expect(sessionStorage.getItem(PROFILE_KEY)).toBe('client');

    // The popup opens again.
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ state: onCall, profiles }), T0);
    expect(profile()!.textContent).toBe('Client meeting');

    // Client meeting was deleted in Settings: back to the default.
    v.update(model({ state: onCall, profiles: [profiles[0]!, { id: 'personal', name: 'Personal' }] }), T0);
    expect(profile()!.textContent).toBe('Team');
    hero().click();
    expect(h.calls).toEqual([`record:${TAB_ID}:team`]);
  });
});

describe('popup: the roll', () => {
  it('shows the names in order, "You" for yourself, the speaker marked by colour and underline only', () => {
    view().update(model({ state: recording() }), T0 + 62_000);
    const roll = root.querySelector('[data-role="roll"]')!;
    expect(roll.getAttribute('aria-live')).toBe('off');
    const names = [...roll.querySelectorAll('.roll-name')].map((n) => n.textContent);
    expect(names).toEqual(['Marie Curie', 'Tom Martin', 'You']);
    const speaking = roll.querySelectorAll('.roll-name.is-speaking');
    expect([...speaking].map((n) => n.textContent)).toEqual(['Tom Martin']);
    expect(text(roll)).toBe('Marie Curie · Tom Martin (speaking) · You');
    const style = getComputedStyle(speaking[0]!);
    expect(style.textDecorationLine).toBe('underline');
    expect(style.fontWeight).toBe(getComputedStyle(roll.querySelector('.roll-name:not(.is-speaking)')!).fontWeight);
  });

  it('patches names by key: a new name fades in, nobody else is rebuilt or moves', () => {
    const v = view();
    const first = recording();
    v.update(model({ state: first }), T0 + 62_000);
    const roll = root.querySelector('[data-role="roll"]')!;
    const before = [...roll.querySelectorAll('.roll-item')];
    expect(before.some((el) => el.classList.contains('is-new'))).toBe(false);
    const width = roll.getBoundingClientRect().width;
    const marieLeft = before[0]!.getBoundingClientRect().left;

    // Marie speaks now: only the marking moves.
    const speakers = (first as Extract<PopupState, { kind: 'recording' }>).speakers!;
    const marieSpeaks = speakers.map((s) => (s.name === 'Marie Curie' ? { ...s, lastAt: 63_000 } : s));
    v.update(model({ state: recording({ speakers: marieSpeaks }) }), T0 + 64_000);
    const after = [...roll.querySelectorAll('.roll-item')];
    expect(after).toEqual(before);
    expect(text(roll.querySelector('.is-speaking'))).toBe('Marie Curie');
    expect(roll.getBoundingClientRect().width).toBe(width);
    expect(after[0]!.getBoundingClientRect().left).toBe(marieLeft);

    // Someone new.
    v.update(model({ state: recording({ speakers: [...marieSpeaks, speaker('Sofia', 64_000, 65_000)] }) }), T0 + 66_000);
    const withSofia = [...roll.querySelectorAll('.roll-item')];
    expect(withSofia.slice(0, 3)).toEqual(before);
    expect(withSofia[3]!.classList.contains('is-new')).toBe(true);
  });

  it('keeps to two lines, then "+N more", with every name still there for screen readers', () => {
    const many = [
      'Marie Curie',
      'Tom Martin',
      'Jean-Baptiste Delacroix',
      'Sofia Oliveira',
      'Camille Martin',
      'Yasser Amrani',
      'Ilya Kaplan',
      'Priya Raman',
      'Olumide Adeyemi',
    ].map((n, i) => speaker(n, i * 1000, i * 1000 + 500));
    view().update(model({ state: recording({ speakers: many }) }), T0 + 62_000);
    const roll = root.querySelector<HTMLElement>('[data-role="roll"]')!;
    const lineHeight = parseFloat(getComputedStyle(roll).lineHeight);
    expect(roll.getBoundingClientRect().height).toBeLessThanOrEqual(lineHeight * 2 + 1);
    const more = roll.querySelector<HTMLElement>('.roll-more')!;
    expect(more.hidden).toBe(false);
    const hidden = roll.querySelectorAll('.roll-item.visually-hidden').length;
    expect(hidden).toBeGreaterThan(0);
    expect(text(more)).toBe(`+${hidden} more`);
    expect(roll.querySelectorAll('.roll-name')).toHaveLength(9);
  });

  it('asks to turn captions on 20 s in, with ▲, without rebuilding Stop', () => {
    const v = view();
    const quiet = recording({ speakers: [], captionCount: 0 });
    v.update(model({ state: quiet }), T0 + 10_000);
    expect(text(fact('speakers'))).toBe('None yet Names appear here as Meet’s captions show them.');
    const stop = hero();
    v.update(model({ state: quiet }), T0 + 21_000);
    const dd = fact('speakers')!;
    expect(dd.classList.contains('is-caution')).toBe(true);
    expect(dd.querySelector('svg.glyph-caution')).not.toBeNull();
    expect(text(dd)).toBe('None yet — turn on captions (CC) in Meet Without captions, the transcript can’t name who spoke.');
    expect(hero()).toBe(stop);
  });

  it('warns under the roll when captions went quiet for 5 min', () => {
    const v = view();
    v.update(model({ state: recording() }), T0 + 60_000 + 6 * 60_000);
    const dd = fact('speakers')!;
    expect(dd.querySelector('[data-role="roll"]')).not.toBeNull();
    const warning = dd.querySelector('.fact-warning')!;
    expect(text(warning)).toBe('No captions for 6 min');
    expect(warning.querySelector('svg.glyph-caution')).not.toBeNull();
    // Set like every other caution value: the fact list's own words (15 px), a 14 px ▲.
    expect(getComputedStyle(warning).fontSize).toBe(getComputedStyle(dd.querySelector('.fact-value')!).fontSize);
    expect(getComputedStyle(warning).fontSize).toBe('15px');
    expect(warning.querySelector('svg')!.getBoundingClientRect().width).toBeCloseTo(14, 0);
    expect(text(dd.querySelector('.fact-warning-detail'))).toBe('If people are talking, check that captions (CC) are on in Meet.');
  });
});

describe('popup: facts, setup and links', () => {
  it('offers the mic page when Chrome has not allowed the mic', () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ mic: 'prompt' }), T0);
    expect(text(fact('audio'))).toContain('Your mic isn’t allowed yet');
    button('Allow microphone…')!.click();
    v.update(model({ mic: 'denied' }), T0);
    button('Fix in Chrome…')!.click();
    expect(h.calls).toEqual(['grantMic', 'grantMic']);
    v.update(model({ mic: 'granted' }), T0);
    expect(button(/Allow microphone|Fix in Chrome/)).toBeUndefined();
  });

  it('puts Allow microphone… on its own line, so its focus ring clears the sentence above', () => {
    document.body.style.width = '360px';
    try {
      view().update(model({ mic: 'prompt' }), T0);
      const link = root.querySelector<HTMLElement>('[data-key="grant-mic"]')!;
      expect(getComputedStyle(link).display).toBe('block');
      const sentence = document.createRange();
      sentence.setStart(link.parentElement!.firstChild!, 0);
      sentence.setEndBefore(link);
      const rects = [...sentence.getClientRects()].filter((r) => r.height > 0);
      const textBottom = Math.max(...rects.map((r) => r.bottom));
      link.focus();
      const ring = getComputedStyle(link);
      const reach = parseFloat(ring.outlineOffset) + parseFloat(ring.outlineWidth);
      expect(reach).toBeGreaterThan(0);
      expect(link.getBoundingClientRect().top - reach).toBeGreaterThanOrEqual(textBottom - 0.5);
    } finally {
      document.body.style.width = '';
    }
  });

  it('collapses setup into one block: the ▲ callout when saving is blocked, else the Gemini note', () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ setup: ['name', 'token', 'database'], geminiKeyMissing: true }), T0);
    const missing = root.querySelector('[data-role="missing"]')!;
    expect(text(missing)).toBe(
      'Meetings can’t be saved to Notion yet Add your name, a Notion token and the Team profile’s database. Open settings',
    );
    expect(missing.querySelector('svg.glyph-caution')).not.toBeNull();
    expect(root.querySelector('[data-role="no-gemini"]')).toBeNull();
    button('Open settings')!.click();

    v.update(model({ geminiKeyMissing: true }), T0);
    expect(root.querySelector('[data-role="missing"]')).toBeNull();
    expect(text(root.querySelector('[data-role="no-gemini"]'))).toBe(
      'No Gemini key: transcripts will come from Meet’s captions only. Add key',
    );
    button('Add key')!.click();
    expect(h.calls).toEqual(['openSettings', 'openSettings']);

    // Mid-call, the popup is about the recording.
    v.update(model({ state: recording(), setup: ['token'], geminiKeyMissing: true }), T0 + 60_000);
    expect(root.querySelector('[data-role="missing"], [data-role="no-gemini"]')).toBeNull();
  });

  it('lists the last 3 meetings when not on a call: title (+ Open in Notion) / status · details', () => {
    const h = handlers();
    const v = view(h.handlers);
    const recent = [
      meta('a', { status: 'saved', meetingTitle: 'Weekly product sync', notion: { pageId: 'p', url: 'https://notion.so/p' } }),
      meta('b', { status: 'processing', stage: 'summarizing', meetingTitle: 'Design review' }),
      meta('c', { status: 'failed', retryAt: T0 + 30 * 60_000 }),
      meta('d', { status: 'ready', meetingTitle: 'Fourth' }),
    ];
    v.update(model({ state: { kind: 'not-meet', onMeet: false }, recent }), T0);
    const rows = [...root.querySelectorAll('[data-role="recent"] li')];
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['a', 'b', 'c']);
    expect(text(rows[0])).toBe('Weekly product sync Open in Notion Saved to Notion · Today 07:00 · 32 min · Team');
    expect(text(rows[1])).toBe('Design review Summarizing · Step 7 of 8 · Today 07:00');
    expect(text(rows[2])).toBe('abc-defg-hij Couldn’t transcribe · Trying again at 08:30 · Today 07:00');
    expect(rows[2]!.querySelector('svg.glyph-caution')).not.toBeNull();
    // Every row says its status in words, so the glyph is decoration.
    for (const row of rows) {
      expect(row.querySelector('.recent-status')!.textContent).not.toBe('');
      expect(row.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    }
    button('Open in Notion')!.click();
    expect(h.calls).toEqual(['openNotion:https://notion.so/p']);

    v.update(model({ state: { kind: 'not-meet', onMeet: true }, recent }), T0);
    expect(root.querySelectorAll('[data-role="recent"] li')).toHaveLength(3);
    // On a call the popup is about recording it (and has to fit Chrome's 600 px).
    v.update(model({ state: onCall, recent }), T0);
    expect(root.querySelector('[data-role="recent"]')).toBeNull();
    v.update(model({ state: recording(), recent }), T0 + 60_000);
    expect(root.querySelector('[data-role="recent"]')).toBeNull();
  });

  it('keeps each Recent row to two lines: details that don’t fit drop out whole, from the end', () => {
    document.body.style.width = '360px';
    try {
      view().update(
        model({
          state: { kind: 'not-meet', onMeet: false },
          recent: [
            meta('long', { status: 'processed', meetingTitle: 'Sales pipeline review', startedAt: T0 - 3 * 86_400_000 }),
            meta('short', { status: 'empty', meetingTitle: 'Standup' }),
          ],
        }),
        T0,
      );
      for (const line of root.querySelectorAll<HTMLElement>('.recent-meta')) {
        const box = line.getBoundingClientRect();
        expect(box.height).toBeCloseTo(parseFloat(getComputedStyle(line).lineHeight), 0);
        const status = line.querySelector('.recent-status')!.getBoundingClientRect();
        expect(status.top).toBeCloseTo(box.top, 0);
        for (const item of line.querySelectorAll('.recent-detail')) {
          const r = item.getBoundingClientRect();
          // On the line, whole; or on the clipped line below. Never cut in half.
          if (r.top < box.bottom) expect(r.right).toBeLessThanOrEqual(box.right + 0.5);
          else expect(r.top).toBeGreaterThanOrEqual(box.bottom - 0.5);
        }
      }
      // The long one lost its tail but kept when; every word is still in the text.
      const long = root.querySelector<HTMLElement>('[data-id="long"] .recent-meta')!;
      expect(long.textContent).toBe('Transcribed, not saved yet · Wed\u00a016\u00a0Sep\u00a008:00 · 32 min · Team');
      const shown = [...long.querySelectorAll('.recent-detail')].filter(
        (d) => d.getBoundingClientRect().top < long.getBoundingClientRect().bottom,
      );
      expect(shown.map((d) => d.textContent)).toContain(' · Wed\u00a016\u00a0Sep\u00a008:00');
      expect(shown.length).toBeLessThan(3);
    } finally {
      document.body.style.width = '';
    }
  });

  it('links to Meetings, with how many need you, and to Settings', () => {
    const h = handlers();
    const v = view(h.handlers);
    v.update(model({ needsYou: 1 }), T0);
    button('Meetings · 1 needs you')!.click();
    button('Settings')!.click();
    expect(h.calls).toEqual(['openDashboard', 'openSettings']);
    v.update(model({ needsYou: 0 }), T0);
    expect(button('Meetings')).toBeDefined();
  });

  it('stays inside Chrome’s 600 px: the body scrolls, the footer stays in view', () => {
    document.documentElement.style.fontSize = '150%';
    document.body.style.width = '360px';
    document.body.style.minHeight = '0'; // the test runner's page sets 100vh; Chrome's popup doesn't
    try {
      view().update(
        model({
          state: { ...onCall, title: 'Onboarding — Lumind × Nova: pricing, pilots and the Q4 roadmap review' },
          mic: 'denied',
          setup: ['name', 'token', 'database'],
        }),
        T0,
      );
      const body = document.body;
      expect(body.clientHeight).toBeLessThanOrEqual(600);
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth);
      const foot = () => root.querySelector('.popup-foot')!.getBoundingClientRect();
      const bottom = () => Math.min(body.getBoundingClientRect().bottom, window.innerHeight);
      body.scrollTop = 0;
      expect(foot().bottom).toBeLessThanOrEqual(bottom() + 0.5);
      body.scrollTop = body.scrollHeight;
      expect(foot().bottom).toBeLessThanOrEqual(bottom() + 0.5);
    } finally {
      document.documentElement.style.fontSize = '';
      document.body.style.width = '';
      document.body.style.minHeight = '';
      document.body.scrollTop = 0;
    }
  });

  /* The toolbar is sticky, so scroll-padding-block-end has to clear it — and the bar is
   * taller than --bar-h once its label wraps at Chrome's larger font sizes. */
  it('never parks a focused control under the sticky toolbar at 150% text', () => {
    document.documentElement.style.fontSize = '150%';
    document.body.style.width = '360px';
    document.body.style.minHeight = '0';
    try {
      view().update(
        model({
          state: { ...onCall, title: 'Onboarding — Lumind × Nova: pricing, pilots and the Q4 roadmap review' },
          mic: 'denied',
          setup: ['name', 'token', 'database'],
          needsYou: 3, // the label wraps at 150%, so the bar is taller than --bar-h
        }),
        T0,
      );
      const foot = root.querySelector('.popup-foot')!;
      // The reserve has to cover the bar as rendered, not the 52 px it is at rest.
      const pad = parseFloat(getComputedStyle(document.body).scrollPaddingBlockEnd);
      expect(pad).toBeGreaterThanOrEqual(foot.getBoundingClientRect().height);
      const controls = [...root.querySelectorAll<HTMLElement>('button, a[href]')].filter((el) => !el.closest('.popup-foot'));
      expect(controls.length).toBeGreaterThan(0);
      for (const el of controls) {
        document.body.scrollTop = 0;
        el.focus();
        expect(el.getBoundingClientRect().bottom).toBeLessThanOrEqual(foot.getBoundingClientRect().top + 0.5);
      }
    } finally {
      document.documentElement.style.fontSize = '';
      document.body.style.width = '';
      document.body.style.minHeight = '';
      document.body.scrollTop = 0;
    }
  });

  it('fits 360 px without sideways scrolling, whatever the title and names', () => {
    document.body.style.width = '360px';
    root.style.width = '360px';
    try {
      view().update(
        model({
          state: recording({
            title: 'Onboarding — Lumind × Nova: pricing, pilots and the Q4 roadmap review with the whole team',
            speakers: [speaker('Jean-Baptiste Delacroix-Montmorency de la Tour', 0, 1000), speaker('Supercalifragilisticexpialidocious', 2000, 3000)],
          }),
          recent: [meta('x', { meetingTitle: 'A very long meeting title that goes on and on and on', status: 'processed' })],
        }),
        T0 + 62_000,
      );
      expect(root.scrollWidth).toBeLessThanOrEqual(360);
    } finally {
      document.body.style.width = '';
    }
  });
});
