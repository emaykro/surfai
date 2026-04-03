// ---------------------------------------------------------------------------
// Event types — single source of truth for the SDK
// ---------------------------------------------------------------------------

export interface MouseEventData {
  x: number;
  y: number;
  ts: number;
}

export interface ScrollEventData {
  percent: number;
  ts: number;
}

export interface IdleEventData {
  idleMs: number;
  ts: number;
}

export interface ClickEventData {
  x: number;
  y: number;
  elType: string;           // "button" | "link" | "image" | "other"
  elTagHash: number;        // MurmurHash3 of CSS selector
  isCta: boolean;
  isExternal: boolean;
  timeSinceStart: number;   // ms since tracker start
  ts: number;
}

export interface FormEventData {
  action: string;           // "focus" | "blur" | "submit" | "abandon"
  formHash: number;         // MurmurHash3 of form selector
  fieldIndex: number;       // ordinal position of field in form
  fieldType: string;        // input type: "text" | "email" | "password" | etc.
  fillDurationMs: number;   // time spent in field (blur - focus)
  ts: number;
}

export interface EngagementEventData {
  activeMs: number;         // active time on page so far
  idleMs: number;           // idle time on page so far
  maxScrollPercent: number; // max scroll depth reached
  scrollSpeed: string;      // "slow" | "medium" | "fast"
  microScrolls: number;     // count of tiny scroll adjustments (<5%)
  readthrough: boolean;     // user scrolled >=80% and spent >=10s
  ts: number;
}

export interface SessionEventData {
  pageCount: number;
  avgNavSpeedMs: number;    // avg time between page navigations
  isBounce: boolean;        // single page, <30s
  isHyperEngaged: boolean;  // >5 pages or >120s
  timeBucket: string;       // "night" | "morning" | "day" | "evening"
  ts: number;
}

export interface ContextEventData {
  trafficSource: string;    // "organic" | "paid" | "referral" | "social" | "direct"
  deviceType: string;       // "desktop" | "mobile" | "tablet"
  browser: string;
  os: string;
  screenW: number;
  screenH: number;
  language: string;
  connectionType: string;   // "4g" | "3g" | "2g" | "slow-2g" | "unknown"
  ts: number;
}

export interface CrossSessionEventData {
  visitorId: string;        // anonymous localStorage-based ID
  visitNumber: number;
  returnWithin24h: boolean;
  returnWithin7d: boolean;
  ts: number;
}

export interface GoalEventData {
  goalId: string;
  value?: number;
  metadata?: Record<string, string | number | boolean>;
  ts: number;
}

export type TrackingEvent =
  | { type: "mouse"; data: MouseEventData }
  | { type: "scroll"; data: ScrollEventData }
  | { type: "idle"; data: IdleEventData }
  | { type: "click"; data: ClickEventData }
  | { type: "form"; data: FormEventData }
  | { type: "engagement"; data: EngagementEventData }
  | { type: "session"; data: SessionEventData }
  | { type: "context"; data: ContextEventData }
  | { type: "cross_session"; data: CrossSessionEventData }
  | { type: "goal"; data: GoalEventData };

// ---------------------------------------------------------------------------
// Collector interface — all collectors implement this
// ---------------------------------------------------------------------------

export interface Collector {
  /** Start collecting events. Called once by tracker.start(). */
  start(): void;
  /** Stop collecting. Called once by tracker.stop(). */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Tracker options
// ---------------------------------------------------------------------------

export interface PageGoalRule {
  goalId: string;
  urlPattern: string;
  matchType: "exact" | "contains" | "regex";
}

export interface DataLayerMapping {
  /** dataLayer event name (e.g. "purchase", "generate_lead") */
  event: string;
  /** SURFAI goal ID to fire */
  goalId: string;
}

export interface TrackerOptions {
  /** Backend endpoint to send batches to */
  endpoint: string;
  /** Site key for multi-project isolation (provided by operator cabinet) */
  siteKey?: string;
  /** How often to flush the buffer (ms). Default: 5 000 */
  flushInterval?: number;
  /** Mouse-move throttle (ms). Default: 150 */
  mouseSampleRate?: number;
  /** Idle threshold (ms). Default: 10 000 */
  idleThreshold?: number;
  /** Page URL rules that auto-fire goals on navigation. Default: [] */
  pageGoals?: PageGoalRule[];
  /** Enable GTM dataLayer auto-capture. Default: false */
  dataLayerCapture?: boolean;
  /** Custom dataLayer event → goal mappings. Merged with defaults. */
  dataLayerMappings?: DataLayerMapping[];
}
