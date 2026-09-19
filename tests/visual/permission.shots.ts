import { createPermissionView, type PermissionHandlers } from '@lib/ui/permissionView';
import type { MicPermission, MicRequestResult } from '@lib/ui/mic';
import permissionHtml from '../../entrypoints/permission/index.html?raw';
import { gallery, never, shell, type Shot } from './harness';

const SITE_SETTINGS = 'chrome://settings/content/siteDetails?site=chrome-extension%3A%2F%2Fkhgbnfmcdfgjmfhelkfjbkaconlkehpo';

interface Options {
  /** What Continue / Try again gets back; `never` leaves Chrome's prompt open. */
  answer?: () => Promise<MicRequestResult>;
  /** The permission after answering. */
  after?: MicPermission;
  /** Click the page's first button after rendering. */
  click?: boolean;
}

function permission(name: string, width: number, state: MicPermission, o: Options = {}): Shot {
  return {
    name: `permission-${name}`,
    width,
    height: 720,
    full: true,
    render() {
      const root = shell(permissionHtml);
      const handlers: PermissionHandlers = {
        request: o.answer ?? never,
        query: () => Promise.resolve(o.after ?? state),
        openSiteSettings: () => {},
        close: () => {},
      };
      const view = createPermissionView(root, handlers, SITE_SETTINGS);
      view.update(state);
      if (o.click) root.querySelector<HTMLButtonElement>('.perm-actions .btn')!.click();
    },
  };
}

const dismissed = () =>
  Promise.resolve<MicRequestResult>({ ok: false, reason: 'denied', message: 'Microphone access was blocked.' });
const noDevice = () =>
  Promise.resolve<MicRequestResult>({
    ok: false,
    reason: 'no-device',
    message: 'No microphone was found. Plug one in and try again.',
  });

const busy = () =>
  Promise.resolve<MicRequestResult>({
    ok: false,
    reason: 'error',
    message: 'The microphone could not be opened. Another app may be using it.',
  });

gallery('permission', [
  permission('prompt', 1280, 'prompt'),
  permission('prompt-390', 390, 'prompt'),
  permission('requesting', 1280, 'prompt', { click: true }),
  permission('dismissed', 1280, 'prompt', { click: true, answer: dismissed, after: 'prompt' }),
  permission('no-device', 390, 'prompt', { click: true, answer: noDevice, after: 'prompt' }),
  permission('busy', 1280, 'prompt', { click: true, answer: busy, after: 'prompt' }),
  permission('granted', 1280, 'granted'),
  permission('denied', 1280, 'denied'),
  permission('denied-390', 390, 'denied'),
]);
