import type { Route, SpeakerInfo } from '@lib/types';
import { createRoutingView, ROUTE_COUNTDOWN_MS, type RoutingHandlers } from '@lib/ui/routingView';
import routingHtml from '../../entrypoints/routing/index.html?raw';
import { FMT, gallery, never, ok, shell, variant, type Shot } from './harness';
import { NOW, session } from './scenarios';

const MIN = 60_000;

function speakers(...names: string[]): SpeakerInfo[] {
  return names.map((name, i) => ({
    name,
    self: name === 'Ilyas',
    firstAt: i * 20_000,
    lastAt: i * 20_000 + 5_000,
    talkMs: 5_000,
  }));
}

const ROLL = speakers('Marie Curie', 'Tom Martin', 'Ilyas');

/** Just ended: the window opens a minute after the meeting. */
function ended(patch: Parameters<typeof session>[1] = {}) {
  return session('route', {
    status: 'awaiting-route',
    meetingTitle: 'Weekly product sync',
    startedAt: NOW - 33 * MIN,
    endedAt: NOW - MIN,
    durationMs: 32 * MIN,
    route: undefined,
    speakers: ROLL,
    ...patch,
  });
}

interface Options {
  elapsed?: number;
  defaultRoute?: Route;
  /** Chrome's font-size setting, as a percentage of 16 px. */
  text?: number;
  handlers?: Partial<RoutingHandlers>;
  /** After the first render: click Pause, or a destination. */
  then?: (root: HTMLElement) => void;
}

/**
 * The window fits its height to the content (main.ts), so each shot starts from a short
 * viewport and grows to the content: what you see is the whole window body.
 */
function routing(name: string, meta: ReturnType<typeof session> | null, o: Options = {}): Shot {
  return {
    name: `routing-${name}`,
    width: 380,
    height: 120,
    full: true,
    render() {
      document.documentElement.style.fontSize = o.text ? `${(16 * o.text) / 100}px` : '';
      const root = shell(routingHtml);
      const view = createRoutingView(
        root,
        { choose: ok, hold: ok, open: () => {}, close: () => {}, ...o.handlers },
        FMT,
      );
      const elapsed = o.elapsed ?? 12_000;
      view.update(
        { meta, defaultRoute: o.defaultRoute ?? 'team', deadline: NOW - elapsed + ROUTE_COUNTDOWN_MS },
        NOW,
      );
      o.then?.(root);
    },
  };
}

const click = (selector: string) => (root: HTMLElement) => root.querySelector<HTMLElement>(selector)!.click();
const pause = (root: HTMLElement) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Pause')!.click();

const choose = routing('choose', ended());
const chosen = routing('chosen', ended(), { then: click('[data-route="team"]') });

gallery('routing', [
  choose,
  routing('choose-late', ended(), { elapsed: 52_000 }),
  routing('choose-personal-default', ended({ meetingTitle: 'Ilyas / Sofia 1:1', speakers: speakers('Sofia Rossi', 'Ilyas') }), {
    defaultRoute: 'personal',
  }),
  routing(
    'choose-long',
    ended({
      meetingTitle: 'Point hebdo produit — revue des priorités Q4 avec l’équipe design et les partenaires de Kera',
      durationMs: 72 * MIN,
      speakers: speakers('Jean-Baptiste de La Fontaine', 'Marie-Hélène Dubois-Laurent', 'Ilyas', 'Sofia', 'Tom', 'Julien'),
    }),
  ),
  routing('choose-no-speakers', ended({ meetingTitle: undefined, meetCode: 'qrs-tuvw-xyz', speakers: undefined })),
  routing('choose-no-speakers-titled', ended({ meetCode: 'qrs-tuvw-xyz', speakers: undefined })),
  routing('choose-text-150', ended(), { text: 150 }),
  routing('paused', ended(), { then: pause }),
  routing('sending', ended(), { handlers: { choose: never }, then: click('[data-route="personal"]') }),
  routing('sending-default', ended(), { handlers: { choose: never }, then: click('[data-route="team"]') }),
  chosen,
  routing('error', ended(), {
    handlers: {
      choose: () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
    },
    then: click('[data-route="personal"]'),
  }),
  routing('error-paused', ended(), {
    handlers: { choose: () => Promise.reject(new Error('Unknown session route.')) },
    then: (root) => {
      pause(root);
      click('[data-route="team"]')(root);
    },
  }),
  routing('pause-failed', ended(), {
    handlers: { hold: () => Promise.reject(new Error('Extension context invalidated.')) },
    then: pause,
  }),
  routing('change', ended({ status: 'ready', route: 'team' })),
  routing('handled-processing', ended({ status: 'processing', stage: 'transcribing-text', route: 'team' })),
  routing(
    'handled-saved',
    ended({
      status: 'saved',
      route: 'team',
      notion: { pageId: 'p1', url: 'https://www.notion.so/p1' },
    }),
  ),
  routing(
    'handled-duplicate',
    ended({
      status: 'duplicate',
      route: 'team',
      notion: { pageId: 'p2', url: 'https://www.notion.so/p2', recordedBy: 'Marie Curie' },
    }),
  ),
  routing('missing', null),
  // Accessibility settings: the navy default, the drain bar and "✓ Team" must survive the
  // system palette; reduced motion drops the bar (the countdown text carries it).
  variant(choose, 'forced-colors', { forcedColors: true }),
  variant(chosen, 'forced-colors', { forcedColors: true }),
  variant(choose, 'reduced-motion', { reducedMotion: true }),
  variant(choose, 'more-contrast', { moreContrast: true }),
]);
