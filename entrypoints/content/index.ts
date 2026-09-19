import { defineContentScript } from 'wxt/utils/define-content-script';
import { handleMessages, sendToBackground, type ContentProtocol } from '@lib/messages';
import { MeetController } from './controller';

const TICK_MS = 1000;

// Pick turns the interface into a plain object type, which satisfies handleMessages'
// Record<string, …> constraint (interfaces carry no implicit index signature).
type ContentMessages = Pick<ContentProtocol, keyof ContentProtocol>;

export default defineContentScript({
  matches: ['https://meet.google.com/*'],
  main(ctx) {
    const controller = new MeetController({
      doc: document,
      url: () => location.href,
      send: sendToBackground,
    });

    const unlisten = handleMessages<ContentMessages>('content', {
      'content/recording-state': (state) => controller.setRecording(state),
    });
    ctx.onInvalidated(() => {
      unlisten();
      controller.dispose();
    });

    // One loop for everything: in-call detection, CC and region upkeep, caption batches.
    ctx.setInterval(() => {
      void controller.tick().then(() => controller.flushCaptions());
    }, TICK_MS);
    ctx.addEventListener(window, 'wxt:locationchange', () => void controller.tick());
    ctx.addEventListener(window, 'pagehide', () => controller.pageHide());
    void controller.tick();
  },
});
