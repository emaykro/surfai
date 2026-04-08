/**
 * SURFAI SDK — Browser bundle entry point.
 *
 * Imports the tracker and all collectors, then exposes a factory
 * function that auto-registers every collector. This is the file
 * esbuild bundles into dist/tracker.js for <script> loading.
 */

import { SurfaiTracker } from "./tracker.js";
import type { TrackerOptions } from "./types.js";

import { ClickCollector } from "./collectors/click.js";
import { FormCollector } from "./collectors/form.js";
import { EngagementCollector } from "./collectors/engagement.js";
import { SessionCollector } from "./collectors/session.js";
import { ContextCollector } from "./collectors/context.js";
import { CrossSessionCollector } from "./collectors/cross-session.js";
import { BotSignalCollector } from "./collectors/bot-signals.js";

// Re-export types for module consumers
export type { TrackingEvent, TrackerOptions, PageGoalRule, DataLayerMapping, GoalEventData } from "./types.js";

/**
 * Full-featured tracker with all collectors pre-registered.
 * This is what browser <script> users get via `new SurfaiTracker(opts)`.
 */
export class SurfaiTrackerBundle extends SurfaiTracker {
  constructor(opts: TrackerOptions) {
    super(opts);

    // Auto-register all built-in collectors
    this.addCollector(new ClickCollector(this));
    this.addCollector(new FormCollector(this));
    this.addCollector(new EngagementCollector(this));
    this.addCollector(new SessionCollector(this));
    this.addCollector(new ContextCollector(this));
    this.addCollector(new CrossSessionCollector(this));
    this.addCollector(new BotSignalCollector(this));
  }
}

// Expose on window for non-module script loading
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).SurfaiTracker = SurfaiTrackerBundle;
}
