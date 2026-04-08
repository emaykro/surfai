import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

/**
 * Bot signal collector.
 *
 * One-shot collector that probes for headless browser and automation
 * indicators on start. Sends a single "bot_signals" event.
 * Must never throw into the host page.
 */
export class BotSignalCollector implements Collector {
  private tracker: SurfaiTracker;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    const emit = () => {
      try {
        const win = window as unknown as Record<string, unknown>;
        const nav = navigator as unknown as Record<string, unknown>;
        const doc = document as unknown as Record<string, unknown>;

        this.tracker.pushEvent({
          type: "bot_signals",
          data: {
            webdriver: !!(nav.webdriver),
            phantom: !!win._phantom || !!win.callPhantom,
            nightmare: !!win.__nightmare,
            selenium: !!doc.__selenium_unwrapped
              || !!doc.__webdriver_evaluate
              || !!doc.__driver_evaluate,
            cdp: Object.keys(win).some((k) => /^cdc_/.test(k)),
            pluginCount: navigator.plugins ? navigator.plugins.length : 0,
            languageCount: navigator.languages ? navigator.languages.length : 0,
            hasChrome: !!win.chrome,
            notificationPermission:
              typeof Notification !== "undefined"
                ? Notification.permission
                : "unavailable",
            hardwareConcurrency: navigator.hardwareConcurrency || 0,
            deviceMemory: (nav.deviceMemory as number) ?? -1,
            touchSupport:
              "ontouchstart" in window
              || ((nav.maxTouchPoints as number) || 0) > 0,
            screenColorDepth: screen.colorDepth || 0,
            ts: now(),
          },
        });
      } catch {
        /* must never throw into host page */
      }
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(emit);
    } else {
      setTimeout(emit, 0);
    }
  }

  stop(): void {
    // One-shot — nothing to clean up
  }
}
