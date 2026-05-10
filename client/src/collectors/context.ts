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
  getMetricaClientId,
  now,
} from "../helpers.js";

/**
 * Context data collector.
 *
 * Emits context at start, after 3s, and on beforeFlush. All but the first
 * emit exist solely to catch _ym_uid late-binding: Metrica's tag.js sets the
 * cookie ~100-500 ms after our SDK's synchronous start emit, so first-visit
 * conversions in the same session lose their metricaClientId. The server-side
 * extractor (server/features/extractors.js) takes the latest non-null
 * metricaClientId across all context events; other fields use the first emit.
 */
export class ContextCollector implements Collector {
  private tracker: SurfaiTracker;
  private lateEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private finalEmitted = false;

  private static readonly LATE_EMIT_MS = 3000;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    this.finalEmitted = false;
    this.emitContext();
    this.lateEmitTimer = setTimeout(() => {
      this.emitContext();
    }, ContextCollector.LATE_EMIT_MS);
  }

  stop(): void {
    if (this.lateEmitTimer !== null) {
      clearTimeout(this.lateEmitTimer);
      this.lateEmitTimer = null;
    }
  }

  beforeFlush(): void {
    if (this.finalEmitted) return;
    this.finalEmitted = true;
    this.emitContext();
  }

  private emitContext(): void {
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
          metricaClientId: getMetricaClientId(),
          ts: now(),
        },
      });
    } catch {
      /* must never throw into host page */
    }
  }
}
