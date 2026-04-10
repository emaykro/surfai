import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import {
  detectTrafficSource,
  detectDeviceType,
  detectBrowser,
  detectOS,
  getConnectionType,
  getTimezone,
  getTimezoneOffset,
  getLanguages,
  getViewportWidth,
  getViewportHeight,
  getDevicePixelRatio,
  getColorScheme,
  getReducedMotion,
  getHardwareConcurrency,
  getDeviceMemory,
  getReferrerHost,
  getUtmParams,
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
    // Emit context synchronously. Reads are cheap (navigator/screen/document.referrer)
    // and deferring via requestIdleCallback caused bounce sessions to unload before
    // the callback fired, dropping context for ~95% of traffic.
    try {
      const utm = getUtmParams();
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
          // Extended fields (added 2026-04-10)
          timezone: getTimezone(),
          timezoneOffset: getTimezoneOffset(),
          languages: getLanguages(),
          viewportW: getViewportWidth(),
          viewportH: getViewportHeight(),
          devicePixelRatio: getDevicePixelRatio(),
          colorScheme: getColorScheme(),
          reducedMotion: getReducedMotion(),
          hardwareConcurrency: getHardwareConcurrency(),
          deviceMemory: getDeviceMemory(),
          referrerHost: getReferrerHost(),
          utmSource: utm.utmSource,
          utmMedium: utm.utmMedium,
          utmCampaign: utm.utmCampaign,
          utmTerm: utm.utmTerm,
          utmContent: utm.utmContent,
          ts: now(),
        },
      });
    } catch {
      /* must never throw into host page */
    }
  }

  stop(): void {
    // Nothing to clean up — context is emitted once
  }
}
