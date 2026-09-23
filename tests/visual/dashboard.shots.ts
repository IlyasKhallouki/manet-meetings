/**
 * The Meetings page in every state of the direction's wireframes: Needs you + day groups,
 * each status, inline confirms, the ⋯ menu (and its flip at the viewport bottom), the
 * profile menu, empty, setup blocked, large text, keyboard focus. Light and dark, 390 → 1280 px.
 */
import type { SessionMeta } from '@lib/types';
import { createDashboardView, type DashboardData, type DashboardView } from '@lib/ui/dashboardView';
import dashboardHtml from '../../entrypoints/dashboard/index.html?raw';
import { MEETINGS, MEETING_RESULTS, PROFILES } from '../ui/dashboardFixtures';
import { FMT, gallery, ok, shell, type Shot } from './harness';
import { NOW } from './scenarios';

let current: DashboardView | null = null;

/**
 * The meeting waiting on a destination carries the routing prompt's countdown, as the
 * background writes it (SessionMeta.routeDeadline).
 */
const WITH_DEADLINE: SessionMeta[] = MEETINGS.map((s) =>
  s.id === 'route' ? { ...s, routeDeadline: NOW + 94_000 } : s,
);

interface Options {
  data?: Partial<DashboardData>;
  /** Root font size, to stand in for Chrome's text size setting. */
  fontSize?: string;
  after?: (root: HTMLElement) => void;
  full?: boolean;
  height?: number;
}

function dashboard(name: string, width: number, o: Options = {}): Shot {
  return {
    name: `dashboard-${name}`,
    width,
    height: o.height ?? 860,
    full: o.full ?? true,
    render() {
      current?.destroy();
      document.documentElement.style.fontSize = o.fontSize ?? '';
      const root = shell(dashboardHtml);
      current = createDashboardView(
        root,
        { stop: ok, transcribe: ok, save: ok, remove: ok, setProfile: ok, setAutoTranscribe: ok, openSettings: () => {} },
        FMT,
      );
      current.update({
        sessions: WITH_DEADLINE,
        resultIds: MEETING_RESULTS,
        audioOnDisk: new Map(MEETINGS.map((s) => [s.id, s.audio.bytes])),
        missing: [],
        geminiKeyMissing: false,
        profiles: PROFILES,
        defaultProfileId: 'team',
        autoTranscribe: true,
        retentionDays: 7,
        now: NOW,
        ...o.data,
      });
      o.after?.(root);
      // Opening a menu or an inline confirm scrolls the page, and the floating bar reads
      // the scroll: a full-page shot is of the page as you land on it, so every one of
      // them ends back at the top. The bar carrying its material is a state of its own,
      // shot once by `dashboard-scrolled`.
      if (o.full ?? true) window.scrollTo(0, 0);
      // The quality floor, checked, not assumed: nothing scrolls sideways.
      const doc = document.documentElement;
      if (doc.scrollWidth > doc.clientWidth) throw new Error(`Horizontal overflow at ${width}px: ${doc.scrollWidth}`);
    },
  };
}

const MIN = 60_000;
/** The first five meetings, the recording changed by `patch`. */
const recordingWith = (patch: (s: SessionMeta) => Partial<SessionMeta>) =>
  WITH_DEADLINE.map((s) => (s.id === 'rec' ? { ...s, ...patch(s) } : s)).slice(0, 5);
/** Call audio lost, and captions blocked in the tab. */
const LOST = recordingWith((s) => ({
  audio: { ...s.audio, error: 'Tab audio capture failed' },
  captionsError: 'Captions are not reaching Manet from this tab. Reload the Meet tab to capture who said what.',
}));
/** No chunk for 20 s; the last caption 6 min ago. */
const STALLED = recordingWith((s) => ({
  audio: { ...s.audio, lastChunkAt: NOW - 20_000 },
  speakers: s.speakers!.map((p) => ({ ...p, lastAt: p.lastAt - 7 * MIN })),
}));
/** 40 s in, audio flowing, but no caption at all: CC is off. */
const NO_CAPTIONS = recordingWith((s) => ({
  startedAt: NOW - 40_000,
  audio: { ...s.audio, bytes: 0.6 * 1024 * 1024, chunkCount: 8, lastChunkAt: NOW - 2000 },
  captionCount: 0,
  speakers: [],
}));

