# SURFAI — Predictive Behavioral Analytics Platform

> Last updated: 2026-04-10. This file is a quick-reference map of the project for humans and AI agents. Authoritative details live in `CLAUDE.md`, `vault/decisions/`, and the per-package `client/CLAUDE.md` / `server/CLAUDE.md`.

## Vision

Operator-managed predictive analytics for paid-traffic SaaS. We collect behavioral signals on client sites, train per-site ML models to predict conversion intent, and export *synthetic* predictive conversions back to GA4 / Yandex Metrika so ad platforms can optimize on the expanded signal. Expected impact: 20–30% CPA drop.

**Operating model:** internal team runs all projects. No client self-serve yet; onboarding is manual via GTM.

## Platform Status (2026-04-10)

| Layer | Status |
|---|---|
| **Phase 1 — Persistence & SDK hardening** | ✅ Complete |
| **Phase 2 — Expanded event taxonomy** (click, form, engagement, session, context, cross_session) | ✅ Complete |
| **Phase 3 — Feature engineering pipeline** (`server/features/`) | ✅ Complete |
| **Phase 4 — Goals & conversions** (page rules, dataLayer, Metrika reachGoal, server-side) | ✅ Complete |
| **Phase 5 — ML training pipeline** (CatBoost) | ✅ Complete |
| **Phase 6 — Multi-project data model & operator cabinet** | ✅ Complete (active phase) |
| **Phase 7 — Hierarchical ML + bot filtering** | 🟡 In progress (bot detection layer deployed 2026-04-08) |
| **Phase 8 — Predictive export to GA4/Metrika** | ⏳ Not started |
| **Phase 9 — Hardening** | ⏳ Not started |
| **Phase 10 — Public SaaS** | ⏳ Not started |

Master roadmap: `vault/decisions/2026-04-02_long_term_development_roadmap.md`.

## Production Deployment

- Server: `72.56.68.138` (Timeweb VPS, "Kukuruza"), domain `surfai.ru`
- Service: `systemd` unit `surfai`, Fastify on port `3100`, Nginx reverse proxy with TLS
- Database: PostgreSQL (`surfai` DB, `surfai_user`)
- Repo: `github.com/emaykro/surfai` (public, MIT)
- Deploy: `cd /opt/surfai && git pull origin main && npm run build && systemctl restart surfai`
- Migrations: `npm run migrate` (reads `server/migrations/NNN_*.sql`)
- SDK cache: nginx serves `/dist/tracker.js` with `Cache-Control: public, max-age=300, must-revalidate` so SDK fixes propagate within 5 minutes

## Connected Sites (project "Luch", services vertical)

| Domain | Conversion trigger |
|---|---|
| sequoiamusic.ru | page rule `/thx` |
| sluhnn.ru | page rule `?thankyou` (primary) |
| stefcom.ru | Metrika `reachGoal` (no thank-you page) |
| дома-из-теплостен.рф | page rule `/thank-you` |
| химчистка-луч.рф | page rule `/thank-you` |

As of 2026-04-08: ~450–500 sessions/day, >730k events total, 1,880 sessions with computed features, 28 real conversions, first CatBoost model trained (AUC 0.91).

## Tech Stack

| Layer | Tech | Notes |
|---|---|---|
| Browser SDK | Vanilla TypeScript ES6, zero runtime deps | `client/` — compiled via `tsc` + bundled via `esbuild` (IIFE) |
| Ingest server | Node.js + Fastify (CommonJS) | `server/` — JSON Schema on every route, `pg.Pool`, Pino logs |
| Feature store | PostgreSQL `session_features` table | Extractors in `server/features/extractors.js` |
| ML training | Python 3 + CatBoost | `ml/` — CLI entry `python3 -m ml train` |
| Dashboard | Vanilla JS, zero deps | `dashboard/` — session list, live SSE feed, replay |
| Operator cabinet | Vanilla JS SPA | `cabinet/` — project CRUD, site onboarding, snippet copy, goals |

Full details: `CLAUDE.md` at repo root.

## Agents Working on This Project

1. **Claude Code (CLI, Opus 4.6)** — architecture, backend, SDK, ML pipeline, operations
2. **Cursor (IDE)** — real-time edits, UI polish
3. **Human operator (Artur)** — direction, priorities, prod access

Both agents are bound by the **Meta-Sync Protocol** in `CLAUDE.md` and `.cursor/rules/meta-sync.mdc`: any schema, dependency, or build-step change must be mirrored between `CLAUDE.md` (for Claude Code) and `.cursor/rules/*.mdc` (for Cursor) in the same commit.

## Persistent Memory Layers

1. **Constitution layer** — `CLAUDE.md` files (root, `client/`, `server/`). Committed to git. Source of truth.
2. **Vault layer** — `vault/decisions/`, `vault/sessions/`, `vault/bugs/`. Committed to git. Survives context resets.
3. **Auto-memory layer** — `~/.claude/projects/.../memory/`. Per-developer, not in git. Lessons learned, feedback, per-user preferences.

When starting a new session, always read:
1. `CLAUDE.md` (root) — conventions and current phase
2. The latest file in `vault/sessions/` — what was done last time
3. `vault/decisions/2026-04-02_long_term_development_roadmap.md` — where we are in the master plan
