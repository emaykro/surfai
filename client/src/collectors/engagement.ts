import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { scrollPercent, now } from "../helpers.js";

/**
 * Page engagement collector.
 *
 * Tracks: active vs idle time, max scroll depth, scroll speed classification,
 * micro-scrolling count, content readthrough detection.
 * Emits periodic engagement snapshots (every 10s).
 */
export class EngagementCollector implements Collector {
  private tracker: SurfaiTracker;
  private timer: ReturnType<typeof setInterval> | null = null;

  private activeMs = 0;
  private idleMs = 0;
  private lastTick = 0;
  private isIdle = false;
  private idleThresholdMs = 5_000;

  private maxScrollPercent = 0;
  private lastScrollPercent = 0;
  private lastScrollTime = 0;
  private scrollDeltas: number[] = [];
  private microScrolls = 0;

  private lastActivityTime = 0;
  private pageStartTime = 0;

  /** Emit interval (ms) */
  private static readonly EMIT_INTERVAL = 10_000;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    this.pageStartTime = now();
    this.lastTick = now();
    this.lastActivityTime = now();

    document.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("mousemove", this.onActivity, { passive: true });
    document.addEventListener("keydown", this.onActivity, { passive: true });
    document.addEventListener("click", this.onActivity, { passive: true });

    this.timer = setInterval(this.tick, 1_000);
  }

  stop(): void {
    document.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("mousemove", this.onActivity);
    document.removeEventListener("keydown", this.onActivity);
    document.removeEventListener("click", this.onActivity);

    if (this.timer) clearInterval(this.timer);

    // Emit final snapshot
    this.emitSnapshot();
  }

  private onActivity = (): void => {
    this.lastActivityTime = now();
    this.isIdle = false;
  };

  private onScroll = (): void => {
    this.onActivity();

    const pct = scrollPercent();
    const t = now();

    if (pct > this.maxScrollPercent) {
      this.maxScrollPercent = pct;
    }

    // Track scroll delta for speed classification
    const delta = Math.abs(pct - this.lastScrollPercent);
    if (delta > 0 && this.lastScrollTime > 0) {
      const dtMs = t - this.lastScrollTime;
      if (dtMs > 0) {
        this.scrollDeltas.push(delta / dtMs * 1000); // %/sec
      }
    }

    // Micro-scroll: <5% change
    if (delta > 0 && delta < 5) {
      this.microScrolls++;
    }

    this.lastScrollPercent = pct;
    this.lastScrollTime = t;
  };

  private tick = (): void => {
    const t = now();
    const elapsed = t - this.lastTick;
    this.lastTick = t;

    // Determine if user was idle
    if (t - this.lastActivityTime > this.idleThresholdMs) {
      this.isIdle = true;
      this.idleMs += elapsed;
    } else {
      this.isIdle = false;
      this.activeMs += elapsed;
    }

    // Emit engagement snapshot every EMIT_INTERVAL
    const totalMs = t - this.pageStartTime;
    if (totalMs > 0 && totalMs % EngagementCollector.EMIT_INTERVAL < 1_100) {
      this.emitSnapshot();
    }
  };

  private emitSnapshot(): void {
    this.tracker.pushEvent({
      type: "engagement",
      data: {
        activeMs: this.activeMs,
        idleMs: this.idleMs,
        maxScrollPercent: this.maxScrollPercent,
        scrollSpeed: this.classifyScrollSpeed(),
        microScrolls: this.microScrolls,
        readthrough: this.isReadthrough(),
        ts: now(),
      },
    });
  }

  private classifyScrollSpeed(): string {
    if (this.scrollDeltas.length === 0) return "slow";
    const avg =
      this.scrollDeltas.reduce((a, b) => a + b, 0) / this.scrollDeltas.length;
    if (avg > 50) return "fast";     // >50%/sec
    if (avg > 15) return "medium";   // 15-50%/sec
    return "slow";
  }

  private isReadthrough(): boolean {
    return this.maxScrollPercent >= 80 && this.activeMs >= 10_000;
  }
}
