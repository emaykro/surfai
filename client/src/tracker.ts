/**
 * SURFAI Behavior Tracker SDK
 *
 * Modular collector architecture: each event type is handled by a separate
 * collector class. The tracker orchestrates start/stop, buffering, and flush.
 *
 * Security: ignores all events originating from input/textarea elements
 * to prevent accidental capture of sensitive user data.
 */

import type { TrackingEvent, TrackerOptions, Collector, PageGoalRule, DataLayerMapping } from "./types.js";
import { isInputElement, scrollPercent, now, getSessionId } from "./helpers.js";

// Re-export public types
export type { TrackingEvent, TrackerOptions, PageGoalRule, DataLayerMapping, GoalEventData } from "./types.js";

// ---------------------------------------------------------------------------
// Tracker (orchestrator)
// ---------------------------------------------------------------------------

export class SurfaiTracker {
  private buffer: TrackingEvent[] = [];
  private flushInterval: number;
  private mouseSampleRate: number;
  private idleThreshold: number;
  private endpoint: string;
  private siteKey: string | undefined;

  private lastMouseSend = 0;
  private lastScrollSend = 0;
  private lastScrollPercent = -1;
  private lastActivity = now();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private idleReported = false;
  private running = false;
  private startTime = 0;
  /** True once the page has started unloading. Suppresses async auto-flush
   *  so final data goes out via sendBeacon, not fetch. */
  private unloading = false;

  /** External collectors registered via addCollector() */
  private collectors: Collector[] = [];

  /** Goal dedup: "goalId" → last fire timestamp (5s window) */
  private goalDedup = new Map<string, number>();
  private static readonly GOAL_DEDUP_WINDOW_MS = 5000;

  /** Page goal rules */
  private pageGoals: PageGoalRule[];

  /** GTM dataLayer config */
  private dataLayerCapture: boolean;
  private dataLayerMappings: DataLayerMapping[];
  private origDataLayerPush: ((...args: unknown[]) => number) | null = null;

  /** Yandex.Metrika reachGoal capture */
  private metrikaCapture: boolean;
  private origYm: ((...args: unknown[]) => void) | null = null;

  /** Batch limits (per sdk-constraints.mdc) */
  private static readonly MAX_EVENTS_PER_FLUSH = 100;
  private static readonly MAX_PAYLOAD_BYTES = 64 * 1024;

  /** Retry config */
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BASE_MS = 500;

  /** Default GA4 dataLayer events → goal mappings */
  private static readonly DEFAULT_DL_MAPPINGS: DataLayerMapping[] = [
    { event: "purchase", goalId: "dl_purchase" },
    { event: "generate_lead", goalId: "dl_generate_lead" },
    { event: "sign_up", goalId: "dl_sign_up" },
    { event: "form_submit", goalId: "dl_form_submit" },
  ];

  constructor(opts: TrackerOptions) {
    this.endpoint = opts.endpoint;
    this.siteKey = opts.siteKey;
    this.flushInterval = opts.flushInterval ?? 5_000;
    this.mouseSampleRate = opts.mouseSampleRate ?? 150;
    this.idleThreshold = opts.idleThreshold ?? 10_000;
    this.pageGoals = opts.pageGoals ?? [];
    this.dataLayerCapture = opts.dataLayerCapture ?? false;
    this.dataLayerMappings = [
      ...SurfaiTracker.DEFAULT_DL_MAPPINGS,
      ...(opts.dataLayerMappings ?? []),
    ];
    this.metrikaCapture = opts.metrikaCapture ?? false;
  }

  // --- Public API ----------------------------------------------------------

  /** Register a collector. Must be called before start(). */
  addCollector(collector: Collector): void {
    this.collectors.push(collector);
  }

  /** Push an event into the buffer (used by collectors). */
  pushEvent(event: TrackingEvent): void {
    this.buffer.push(event);
    // Auto-flush if buffer exceeds limit — but never during unload,
    // where the async fetch path may be cut off before it completes.
    // flushBeacon() will drain the whole buffer via sendBeacon instead.
    if (this.buffer.length >= SurfaiTracker.MAX_EVENTS_PER_FLUSH && !this.unloading) {
      this.flush();
    }
  }

