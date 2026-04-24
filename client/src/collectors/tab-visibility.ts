import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

// Tracks how many times the user hid this tab and total hidden time.
// A user who tabs out to compare competitors is actively researching —
// much stronger intent signal than a user who went idle in the same tab.
//
// Emits a `tab_visibility` summary event via beforeFlush.
// An early snapshot at 10s ensures data lands even on mobile where
// lifecycle events are unreliable (same fallback pattern as PerformanceCollector).

export class TabVisibilityCollector implements Collector {
  private tracker: SurfaiTracker;
  private blurCount = 0;
  private hiddenMs = 0;
  private hiddenSince: number | null = null;
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: () => void;

  private static readonly EARLY_SNAPSHOT_MS = 10_000;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
    this.handler = () => {
      if (document.hidden) {
        this.blurCount++;
        this.hiddenSince = now();
      } else {
        if (this.hiddenSince !== null) {
          this.hiddenMs += now() - this.hiddenSince;
          this.hiddenSince = null;
        }
      }
    };
  }

  start(): void {
    document.addEventListener("visibilitychange", this.handler);
    this.earlyTimer = setTimeout(() => {
      this.emitSnapshot();
    }, TabVisibilityCollector.EARLY_SNAPSHOT_MS);
  }

  stop(): void {
    document.removeEventListener("visibilitychange", this.handler);
    if (this.earlyTimer !== null) {
      clearTimeout(this.earlyTimer);
      this.earlyTimer = null;
    }
  }

  beforeFlush(): void {
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    if (this.blurCount === 0) return;
    // Include any currently ongoing hidden period in the total
    const hiddenMs = this.hiddenSince !== null
      ? this.hiddenMs + (now() - this.hiddenSince)
      : this.hiddenMs;
    try {
      this.tracker.pushEvent({
        type: "tab_visibility",
        data: {
          tabBlurCount: this.blurCount,
          tabHiddenMs: Math.round(hiddenMs),
          ts: now(),
        },
      });
    } catch {
      /* must never throw into host page */
    }
  }
}
