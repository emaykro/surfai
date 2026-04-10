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
  private earlySnapshotTimer: ReturnType<typeof setTimeout> | null = null;

  /** Delay before the first (early) session snapshot is emitted. */
  private static readonly EARLY_SNAPSHOT_MS = 3000;

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

    // Emit an early snapshot after 3s so that even bounce sessions that
    // close before any lifecycle event fires still get a session record
    // via the regular 5s flushInterval. beforeFlush() on final unload
    // will push a second, more accurate snapshot — the server-side
    // extractor uses the latest one anyway.
    this.earlySnapshotTimer = setTimeout(() => {
      this.emitSnapshot();
    }, SessionCollector.EARLY_SNAPSHOT_MS);
  }

  stop(): void {
    window.removeEventListener("popstate", this.onNavigation);
    if (this.earlySnapshotTimer !== null) {
      clearTimeout(this.earlySnapshotTimer);
      this.earlySnapshotTimer = null;
    }
  }

  /**
   * Called by tracker right before the buffer is drained on page hide /
   * unload / stop. Pushes a final session summary event so it lands in
   * the same beacon as the rest of the buffered data.
   */
  beforeFlush(): void {
    this.emitSnapshot();
  }

  /**
   * Push a session summary with the latest known state. Called both from
   * the 3s early-snapshot timer (to cover bounce sessions) and from
   * beforeFlush() on final unload. Idempotent — only the first call per
   * tracker lifetime actually pushes.
   */
  private emitSnapshot(): void {
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