const click = (root: HTMLElement, key: string) => root.querySelector<HTMLElement>(`[data-key="${key}"]`)!.click();
/** Opens the ⋯ menu the way a pointer does (the menu takes focus, nothing highlighted). */
const pointerOpen = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-key="${id}:more"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
const menuItem = (root: HTMLElement, kind: string) => root.querySelector<HTMLElement>(`[role="menu"] [data-key="menu:${kind}"]`)!;

gallery('dashboard', [
  dashboard('wide', 1280),
  dashboard('medium', 900),
  dashboard('edge-930', 930),
  dashboard('edge-920', 920),
  dashboard('narrow', 390),
  // Content under the glass bar: the material, its hairline and the compact title arrive.
  dashboard('scrolled', 1280, { full: false, height: 800, after: () => window.scrollTo(0, 360) }),
  dashboard('menu', 1280, {
    // Keyboard-opened: the first item is highlighted.
    after: (root) => click(root, 'dup:more'),
  }),
  dashboard('menu-disabled', 1280, { after: (root) => pointerOpen(root, 'proc') }),
  dashboard('menu-flip', 390, {
    // A ⋯ near the bottom of a short window: the menu opens above its button.
    full: false,
    height: 700,
    after: (root) => click(root, 'processed:more'),
  }),
  dashboard('confirm', 1280, {
    after: (root) => {
      click(root, 'saved:more');
      menuItem(root, 'delete').click();
      click(root, 'dup:more');
      menuItem(root, 'second-copy').click();
    },
  }),
  dashboard('confirm-narrow', 390, {
    after: (root) => {
      click(root, 'saved:more');
      menuItem(root, 'delete').click();
      click(root, 'rec:more');
      menuItem(root, 'delete').click();
    },
  }),
  dashboard('problems', 1280, { data: { sessions: LOST } }),
  dashboard('problems-narrow', 390, { data: { sessions: LOST } }),
  dashboard('problems-stalled', 1280, { data: { sessions: STALLED } }),
  dashboard('problems-stalled-narrow', 390, { data: { sessions: STALLED } }),
  dashboard('problems-no-captions', 1280, { data: { sessions: NO_CAPTIONS } }),
  dashboard('problems-no-captions-narrow', 390, { data: { sessions: NO_CAPTIONS } }),
  dashboard('focus', 1280, {
    full: false,
    after: (root) => root.querySelector<HTMLElement>('[data-key="ready:profile"]')!.focus(),
  }),
  // A meeting not transcribed yet: its profile button opens the profile list (✓ its own).
  dashboard('profile-menu', 1280, { after: (root) => click(root, 'ready:profile') }),
  dashboard('profile-menu-narrow', 390, {
    full: false,
    height: 700,
    after: (root) => {
      root.querySelector('[data-key="ready:profile"]')!.scrollIntoView({ block: 'center' });
      click(root, 'ready:profile');
    },
  }),
  dashboard('empty', 1280, { data: { sessions: [], pinHint: true } }),
  dashboard('empty-narrow', 390, { data: { sessions: [], pinHint: true } }),
  dashboard('setup-needed', 1280, {
    data: {
      missing: ['Notion integration token', 'Notion team database id', 'Your name'],
      geminiKeyMissing: true,
      autoTranscribe: false,
      sessions: WITH_DEADLINE.slice(0, 4),
    },
  }),
  dashboard('setup-needed-narrow', 390, {
    data: {
      missing: ['Notion integration token', 'Your name'],
      geminiKeyMissing: true,
      autoTranscribe: false,
      sessions: WITH_DEADLINE.slice(0, 3),
    },
  }),
  // Saving works, no Gemini key: the ⓘ note alone (the popup's rule: one notice at a time).
  dashboard('setup-gemini', 1280, { data: { geminiKeyMissing: true, sessions: WITH_DEADLINE.slice(0, 3) } }),
  dashboard('large-text', 1280, { fontSize: '24px' }),
  dashboard('large-text-narrow', 390, { fontSize: '24px' }),
]);
