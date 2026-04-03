# SURFAI — Long-Term Development Roadmap

Master Reference Document. Created 2026-04-02. Updated 2026-04-03.

**Operating model**: Operator-managed predictive analytics platform. Internal team manages all projects. No client self-serve yet.

**Product flow**: Install tracker on client sites via GTM → collect behavioral data + real conversions → train hierarchical ML models → export predictive synthetic conversions back to GA4/Metrika → ad platforms optimize on expanded signal → CPA drops 20-30%.

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

**Dependencies:** Phase 4.

**Status:** All core items implemented.

---

## Phase 6: Multi-Project Data Model & Operator Cabinet

**Goal:** Introduce project/site isolation so we can connect tracker to multiple client sites, store data separately per project, and manage everything from one internal operator console.

**Why now:** Without project isolation, all sessions from all client sites land in one global bucket. We cannot train per-project models, cannot filter dashboard by client, and cannot generate unique tracking snippets.

### 6.1 Data Model — New Tables
- [x] `projects` table: project_id, name, vertical (ecommerce / services / leadgen / education / b2b / other), status (setup / active / paused / archived), created_at
- [x] `sites` table: site_id, project_id FK, domain, site_key (unique tracking token), allowed_origins[], install_method (gtm / direct_script / server_only), install_status (pending / verified / error), last_event_at, created_at
- [ ] `tracker_installations` table: site_id FK, method, gtm_container_id, verified_at, last_health_check, status (deferred — not needed for MVP)

### 6.2 Data Model — Extend Existing Tables
- [x] Add project_id and site_id to sessions, raw_batches, events, session_features
- [x] Add project_id to goals and conversions
- [x] Migration: backfill existing data into a "default" project + "localhost" site
- [x] Indexes on project_id and site_id for all major tables

### 6.3 SDK — Site Identity
- [x] New TrackerOptions.siteKey field (public key identifying the site)
- [x] SDK sends siteKey in every batch payload alongside sessionId
- [x] Server resolves siteKey → project_id + site_id, rejects unknown keys (403)
- [x] Server validates Origin/Referer against sites.allowed_origins
- [x] In-memory site cache (60s TTL) to avoid DB hit per batch
- [x] project_id/site_id stored on sessions, events, raw_batches, session_features, goals, conversions
- [x] GET /api/sessions, GET /api/goals support ?project_id= filter
- [ ] Rate limiting per site_id (deferred)

### 6.4 GTM Integration
- [x] GTM Custom HTML tag template: copy-paste snippet with siteKey pre-filled (via GET /api/sites/:siteId/snippet)
- [x] Install verification endpoint: GET /api/sites/:siteId/verify — checks last_event_at recency
- [ ] Debug mode: SDK sends ping event on init, server confirms receipt (deferred)

### 6.5 Operator Cabinet — Project Management
- [ ] Internal auth (simple password via ENV — deferred to deployment)
- [x] Projects list: name, vertical, sites count, sessions/24h, conversions/24h, status
- [x] Create project: name, vertical
- [x] Project detail: sites tab, goals tab, status toggle
- [x] Add site: domain, allowed origins, install method → generates siteKey + snippet
- [x] Site detail: siteKey, install snippet (GTM + direct), copy to clipboard, verify
- [ ] Goal management per project: create/edit goals from cabinet (deferred)

### 6.6 Operator Cabinet — Data Quality & Health
- [x] Per-site: install status (pending/verified/stale), last event timestamp
- [x] Install verification: check if events received in last 5 min
- [ ] Missing data alerts (deferred)
- [ ] Traffic anomaly flags (deferred)

### 6.7 Ingest Pipeline Changes
- [x] POST /api/events validates siteKey, injects project_id/site_id
- [x] GET /api/sessions, GET /api/goals gain ?project_id= filter
- [x] SSE broadcast includes projectId
- [x] Feature recomputation stores project_id/site_id on session_features

**Dependencies:** Phase 5.

---

## Phase 7: Hierarchical ML Pipeline

**Goal:** Train models that predict conversion probability. Three-tier hierarchy: global baseline → vertical-specific → project-specific. New projects get predictions immediately via global/vertical; project models activate after enough labeled data.

### 7.1 Training Data Pipeline
- [ ] Data loader filters: all, by_vertical, by_project
- [ ] Temporal train/val/test split (never random — always by time)
- [ ] Cross-project validation: hold out entire project to test generalization
- [ ] Feature augmentation: add vertical, site_category as categorical features for global model
- [ ] Minimum data thresholds: global (500 sessions / 50 conversions), vertical (200/20), project (100/10)

