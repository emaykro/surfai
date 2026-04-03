import type { Collector } from "../types.js";
import type { SurfaiTracker } from "../tracker.js";
import {
  isInputElement,
  hashSelector,
  roundCoord,
  classifyElement,
  isExternalLink,
  isCta,
  now,
} from "../helpers.js";

/**
 * Click tracking collector.
 *
 * Tracks: click coordinates (10px grid), element type, hashed selector,
 * CTA clicks, external link clicks, time since tracker start.
 */
export class ClickCollector implements Collector {
  private tracker: SurfaiTracker;

  constructor(tracker: SurfaiTracker) {
    this.tracker = tracker;
  }

  start(): void {
    document.addEventListener("click", this.onClick, { capture: true, passive: true });
  }

  stop(): void {
    document.removeEventListener("click", this.onClick, { capture: true });
  }

  private onClick = (e: MouseEvent): void => {
    const target = e.target;
    if (!target || !(target instanceof Element)) return;
    if (isInputElement(target)) return;

    this.tracker.markActivity();

    this.tracker.pushEvent({
      type: "click",
      data: {
        x: roundCoord(e.clientX),
        y: roundCoord(e.clientY),
        elType: classifyElement(target),
        elTagHash: hashSelector(target),
        isCta: isCta(target),
        isExternal: isExternalLink(target),
        timeSinceStart: this.tracker.elapsed,
        ts: now(),
      },
    });
  };
}
