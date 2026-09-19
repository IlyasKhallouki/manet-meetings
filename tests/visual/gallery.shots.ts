/**
 * Screenshot gallery: renders every extension page from fixtures inside its real HTML
 * shell, in light and dark, at the widths people use, and saves PNGs for design review.
 * Opt-in: `pnpm shots` (UI_SHOTS=1), output in UI_SHOTS_DIR. Not part of `pnpm test`.
 */
import { describe, inject, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import '@lib/ui/styles.css';
import { createDashboardView, type DashboardData } from '@lib/ui/dashboardView';
import { createOptionsView } from '@lib/ui/optionsView';
import { createPermissionView } from '@lib/ui/permissionView';
import { createPopupView, micView, type PopupModel } from '@lib/ui/popupView';
import { createRoutingView, ROUTE_COUNTDOWN_MS } from '@lib/ui/routingView';
import type { MicPermission } from '@lib/ui/mic';
import dashboardHtml from '../../entrypoints/dashboard/index.html?raw';
import optionsHtml from '../../entrypoints/options/index.html?raw';
import permissionHtml from '../../entrypoints/permission/index.html?raw';
import popupHtml from '../../entrypoints/popup/index.html?raw';
import routingHtml from '../../entrypoints/routing/index.html?raw';
import { FULL_SETTINGS, NOW, SESSIONS, session } from './scenarios';

declare module 'vitest' {
  export interface ProvidedContext {
    shotsDir: string;
  }
}
declare module 'vitest/browser' {
  interface BrowserCommands {
    setColorScheme(scheme: 'light' | 'dark'): Promise<void>;
  }
}

const OUT = inject('shotsDir');
const FMT = { locale: 'en-GB', timeZone: 'Africa/Casablanca' } as const;
const never = () => new Promise<never>(() => {});
const ok = () => Promise.resolve();

/** Replaces the document with the page's HTML shell (minus its script) and returns #app. */
function shell(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((s) => s.remove());
  document.title = doc.title;
  document.body.className = doc.body.className;
  document.body.replaceChildren(...[...doc.body.childNodes].map((n) => document.importNode(n, true)));
  return document.getElementById('app')!;
}

interface Shot {
  name: string;
  width: number;
  /** Viewport height; with `full`, the minimum height before growing to fit the content. */
  height: number;
  full?: boolean;
  render(): void;
}

function popup(name: string, model: PopupModel, now = NOW): Shot {
  return {
    name: `popup-${name}`,
    width: 380,
    height: 560,
    render() {
      const view = createPopupView(shell(popupHtml), {
        record: ok,
        stop: ok,
        grantMic: () => {},
        openSettings: () => {},
        openDashboard: () => {},
      });
      view.update(model, now);
    },
  };
}

const micOk = micView('granted', true);
const micWarn = micView('prompt', true);
const recording = (patch: object = {}) => ({
  kind: 'recording' as const,
  sessionId: 'rec',
  startedAt: NOW - 23 * 60_000 - 14_000,
  meetCode: 'qrs-tuvw-xyz',
  title: 'Client call — Deloitte audit pilot',
  thisTab: true,
  captionCount: 214,
  ...patch,
});

function dashboard(name: string, width: number, data: Partial<DashboardData> = {}): Shot {
  return {
    name: `dashboard-${name}`,
    width,
    height: 860,
    full: true,
    render() {
      const view = createDashboardView(
        shell(dashboardHtml),
        { stop: ok, transcribe: ok, save: ok, remove: ok, route: ok, setAutoTranscribe: ok, openSettings: () => {} },
        FMT,
      );
      view.update({
        sessions: SESSIONS,
        resultIds: new Set(['processed', 'saved', 'failed']),
        audioOnDisk: new Map(SESSIONS.map((s) => [s.id, s.audio.bytes])),
        estimate: { usage: 29.8 * 1024 * 1024, quota: 8.4 * 1024 ** 3 },
        missing: [],
        geminiKeyMissing: false,
        autoTranscribe: true,
        now: NOW,
        ...data,
      });
    },
  };
}

function options(name: string, width: number, settings = FULL_SETTINGS, mic: MicPermission = 'granted'): Shot {
  return {
    name: `settings-${name}`,
    width,
    height: 860,
    full: true,
    render() {
      const view = createOptionsView(shell(optionsHtml), {
        save: ok,
        verifyGemini: () => Promise.resolve({ ok: true }),
        verifyNotion: () => Promise.resolve({ ok: true, title: 'Team meetings' }),
        openPermissionPage: () => {},
      });
      view.load(settings);
      view.setMic(mic);
    },
  };
}

function routing(name: string, meta: ReturnType<typeof session> | null, elapsed = 12_000): Shot {
  return {
    name: `routing-${name}`,
    width: 380,
    height: 280,
    render() {
      const view = createRoutingView(shell(routingHtml), { choose: ok, close: () => {} }, FMT);
      view.update({ meta, defaultRoute: 'team', deadline: NOW - elapsed + ROUTE_COUNTDOWN_MS }, NOW);
    },
  };
}

function permission(name: string, width: number, state: MicPermission): Shot {
  return {
    name: `permission-${name}`,
    width,
    height: 720,
    full: true,
    render() {
      const view = createPermissionView(
        shell(permissionHtml),
        { request: never, query: () => Promise.resolve(state), openSiteSettings: () => {}, close: () => {} },
        'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fexample',
      );
      view.update(state);
    },
  };
}

const SHOTS: Shot[] = [
  popup('not-meet', { state: { kind: 'not-meet', onMeet: false }, mic: micOk, missing: [], geminiKeyMissing: false }),
  popup('idle', { state: { kind: 'idle', tabId: 1, meetCode: 'qrs-tuvw-xyz' }, mic: micOk, missing: [], geminiKeyMissing: false }),
  popup('idle-setup-needed', {
    state: { kind: 'idle', tabId: 1, meetCode: 'qrs-tuvw-xyz' },
    mic: micWarn,
    missing: ['Notion integration token', 'Notion team database id', 'Your name'],
    geminiKeyMissing: true,
  }),
  popup('recording', { state: recording(), mic: micOk, missing: [], geminiKeyMissing: false }),
  popup('recording-no-captions', {
    state: recording({ captionCount: 0 }),
    mic: micOk,
    missing: [],
    geminiKeyMissing: false,
  }),
  popup('recording-captions-only', {
    state: recording({ audioError: 'Recording stopped: the disk is full.' }),
    mic: micOk,
    missing: [],
    geminiKeyMissing: false,
  }),
  popup('recording-other-tab', { state: recording({ thisTab: false }), mic: micOk, missing: [], geminiKeyMissing: false }),
  dashboard('wide', 1280),
  dashboard('medium', 900),
  dashboard('narrow', 390),
  dashboard('empty', 1280, { sessions: [] }),
  dashboard('setup-needed', 1280, {
    missing: ['Notion integration token', 'Your name'],
    geminiKeyMissing: true,
    autoTranscribe: false,
    sessions: SESSIONS.slice(0, 3),
  }),
  options('filled', 1280),
  options('first-run', 1280, { ...FULL_SETTINGS, displayName: '', geminiApiKey: '', notionToken: '', notionTeamDbId: '' }, 'prompt'),
  options('narrow', 390),
  routing('choose', session('route', { status: 'awaiting-route', meetingTitle: 'Point hebdo produit', route: undefined })),
  routing('choose-late', session('route', { status: 'awaiting-route', meetingTitle: 'Point hebdo produit', route: undefined }), 52_000),
  routing('change', session('route', { status: 'ready', meetingTitle: 'Point hebdo produit', route: 'team' })),
  routing('missing', null),
  permission('prompt', 1280, 'prompt'),
  permission('granted', 1280, 'granted'),
  permission('denied', 1280, 'denied'),
  permission('narrow', 390, 'prompt'),
];

describe('screenshot gallery', () => {
  for (const scheme of ['light', 'dark'] as const) {
    for (const shot of SHOTS) {
      it(`${shot.name} (${scheme})`, async () => {
        await commands.setColorScheme(scheme);
        await page.viewport(shot.width, shot.height);
        shot.render();
        await new Promise((r) => setTimeout(r, 120));
        if (shot.full) {
          const height = Math.max(shot.height, document.documentElement.scrollHeight);
          await page.viewport(shot.width, height);
        }
        await page.screenshot({ path: `${OUT}/${shot.name}-${scheme}.png` });
      });
    }
  }
});
