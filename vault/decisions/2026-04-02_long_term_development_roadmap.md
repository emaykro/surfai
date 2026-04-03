# SURFAI — Long-Term Development Roadmap

Master Reference Document. Created 2026-04-02.

---

## Phase 1: Persistence & SDK Hardening ✅ COMPLETE

**Goal:** Reliable data collection and storage foundation.

**Deliverables:**
- [x] SDK: duplicate `start()` protection (`if (this.running) return`)
- [x] SDK: batch limits — 100 events / 64 KB per flush
- [x] SDK: `sendBeacon` fallback on `visibilitychange` and `beforeunload`
- [x] SDK: retry with exponential backoff (3 attempts, 500ms base)
- [x] Server: PostgreSQL connection via `pg.Pool` (10 connections, `db.js`)
- [x] Server: migration system (`migrate.js` + `migrations/`)
- [x] Server: `sessions`, `raw_batches`, `events` tables
- [x] Server: fire-and-forget persistence (non-blocking HTTP response)
- [x] Server: JSON Schema validation on all event types
- [x] CORS: explicit origin list, never `*` in production

**Status:** All items implemented and operational.

---

## Phase 2: Expanded Event Types ✅ COMPLETE

**Goal:** Rich behavioral signals beyond mouse/scroll/idle.

**Deliverables:**
- [x] Click tracking (10px grid, element classification, CTA detection)
- [x] Form interaction tracking (focus/blur/submit/abandon, no PII)
- [x] Engagement snapshots (active/idle time, scroll depth, readthrough)
- [x] Session-level signals (bounce detection, hyper-engagement, time buckets)
- [x] Device/traffic context (source detection, browser, OS, connection type)
- [x] Cross-session tracking (anonymous visitorId, return detection)
- [x] Collector architecture (modular `Collector` interface)
- [x] MurmurHash3 for element selectors (never raw text)
- [x] Backend schema expanded (migration 002)

**Status:** Types defined, collectors implemented, backend validation ready.

---

## Phase 3: Dashboard & Real-Time Visualization ✅ COMPLETE

**Goal:** Live dashboard to view incoming behavioral data.

**Deliverables:**
- [x] SSE endpoint for live event stream (`GET /api/events/live`)
- [x] REST API: `GET /api/sessions` (list), `GET /api/sessions/:id` (detail)
- [x] Minimal frontend dashboard (vanilla JS, zero deps) at `/dashboard/`
- [x] Session list view with real-time updates
- [x] Session replay: mouse trail visualization with playback controls
- [x] Scroll depth chart per session
- [x] Click heatmap overlay
- [x] Event timeline chart (all event types, color-coded)
- [x] Session metrics summary cards (duration, events, scroll depth, clicks)
- [x] Migration 003: dashboard query indexes

**Dependencies:** Phase 1, Phase 2.

---

## Phase 4: Feature Engineering Pipeline ✅ COMPLETE

**Goal:** Transform raw events into ML-ready feature vectors.

**Deliverables:**
- [x] Feature extraction service (Node.js — `server/features/`)
- [x] Sliding-window aggregation (1s, 5s, 30s windows)
- [x] Mouse dynamics: velocity, acceleration, curvature, jitter
- [x] Scroll behavior: speed distribution, pause points, direction changes
- [x] Click patterns: rhythm, spatial clustering, rage-click detection
- [x] Form behavior: hesitation, correction patterns, field skip rates
- [x] Session-level features: funnel position, navigation speed, bounce risk
- [x] Feature store table in PostgreSQL with indexed session_id (migration 004)
- [x] Backfill script for existing raw events (`npm run backfill`)
- [x] API endpoint: `GET /api/sessions/:sessionId/features`
- [x] Auto-recompute on each batch arrival (integrated into ingest pipeline)
- [x] 15 unit tests for all extractors

**Dependencies:** Phase 2.

**Status:** All items implemented and operational.

---

## Phase 5: Goal & Conversion Framework ✅ COMPLETE

**Goal:** Configurable conversion tracking with GTM-native integration — provide labeled targets for ML training.

**Deliverables:**

### 5.1 Data Model
- [x] Migration 005: `goals` table (goal_id, tenant_id, name, type, rules JSONB, is_primary, attribution_window_ms)
- [x] Migration 005: `conversions` table (conversion_id, session_id, visitor_id, goal_id, source, value, metadata JSONB, ts)
- [x] `goal_type` enum: `page_rule`, `js_sdk`, `datalayer_auto`, `backend_api`
- [x] Session label derivation: `converted`, `conversion_count`, `primary_goal_converted` on `session_features`

### 5.2 SDK — `surfai.goal()` API
- [x] Public method: `surfai.goal(goalId, metadata?)` — sends conversion event to server
- [x] New event type `goal` in data contract: `{ goalId, value?, metadata?, ts }`
- [x] Backend validation schema for `goal` events (migration 006)
- [x] Deduplication: same goal + session → ignore duplicate within 5s window (SDK + backend)

### 5.3 GTM dataLayer Auto-Capture
- [x] SDK option: `dataLayerCapture: true` (default off)
- [x] Listener on `window.dataLayer.push` — intercept GA4/Metrika-style events
- [x] Configurable mapping: which dataLayer events → which SURFAI goals
- [x] Default mappings for common GA4 events (`purchase`, `generate_lead`, `sign_up`, `form_submit`)
- [x] Filter/allowlist: only capture events matching configured patterns

