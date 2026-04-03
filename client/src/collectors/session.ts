import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { timeBucket, now } from "../helpers.js";

/**
 * Session-level signals collector.
 *
 * Tracks: pages per session, average navigation speed, bounce detection,
 * hyper-engagement detection, time-of-day bucket.
 * Emits a session summary event on stop (page unload or tracker stop).
 */
export class SessionCollector implements Collector {
  private tracker: SurfaiTracker;
  private pageCount = 1;
  private navigationTimes: number[] = [];
  private lastNavTime = 0;
  private sessionStart = 0;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    this.sessionStart = now();
    this.lastNavTime = now();

    // Track SPA navigations via History API
    window.addEventListener("popstate", this.onNavigation);

    // Monkey-patch pushState/replaceState for SPA support
    this.patchHistory("pushState");
    this.patchHistory("replaceState");

    // Emit on unload
    window.addEventListener("beforeunload", this.emitSummary);
  }

  stop(): void {
    window.removeEventListener("popstate", this.onNavigation);
    window.removeEventListener("beforeunload", this.emitSummary);
    this.emitSummary();
  }

  private onNavigation = (): void => {
    this.pageCount++;
    const t = now();
    this.navigationTimes.push(t - this.lastNavTime);
    this.lastNavTime = t;
  };

  private patchHistory(method: "pushState" | "replaceState"): void {
    const original = history[method];
    const self = this;
    history[method] = function (
      this: History,
      ...args: Parameters<typeof history.pushState>
    ) {
      const result = original.apply(this, args);
      self.onNavigation();
      return result;
    };
  }

  private emitSummary = (): void => {
    const duration = now() - this.sessionStart;
    const avgNavSpeedMs =
      this.navigationTimes.length > 0
        ? Math.round(
            this.navigationTimes.reduce((a, b) => a + b, 0) /
              this.navigationTimes.length
          )
        : 0;

    this.tracker.pushEvent({
      type: "session",
      data: {
        pageCount: this.pageCount,
        avgNavSpeedMs,
        isBounce: this.pageCount === 1 && duration < 30_000,
        isHyperEngaged: this.pageCount > 5 || duration > 120_000,
        timeBucket: timeBucket(),
        ts: now(),
      },
    });
  };
}
