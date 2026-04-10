import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

/**
 * Performance / Web Vitals collector.
 *
 * Collects Core Web Vitals (LCP, CLS, FCP, FID, INP), Navigation Timing
 * (TTFB, domContentLoaded, loadEvent, transferSize) and Long Task counts
 * during the session via PerformanceObserver, then emits one summary
 * `performance` event via the tracker's beforeFlush() hook.
 *
 * The beforeFlush timing matches how SessionCollector works — the final
 * snapshot rides out in the same beacon as the rest of the buffered data
 * on visibilitychange / pagehide / beforeunload.
 *
 * Zero runtime deps. Gracefully degrades if PerformanceObserver or a
 * specific entry type is not supported (old browsers, Safari quirks).
 *
 * CLS uses the session-window algorithm (the one web.dev recommends):
 *   - A new session window starts after 1s of no shifts OR when the
 *     current window has been open for 5s.
 *   - Final CLS = max sum of shifts within any single window.
 *
 * INP uses a simplified approximation: max interaction duration across
 * all recorded first-input + event-timing entries. Not identical to the
 * official P98 calculation but captures the worst case, which is the
 * value most correlated with user frustration.
 */

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

interface LCPEntry extends PerformanceEntry {
  startTime: number;
  renderTime: number;
  loadTime: number;
  size: number;
}

interface FirstInputEntry extends PerformanceEntry {
  processingStart: number;
  startTime: number;
  duration: number;
}

interface EventTimingEntry extends PerformanceEntry {
  duration: number;
  interactionId?: number;
}

export class PerformanceCollector implements Collector {
  private tracker: SurfaiTracker;

  private lcp: number | null = null;
  private fcp: number | null = null;
  private fid: number | null = null;
  private inp: number | null = null;

  // CLS session-window state
  private clsValue = 0;
  private sessionValue = 0;
  private sessionFirstTs = 0;
  private sessionLastTs = 0;

  // Long tasks
  private longTaskCount = 0;
  private longTaskTotalMs = 0;

  private observers: PerformanceObserver[] = [];

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    if (typeof PerformanceObserver === "undefined") return;

    this.observeLcp();
    this.observeCls();
    this.observeFcp();
    this.observeFirstInput();
    this.observeEventTiming();
    this.observeLongTasks();
  }

  stop(): void {
    for (const obs of this.observers) {
      try { obs.disconnect(); } catch { /* ignore */ }
    }
    this.observers = [];
  }

  /**
   * Called by tracker right before the buffer is drained on unload.
   * Emits one final `performance` event with the accumulated metrics.
   */
  beforeFlush(): void {
    try {
      const nav = this.readNavigationTiming();
      this.tracker.pushEvent({
        type: "performance",
        data: {
          lcp: this.round(this.lcp),
          fcp: this.round(this.fcp),
          fid: this.round(this.fid),
          inp: this.round(this.inp),
          cls: this.clsValue > 0 ? Math.round(this.clsValue * 10000) / 10000 : null,
          ttfb: this.round(nav.ttfb),
          domInteractive: this.round(nav.domInteractive),
          domContentLoaded: this.round(nav.domContentLoaded),
          loadEvent: this.round(nav.loadEvent),
          transferSize: nav.transferSize,
          longTaskCount: this.longTaskCount,
          longTaskTotalMs: Math.round(this.longTaskTotalMs),
          ts: now(),
        },
      });
    } catch {
      /* must never throw into host page */
    }
  }

  // ---------------------------------------------------------------------
  // Observer setup
  // ---------------------------------------------------------------------

  private tryObserve(type: string, callback: (list: PerformanceObserverEntryList) => void): void {
    try {
      const obs = new PerformanceObserver(callback);
      // `buffered: true` replays entries that happened before we subscribed
      obs.observe({ type, buffered: true } as PerformanceObserverInit);
      this.observers.push(obs);
    } catch {
      /* unsupported entry type — ignore */
    }
  }

  private observeLcp(): void {
    this.tryObserve("largest-contentful-paint", (list) => {
      const entries = list.getEntries() as LCPEntry[];
      const last = entries[entries.length - 1];
      if (last) this.lcp = last.startTime;
    });
  }

  private observeFcp(): void {
    this.tryObserve("paint", (list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          this.fcp = entry.startTime;
        }
      }
    });
  }

  private observeFirstInput(): void {
    this.tryObserve("first-input", (list) => {
      const entries = list.getEntries() as FirstInputEntry[];
      const first = entries[0];
      if (first) {
        this.fid = first.processingStart - first.startTime;
        // Seed INP with FID as a first data point
        if (this.inp === null || first.duration > this.inp) {
          this.inp = first.duration;
        }
      }
    });
  }

  private observeEventTiming(): void {
    // Event timing captures all interaction events with a duration >= threshold.
    // We take the max duration across interactions as a simplified INP proxy.
    this.tryObserve("event", (list) => {
      const entries = list.getEntries() as EventTimingEntry[];
      for (const entry of entries) {
        if (typeof entry.interactionId === "number" && entry.interactionId > 0) {
          if (this.inp === null || entry.duration > this.inp) {
            this.inp = entry.duration;
          }
        }
      }
    });
  }

  private observeLongTasks(): void {
    this.tryObserve("longtask", (list) => {
      for (const entry of list.getEntries()) {
        this.longTaskCount++;
        this.longTaskTotalMs += entry.duration;
      }
    });
  }

  private observeCls(): void {
    this.tryObserve("layout-shift", (list) => {
      for (const entry of list.getEntries() as LayoutShiftEntry[]) {
        // Ignore shifts that follow recent user input — those are intentional
        if (entry.hadRecentInput) continue;

        // Session-window algorithm (web.dev recommended):
        // - new window after 1s gap since last shift
        // - new window when current window exceeds 5s
        // - final CLS = max sum within any window
        const gap = entry.startTime - this.sessionLastTs;
        const windowDuration = entry.startTime - this.sessionFirstTs;
        if (this.sessionValue > 0 && gap < 1000 && windowDuration < 5000) {
          this.sessionValue += entry.value;
        } else {
          this.sessionValue = entry.value;
          this.sessionFirstTs = entry.startTime;
        }
        this.sessionLastTs = entry.startTime;

        if (this.sessionValue > this.clsValue) {
          this.clsValue = this.sessionValue;
        }
      }
    });
  }

  // ---------------------------------------------------------------------
  // Navigation Timing
  // ---------------------------------------------------------------------

  private readNavigationTiming(): {
    ttfb: number | null;
    domInteractive: number | null;
    domContentLoaded: number | null;
    loadEvent: number | null;
    transferSize: number | null;
  } {
    const empty = {
      ttfb: null,
      domInteractive: null,
      domContentLoaded: null,
      loadEvent: null,
      transferSize: null,
    };
    try {
      const entries = performance.getEntriesByType("navigation");
      if (!entries.length) return empty;
      const nav = entries[0] as PerformanceNavigationTiming;
      return {
        ttfb: nav.responseStart > 0 ? nav.responseStart : null,
        domInteractive: nav.domInteractive > 0 ? nav.domInteractive : null,
        domContentLoaded:
          nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd : null,
        loadEvent: nav.loadEventEnd > 0 ? nav.loadEventEnd : null,
        transferSize: typeof nav.transferSize === "number" ? nav.transferSize : null,
      };
    } catch {
      return empty;
    }
  }

  /** Round a metric to an integer number of ms, preserving null. */
  private round(v: number | null): number | null {
    return v == null ? null : Math.round(v);
  }
}