### 5.4 Page URL Rule Engine
- [x] SDK option: `pageGoals: [{ goalId, urlPattern, matchType }]`
- [x] `matchType`: `exact`, `contains`, `regex`
- [x] Auto-fire `surfai.goal()` on navigation to matching URL
- [x] SPA support: listen to `popstate` + `pushState`/`replaceState` monkey-patch

### 5.5 Backend Conversion API
- [x] `POST /api/conversions` — server-side conversion registration
- [x] Fields: `sessionId` or `visitorId`, `goalId`, `value`, `metadata`, `ts`
- [x] Lookup: match to existing session by sessionId or latest session by visitorId

### 5.6 Goal Configuration API
- [x] `POST /api/goals` — create goal
- [x] `GET /api/goals` — list goals for tenant (via X-Tenant-Id header)
- [x] `PUT /api/goals/:goalId` — update goal
- [x] `DELETE /api/goals/:goalId` — soft-delete goal
- [x] Goal validation: unique name per tenant, valid type

### 5.7 Dashboard Integration
- [x] Conversion badge in session list (green CONV badge for converted sessions)
- [x] Goal hit timeline in session detail view
- [x] Summary cards: conversion rate, total conversions in header
- [x] Filter sessions by: all / converted / not converted

### 5.8 GTM Custom Tag Template (stretch — deferred)
- [ ] Community Template Gallery-ready GTM tag template
- [ ] Config fields: API endpoint, site ID, behavioral tracking on/off, goal mappings

**Dependencies:** Phase 4.

**Why before ML:** The prediction engine (Phase 6) needs labeled data. Without explicit conversion signals, the model has no ground truth to learn from. This phase produces the `y` variable for supervised learning.

**Status:** All core items implemented. GTM tag template deferred to Phase 8 (SaaS).

---

## Phase 6: CatBoost + DNN Prediction Engine

**Goal:** Real-time visitor intent prediction (conversion, bounce, fraud).

**Deliverables:**
- [ ] Training data pipeline: labeled sessions → feature vectors (uses Phase 5 conversion labels)
- [ ] CatBoost model for tabular features (engagement, session, context)
- [ ] DNN model for sequential features (mouse/scroll time series)
- [ ] Ensemble: CatBoost + DNN weighted combination
- [ ] Model serving API (Python FastAPI or ONNX in Node.js)
- [ ] Prediction endpoint: `POST /api/predict` → intent scores
- [ ] A/B framework: shadow mode for model comparison
- [ ] Model versioning and rollback mechanism

**Dependencies:** Phase 4, Phase 5.

---

## Phase 7: Real-Time Scoring & Triggers

**Goal:** Score visitors in real-time and trigger actions.

**Deliverables:**
- [ ] Streaming score computation (on each batch arrival)
- [ ] Webhook system: fire on score threshold crossings
- [ ] JavaScript callback API: SDK can receive score updates
- [ ] Integration hooks: Slack, email, CRM push
- [ ] Score decay: reduce confidence when user goes idle
- [ ] Dashboard: real-time score overlay per active session
- [ ] Alert rules configuration (UI or config file)

**Dependencies:** Phase 6.

---

## Phase 8: Multi-Tenant SaaS Architecture

**Goal:** Serve multiple customers with isolated data.

**Deliverables:**
- [ ] Tenant management: API keys, site registration
- [ ] Data isolation: schema-per-tenant or row-level security
- [ ] SDK initialization with API key (`new SurfaiTracker({ apiKey, ... })`)
- [ ] Rate limiting per tenant
- [ ] Usage metering and billing hooks
- [ ] Admin dashboard: tenant management, usage stats
- [ ] Onboarding flow: snippet generator, setup wizard

**Dependencies:** Phase 3, Phase 7.

---

## Phase 9: Production Hardening & Scale

**Goal:** Production-grade reliability and performance.

**Deliverables:**
- [ ] Event ingestion via message queue (Redis Streams or Kafka)
- [ ] Horizontal scaling: stateless ingest workers behind load balancer
- [ ] PostgreSQL partitioning: time-based partitions on events table
- [ ] Data retention policies: auto-archive/delete old events
- [ ] Health checks, readiness probes, Prometheus metrics
- [ ] Structured error tracking (Sentry or equivalent)
- [ ] CI/CD pipeline: lint, test, build, deploy
- [ ] Load testing: target 10K events/sec per node
- [ ] Backup and disaster recovery plan

**Dependencies:** Phase 8.

---

## Phase 10: Advanced Analytics & Public API

**Goal:** Deep insights and third-party integrations.

**Deliverables:**
- [ ] Cohort analysis: group visitors by behavior patterns
- [ ] Funnel analysis: conversion path visualization
- [ ] Anomaly detection: unusual behavior pattern alerts
- [ ] Segment builder: define visitor segments by behavior rules
- [ ] Public REST API with versioning (`/v1/sessions`, `/v1/events`)
- [ ] GraphQL API for flexible querying
- [ ] SDK plugins: React, Vue, Angular wrappers
- [ ] Data export: CSV, JSON, warehouse connectors (BigQuery, Snowflake)
- [ ] Documentation site with API reference

**Dependencies:** Phase 9.

---

## Timeline Philosophy

- Each phase builds on the previous; no phase should be started before its dependencies are marked complete.
- Within a phase, tasks can be parallelized where there are no data dependencies.
- The roadmap is a living document — update status and adjust scope as we learn.