  /** Milliseconds since tracker started. */
  get elapsed(): number {
    return this.startTime ? now() - this.startTime : 0;
  }

  /** Mark user activity (resets idle timer). Called by collectors. */
  markActivity(): void {
    this.resetIdle();
  }

  /**
   * Fire a goal conversion event.
   * Deduplicates: same goalId within 5s window is ignored.
   */
  goal(goalId: string, metadata?: Record<string, string | number | boolean>): void {
    if (!this.running || !goalId) return;

    const t = now();
    const lastFired = this.goalDedup.get(goalId);
    if (lastFired && t - lastFired < SurfaiTracker.GOAL_DEDUP_WINDOW_MS) return;

    this.goalDedup.set(goalId, t);
    this.pushEvent({
      type: "goal",
      data: { goalId, metadata, ts: t },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = now();

    // Core listeners (mouse, scroll, idle)
    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("scroll", this.onScroll, { passive: true });
    document.addEventListener("keydown", this.resetIdle);
    document.addEventListener("click", this.resetIdle);

    // sendBeacon fallback for page unload. We listen to THREE events because
    // no single one is reliable across browsers:
    //   - visibilitychange('hidden'): fires when tab goes to background (mobile primary)
    //   - pagehide: fires on navigation/close including bfcache (Safari/iOS primary)
    //   - beforeunload: legacy desktop fallback
    // All three funnel through the same handler, which is idempotent via
    // this.unloading so the final flush only happens once.
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("beforeunload", this.onBeforeUnload);

    this.idleTimer = setInterval(this.checkIdle, 1_000);
    this.flushTimer = setInterval(() => this.flush(), this.flushInterval);

    // Start all registered collectors
    for (const c of this.collectors) {
      try { c.start(); } catch { /* collector must not crash tracker */ }
    }

    // Page URL goal rules
    if (this.pageGoals.length > 0) {
      this.checkPageGoals();
      window.addEventListener("popstate", this.onNavChange);
      this.patchHistoryMethod("pushState");
      this.patchHistoryMethod("replaceState");
    }

    // GTM dataLayer auto-capture
    if (this.dataLayerCapture) {
      this.hookDataLayer();
    }

    // Yandex.Metrika reachGoal auto-capture
    if (this.metrikaCapture) {
      this.hookMetrika();
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("scroll", this.onScroll);
    document.removeEventListener("keydown", this.resetIdle);
    document.removeEventListener("click", this.resetIdle);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("beforeunload", this.onBeforeUnload);

    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);

    // Let collectors push any final summary events into the buffer
    this.runBeforeFlushHooks();

    // Stop all registered collectors
    for (const c of this.collectors) {
      try { c.stop(); } catch { /* collector must not crash tracker */ }
    }

    // Cleanup page goal listeners
    if (this.pageGoals.length > 0) {
      window.removeEventListener("popstate", this.onNavChange);
    }

    // Restore dataLayer.push if hooked
    if (this.origDataLayerPush) {
      this.unhookDataLayer();
    }

    // Restore ym if hooked
    if (this.origYm) {
      this.unhookMetrika();
    }

    this.flush(); // send remaining data
  }

  // --- Event handlers (arrow fns to preserve `this`) -----------------------

  private onMouseMove = (e: globalThis.MouseEvent): void => {
    if (isInputElement(e.target)) return;

    const t = now();
    if (t - this.lastMouseSend < this.mouseSampleRate) return;
    this.lastMouseSend = t;

    this.resetIdle();
    this.buffer.push({
      type: "mouse",
      data: { x: e.clientX, y: e.clientY, ts: t },
    });
  };

  private onScroll = (): void => {
    this.resetIdle();

    const t = now();
    const pct = scrollPercent();

    // Throttle: skip if same percent or less than 200ms since last send
    if (pct === this.lastScrollPercent || t - this.lastScrollSend < 200) return;

    this.lastScrollSend = t;
    this.lastScrollPercent = pct;
    this.buffer.push({
      type: "scroll",
      data: { percent: pct, ts: t },
    });
  };

  // --- Idle detection ------------------------------------------------------

  private resetIdle = (): void => {
    this.lastActivity = now();
    this.idleReported = false;
  };

  private checkIdle = (): void => {
    const idleMs = now() - this.lastActivity;
    if (idleMs >= this.idleThreshold && !this.idleReported) {
      this.idleReported = true;
      this.buffer.push({
        type: "idle",
        data: { idleMs, ts: now() },
      });
    }
  };

  // --- Page URL goal rules -------------------------------------------------

  private onNavChange = (): void => {
    // Small delay to let URL update
    setTimeout(() => this.checkPageGoals(), 0);
  };

  private checkPageGoals(): void {
    const url = window.location.href;
    const path = window.location.pathname;

    for (const rule of this.pageGoals) {
      let match = false;
      switch (rule.matchType) {
        case "exact":
          match = url === rule.urlPattern || path === rule.urlPattern;
          break;
        case "contains":
          match = url.includes(rule.urlPattern) || path.includes(rule.urlPattern);
          break;
        case "regex":
          try {
            match = new RegExp(rule.urlPattern).test(url);
          } catch { /* invalid regex — skip */ }
          break;
      }
      if (match) {
        this.goal(rule.goalId);
      }
    }
  }

  private patchHistoryMethod(method: "pushState" | "replaceState"): void {
    const orig = history[method].bind(history);
    history[method] = (...args: Parameters<typeof history.pushState>) => {
      const result = orig(...args);
      this.onNavChange();
      return result;
    };
  }

  // --- GTM dataLayer auto-capture ------------------------------------------

  private hookDataLayer(): void {
    const win = window as Window & { dataLayer?: unknown[] };
    if (!win.dataLayer) {
      win.dataLayer = [];
    }

    this.origDataLayerPush = win.dataLayer.push.bind(win.dataLayer);
    const self = this;

    win.dataLayer.push = function (...items: unknown[]): number {
      // Process each pushed item for matching events
      for (const item of items) {
        if (item && typeof item === "object" && "event" in item) {
          const eventName = (item as Record<string, unknown>).event;
          if (typeof eventName === "string") {
            self.handleDataLayerEvent(eventName, item as Record<string, unknown>);
          }
        }
      }
      // Call original push
      return self.origDataLayerPush!(...items);
    };
  }

  private unhookDataLayer(): void {
    const win = window as Window & { dataLayer?: unknown[] };
    if (win.dataLayer && this.origDataLayerPush) {
      win.dataLayer.push = this.origDataLayerPush;
      this.origDataLayerPush = null;
    }
  }

  private handleDataLayerEvent(eventName: string, data: Record<string, unknown>): void {
    const mapping = this.dataLayerMappings.find((m) => m.event === eventName);
    if (!mapping) return;

    // Extract value if present (GA4 convention)
    const value = typeof data.value === "number" ? data.value : undefined;

    this.goal(mapping.goalId, {
      source: "dataLayer",
      dlEvent: eventName,
      ...(value !== undefined ? { value } : {}),
    });
  }

  // --- Yandex.Metrika reachGoal auto-capture --------------------------------

  private hookMetrika(): void {
    const win = window as Window & { ym?: (...args: unknown[]) => void };

    const patchYm = (): boolean => {
      if (typeof win.ym !== "function") return false;
      if (this.origYm) return true; // already patched

      this.origYm = win.ym.bind(win);
      const self = this;

      win.ym = function (...args: unknown[]): void {
        // ym(counterId, 'reachGoal', goalName, params?)
        if (args[1] === "reachGoal" && typeof args[2] === "string") {
          const goalName = args[2];
          self.goal(`ym_${goalName}`, {
            source: "metrika",
            ymGoal: goalName,
          });
        }
        return self.origYm!(...args);
      };
      return true;
    };

    // Try now, and retry every 500ms for up to 10s (Metrika may load late)
    if (!patchYm()) {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (patchYm() || attempts >= 20 || !this.running) {
          clearInterval(interval);
        }
      }, 500);
    }
  }

