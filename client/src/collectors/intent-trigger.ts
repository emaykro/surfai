import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { scrollPercent } from "../helpers.js";

/**
 * Intent Trigger Collector — detects high-intent on-page readiness
 * (deep reading + hesitation / exit intent) and triggers client-side callbacks.
 */
export class IntentTriggerCollector implements Collector {
  private tracker: SurfaiTracker;
  private maxScroll = 0;
  private hasTriggered = false;
  private boundOnScroll: () => void;
  private boundOnMouseLeave: (e: MouseEvent) => void;
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
    this.boundOnScroll = this.onScroll.bind(this);
    this.boundOnMouseLeave = this.onMouseLeave.bind(this);
  }

  start(): void {
    this.hasTriggered = false;
    this.maxScroll = scrollPercent();

    window.addEventListener("scroll", this.boundOnScroll, { passive: true });
    document.documentElement.addEventListener("mouseleave", this.boundOnMouseLeave);

    // Periodic check for deep engagement (> 90s active reading)
    this.checkInterval = setInterval(() => {
      this.evaluateEngagement();
    }, 10_000);
  }

  stop(): void {
    window.removeEventListener("scroll", this.boundOnScroll);
    document.documentElement.removeEventListener("mouseleave", this.boundOnMouseLeave);
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private onScroll(): void {
    const p = scrollPercent();
    if (p > this.maxScroll) this.maxScroll = p;
  }

  private onMouseLeave(e: MouseEvent): void {
    if (this.hasTriggered) return;
    // Exit intent: cursor leaves top of viewport
    if (e.clientY <= 0) {
      const elapsed = this.tracker.elapsed;
      if (elapsed >= 30_000 && this.maxScroll >= 50) {
        this.trigger("high", 0.78, ["exit_intent_after_deep_scroll", `scroll_${this.maxScroll}%`]);
      }
    }
  }

  private evaluateEngagement(): void {
    if (this.hasTriggered) return;
    const elapsed = this.tracker.elapsed;

    // Very high engagement milestone: > 90s reading + > 70% scroll
    if (elapsed >= 90_000 && this.maxScroll >= 70) {
      this.trigger("very_high", 0.88, ["deep_readthrough_90s", `scroll_${this.maxScroll}%`]);
    }
  }

  private trigger(level: "high" | "very_high", scoreEstimate: number, reasons: string[]): void {
    if (this.hasTriggered) return;
    this.hasTriggered = true;
    this.tracker.notifyIntent({
      level,
      scoreEstimate,
      reasons,
      elapsedMs: this.tracker.elapsed,
    });
  }
}
