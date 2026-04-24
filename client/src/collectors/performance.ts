import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

// Web Vitals + Navigation Timing collector. Emits up to 3 snapshots per session
// (5s, 20s, beforeFlush) so data lands even when lifecycle events don't fire.

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
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private secondTimer: ReturnType<typeof setTimeout> | null = null;

  /** Delay before the first fallback snapshot. */
  private static readonly EARLY_SNAPSHOT_MS = 5000;
  /** Delay before the second fallback snapshot (longer session coverage). */
  private static readonly SECOND_SNAPSHOT_MS = 20000;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    if (typeof PerformanceObserver !== "undefined") {
      this.observeLcp();
      this.observeCls();
      this.observeFcp();
      this.observeFirstInput();
      this.observeEventTiming();
      this.observeLongTasks();
    }

    // Schedule two fallback snapshots in addition to the beforeFlush upgrade.
    // These guarantee at least one performance event lands in the DB even
    // when lifecycle events (pagehide, visibilitychange, beforeunload) fail
    // to fire — see 2026-04-10 incident in vault/bugs/.
    this.earlyTimer = setTimeout(() => {
      this.emitSnapshot();
    }, PerformanceCollector.EARLY_SNAPSHOT_MS);
    this.secondTimer = setTimeout(() => {
      this.emitSnapshot();
    }, PerformanceCollector.SECOND_SNAPSHOT_MS);
  }

  stop(): void {
    for (const obs of this.observers) {
      try { obs.disconnect(); } catch { /* ignore */ }
    }
    this.observers = [];
    if (this.earlyTimer !== null) {
      clearTimeout(this.earlyTimer);
      this.earlyTimer = null;
    }
    if (this.secondTimer !== null) {
      clearTimeout(this.secondTimer);
      this.secondTimer = null;
    }
  }

  beforeFlush(): void {
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
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