  private unhookMetrika(): void {
    const win = window as Window & { ym?: (...args: unknown[]) => void };
    if (win.ym && this.origYm) {
      win.ym = this.origYm;
      this.origYm = null;
    }
  }

  // --- Page lifecycle handlers (sendBeacon fallback) -----------------------

  /**
   * Give every collector a chance to push final-summary events into the
   * buffer right before we drain it. Must be called immediately before
   * flushBeacon() so the summaries land in the same beacon as the rest
   * of the buffered data.
   */
  private runBeforeFlushHooks(): void {
    for (const c of this.collectors) {
      if (typeof c.beforeFlush === "function") {
        try { c.beforeFlush(); } catch { /* must not crash tracker */ }
      }
    }
  }

  /**
   * Shared final-flush path used by all three unload listeners.
   * Idempotent via this.unloading so repeated lifecycle events do not
   * re-emit collector summaries or double-flush.
   */
  private finalFlush(): void {
    if (this.unloading) return;
    this.unloading = true;
    this.runBeforeFlushHooks();
    this.flushBeacon();
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.finalFlush();
    }
  };

  private onPageHide = (): void => {
    this.finalFlush();
  };

  private onBeforeUnload = (): void => {
    this.finalFlush();
  };

  // --- Flush ---------------------------------------------------------------

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const chunk = this.buffer.splice(0, SurfaiTracker.MAX_EVENTS_PER_FLUSH);
    const payload = this.buildPayload(chunk);

    let events = chunk;
    let body = payload;
    while (body.length > SurfaiTracker.MAX_PAYLOAD_BYTES && events.length > 1) {
      this.buffer.unshift(events.pop()!);
      body = this.buildPayload(events);
    }

    await this.sendWithRetry(body);

    if (this.buffer.length >= SurfaiTracker.MAX_EVENTS_PER_FLUSH) {
      setTimeout(() => this.flush(), 0);
    }
  }

  private flushBeacon(): void {
    // Drain the entire buffer, splitting into chunks that respect both
    // MAX_EVENTS_PER_FLUSH and MAX_PAYLOAD_BYTES. Multiple sendBeacon
    // calls in one unload are allowed by the spec and each survives
    // the page unload independently.
    //
    // Safety cap: never more than 10 beacons per flush to bound the
    // amount of work we do on an unloading page.
    let beaconsSent = 0;
    const MAX_BEACONS = 10;

    while (this.buffer.length > 0 && beaconsSent < MAX_BEACONS) {
      let chunk = this.buffer.splice(0, SurfaiTracker.MAX_EVENTS_PER_FLUSH);
      let body = this.buildPayload(chunk);

      // Shrink chunk until the serialized payload fits the byte budget.
      while (body.length > SurfaiTracker.MAX_PAYLOAD_BYTES && chunk.length > 1) {
        this.buffer.unshift(chunk.pop()!);
        body = this.buildPayload(chunk);
      }

      try {
        const blob = new Blob([body], { type: "application/json" });
        const sent = navigator.sendBeacon(this.endpoint, blob);
        if (!sent) {
          fetch(this.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          }).catch(() => {});
        }
      } catch {
        // silently drop this chunk, keep draining
      }

      beaconsSent++;
    }
  }

  private buildPayload(events: TrackingEvent[]): string {
    const payload: Record<string, unknown> = {
      sessionId: getSessionId(),
      sentAt: now(),
      events,
    };
    if (this.siteKey) {
      payload.siteKey = this.siteKey;
    }
    return JSON.stringify(payload);
  }

  private async sendWithRetry(body: string): Promise<void> {
    for (let attempt = 0; attempt < SurfaiTracker.MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
        if (res.ok) return;
        if (res.status < 500) return;
      } catch {
        // Network error — retry
      }

      if (attempt < SurfaiTracker.MAX_RETRIES - 1) {
        await new Promise((r) =>
          setTimeout(r, SurfaiTracker.RETRY_BASE_MS * Math.pow(2, attempt))
        );
      }
    }
  }
}

// Auto-register on window for non-module script loading (GTM, direct <script> tags)
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).SurfaiTracker = SurfaiTracker;
}