### 7.2 Model Hierarchy
- [ ] Global baseline: trained on all projects, vertical as feature
- [ ] Vertical models: per-vertical training (ecommerce, services, leadgen, etc.)
- [ ] Project-specific: fine-tuned on single project data when threshold met
- [ ] CatBoost for all tiers
- [ ] DNN for sequential features (future: after CatBoost baseline works)

### 7.3 Model Registry
- [ ] model_versions table: model_id, scope (global/vertical/project), scope_id, version, metrics JSONB, artifact_path, status, trained_at
- [ ] model_assignments table: project_id, active_model_id, fallback_model_id, serving_policy
- [ ] CLI: train --scope global, train --scope vertical --vertical ecommerce, train --scope project --project-id X

### 7.4 Serving Policy
- [ ] New project (< threshold): global + vertical model
- [ ] Growing project (threshold met): project model primary, global/vertical fallback
- [ ] Automatic promotion when project model outperforms global on holdout

### 7.5 Quality & Monitoring
- [ ] Per-model metrics: AUC-ROC, precision@k, contrast ratio
- [ ] Calibration: predicted probability vs actual conversion rate
- [ ] Drift detection, weekly retraining schedule
- [ ] Shadow mode for new model versions

### 7.6 Operator Cabinet — Model Management
- [ ] Model dashboard: global, vertical, project models with metrics
- [ ] Per-project: active model, accuracy trend, serving policy
- [ ] Manual controls: trigger retrain, promote/rollback, change policy

**Dependencies:** Phase 6.

---

## Phase 8: Predictive Scoring & Analytics Export

**Goal:** Score sessions in real-time, export predictive conversions to GA4/Metrika so ad platforms optimize on expanded signal.

### 8.1 Real-Time Scoring
- [ ] Score computation on each batch arrival
- [ ] session_predictions table: session_id, project_id, model_id, score (0..1), confidence, score_bucket, computed_at
- [ ] Score decay on idle, refresh on activity
- [ ] Prediction API: GET /api/sessions/:sessionId/prediction

### 8.2 Predictive Conversion Logic
- [ ] Per-project thresholds: high (0.8), medium (0.5)
- [ ] Value = goal_price × probability × parity_coefficient
- [ ] Parity balancing: predicted total value ≈ real total value
- [ ] Bot filtering, dedup (max 1 prediction export per session)

### 8.3 GA4 Export (Measurement Protocol v2)
- [ ] prediction_exports table: session_id, project_id, platform, event_name, value, status, sent_at
- [ ] Per-project GA4 config: measurement_id, api_secret
- [ ] Separate events: surfai_predicted_lead, surfai_predicted_purchase (never mixed with real)
- [ ] Include model_version, score_bucket in event params

### 8.4 Yandex.Metrika Export
- [ ] Metrika offline conversions API
- [ ] Per-project config: counter_id, goal_name
- [ ] Distinct predicted goals (never mixed with real)

### 8.5 Export Pipeline
- [ ] Background worker: poll predictions, batch exports
- [ ] Retry with backoff, respect API quotas
- [ ] Export status dashboard per project

**Dependencies:** Phase 7.

---

## Phase 9: Production Hardening & Scale

**Goal:** Production-grade reliability for multiple client sites.

- [ ] Redis Streams for ingest → processing decoupling
- [ ] Horizontal scaling: stateless ingest workers
- [ ] PostgreSQL partitioning (time-based on events/raw_batches)
- [ ] Data retention policies per project
- [ ] Health checks, Prometheus metrics, Sentry
- [ ] CI/CD: GitHub Actions lint → test → build → deploy
- [ ] Zero-downtime deploys
- [ ] Backup and disaster recovery

**Dependencies:** Phase 8.

---

## Phase 10: Public SaaS Layer (Future)

**Goal:** Open platform for self-serve when proven with managed clients.

- [ ] Client registration and login
- [ ] Self-serve project creation and onboarding wizard
- [ ] Billing (usage-based, Stripe)
- [ ] Public REST API with versioning
- [ ] Client-facing dashboard
- [ ] Documentation site
- [ ] SDK framework wrappers (React, Vue, Next.js)
- [ ] Data export (CSV, webhook, warehouse connectors)
- [ ] Consent/cookie compliance layer
- [ ] GDPR/152-FZ data deletion and export

**Dependencies:** Phase 9.

---

## Timeline Philosophy

- Each phase builds on the previous; no phase should be started before its dependencies are marked complete.
- Within a phase, tasks can be parallelized where there are no data dependencies.
- The roadmap is a living document — update status and adjust scope as we learn.
- **Current focus: Phase 6** — without project isolation, we cannot connect real client sites or train meaningful per-project models.
