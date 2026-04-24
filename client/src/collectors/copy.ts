import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import { now } from "../helpers.js";

// Emits one `copy` event per clipboard copy action.
// No PII is captured — only the fact that copying occurred and when.
// Signals high intent: user likely copied a phone number, address, or price.

export class CopyCollector implements Collector {
  private tracker: SurfaiTracker;
  private handler: () => void;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
    this.handler = () => {
      try {
        this.tracker.pushEvent({ type: "copy", data: { ts: now() } });
      } catch {
        /* must never throw into host page */
      }
    };
  }

  start(): void {
    document.addEventListener("copy", this.handler);
  }

  stop(): void {
    document.removeEventListener("copy", this.handler);
  }
}
