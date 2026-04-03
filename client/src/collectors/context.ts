import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import {
  detectTrafficSource,
  detectDeviceType,
  detectBrowser,
  detectOS,
  getConnectionType,
  now,
} from "../helpers.js";

/**
 * Context data collector.
 *
 * Collects once on start: traffic source, device type, browser, OS,
 * screen resolution, connection speed, browser language.
 * No PII is captured — all values are structural/categorical.
 */
export class ContextCollector implements Collector {
  private tracker: SurfaiTracker;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    // Emit context once, on next idle callback or immediately
    const emit = () => {
      this.tracker.pushEvent({
        type: "context",
        data: {
          trafficSource: detectTrafficSource(),
          deviceType: detectDeviceType(),
          browser: detectBrowser(),
          os: detectOS(),
          screenW: window.screen.width,
          screenH: window.screen.height,
          language: navigator.language || "unknown",
          connectionType: getConnectionType(),
          ts: now(),
        },
      });
    };

    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(emit);
    } else {
      setTimeout(emit, 0);
    }
  }

  stop(): void {
    // Nothing to clean up — context is emitted once
  }
}
