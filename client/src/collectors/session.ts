import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { timeBucket, now } from "../helpers.js";

/**
 * Session-level signals collector.
 *
 * Tracks: pages per session, average navigation speed, bounce detection,
 * hyper-engagement detection, time-of-day bucket.
 *
 * Emits a session summary event via the tracker's beforeFlush() hook,
 * which fires on visibilitychange='hidden', beforeunload, and tracker.stop().
 * The hook ordering guarantees the summary lands in the same beacon as
 * the rest of the buffered data.
 */
export class SessionCollector implements Collector {
  private tracker: SurfaiTracker;
  private pageCount = 1;
  private navigationTimes: number[] = [];
  private lastNavTime = 0;
  private sessionStart = 0;
  private summaryEmitted = false;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    this.sessionStart = now();
    this.lastNavTime = now();
    this.summaryEmitted = false;

    // Track SPA navigations via History API
    window.addEventListener("popstate", this.onNavigation);

    // Monkey-patch pushState/replaceState for SPA support
    this.patchHistory("pushState");
    this.patchHistory("replaceState");
  }

  stop(): void {
    window.removeEventListener("popstate", this.onNavigation);
  }

  /**
   * Called by tracker right before the buffer is drained on page hide /
   * unload / stop. Pushes a single session summary event so it lands in
   * the same beacon as the rest of the buffered data. Idempotent — only
   * the first call per tracker lifetime emits.
   */
  beforeFlush(): void {
    if (this.summaryEmitted) return;
    this.summaryEmitted = true;

    try {
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
    } catch {
      /* must never throw into host page */
    }
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
}
