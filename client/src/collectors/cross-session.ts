import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

/**
 * Cross-session / repeat visit collector.
 *
 * Uses localStorage (not cookies, not fingerprinting) for an anonymous visitor ID.
 * Tracks visit number and return timing flags.
 * Never stores PII — only a random UUID and timestamps.
 */
export class CrossSessionCollector implements Collector {
  private tracker: SurfaiTracker;

  private static readonly VISITOR_KEY = "surfai_visitor_id";
  private static readonly VISIT_COUNT_KEY = "surfai_visit_count";
  private static readonly LAST_VISIT_KEY = "surfai_last_visit";

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    try {
      const visitorId = this.getOrCreateVisitorId();
      const visitNumber = this.incrementVisitCount();
      const lastVisit = this.getLastVisitTime();
      const currentTime = now();

      const msSinceLast = lastVisit ? currentTime - lastVisit : Infinity;

      this.tracker.pushEvent({
        type: "cross_session",
        data: {
          visitorId,
          visitNumber,
          returnWithin24h: msSinceLast < 24 * 60 * 60 * 1000,
          returnWithin7d: msSinceLast < 7 * 24 * 60 * 60 * 1000,
          ts: currentTime,
        },
      });

      // Update last visit timestamp
      localStorage.setItem(
        CrossSessionCollector.LAST_VISIT_KEY,
        String(currentTime)
      );
    } catch {
      // localStorage may be blocked — silently skip
    }
  }

  stop(): void {
    // Nothing to clean up
  }

  private getOrCreateVisitorId(): string {
    let id = localStorage.getItem(CrossSessionCollector.VISITOR_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(CrossSessionCollector.VISITOR_KEY, id);
    }
    return id;
  }

  private incrementVisitCount(): number {
    const raw = localStorage.getItem(CrossSessionCollector.VISIT_COUNT_KEY);
    const count = (raw ? parseInt(raw, 10) : 0) + 1;
    localStorage.setItem(CrossSessionCollector.VISIT_COUNT_KEY, String(count));
    return count;
  }

  private getLastVisitTime(): number | null {
    const raw = localStorage.getItem(CrossSessionCollector.LAST_VISIT_KEY);
    return raw ? parseInt(raw, 10) : null;
  }
}
