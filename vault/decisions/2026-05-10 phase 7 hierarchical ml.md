# Phase 7 — Hierarchical ML (per-site fine-tuned models)

**Date:** 2026-05-10
**Status:** decided, implementation starting same day
**Supersedes parts of:** `2026-04-02_long_term_development_roadmap.md` (Phase 7 spec)

## Context

We are at the end of Phase 6.5 (Data Enrichment Sprint). Aggregate state on prod 2026-05-10:

- 12 699 sessions / 30 days, 3 931 / 7 days
- 203 conversions / 30 days, 80 / 7 days — well past the ~50 retrain threshold for the enriched feature set
- 4 of 7 sites have **graduated** past the cold-start threshold (`MIN_SITE_CONVERSIONS = 30`):
  d985…=63, e318…=39, b4bf…=33, 7364…=38
- v4 global model trained 2026-04-30, AUC 0.9973, scoring covers 99.3% of mature sessions

CLAUDE.md ML Architecture section already named two tiers:
- **Tier 1** (in production): one global CatBoost model, `site_id` + `vertical` as categorical features
- **Tier 2** (deferred until Phase 7): per-site fine-tuned models, routed by site_id

This decision activates Tier 2.

## Decision

For every graduated site (≥ 30 conversions), train a **per-site CatBoost model fine-tuned from the current global model** and use it for scoring that site's traffic. Cold-start sites continue scoring against the global model (current behaviour).

Three architecture choices:

### 1. Fine-tuning strategy: init from global + continue training

Each per-site model is initialized with the global model's weights via CatBoost's `init_model=global_model` and continues training on the site's own rows. Lower iterations (200) and a lower learning rate (0.02) — we are nudging the global weights toward site-specific patterns, not retraining from scratch.

**Why not from-scratch?** 33–63 conversions for a 130-feature model is a near-guaranteed overfit. Global init carries the patterns the model already learned across sites in the same vertical.

**Why not stacking (global score → meta)?** More moving parts, two models to keep in sync, harder to debug feature drift. Init+continue is the simplest CatBoost-native path.

### 2. Routing: in-memory dict in `score.py`

At scorer startup, `score.py` loads `latest_model.cbm` (global) and globs `artifacts/site_*_model.cbm` into a `{site_id: (model, calibrator)}` dict. During scoring, sessions are grouped by `site_id` and each group is scored with its site model when present, otherwise the global model.

**Why not a `model_registry` table in DB?** Overkill for 4 sites. The filesystem already gives us atomic deploys (rsync + restart). A registry would add complexity without solving a problem we have.

### 3. Regression guard: don't deploy site model if it underperforms global

For each graduated site we evaluate **both** the freshly-fine-tuned site model and the existing global model **on the site's validation slice**. If `site_auc < global_auc - 0.005`, the site model is discarded and that site stays on the global path. Per-site decision — never an all-or-nothing rollback.

The 0.005 epsilon prevents flapping near the noise floor.

## What changes

| File | Change |
|---|---|
| `ml/training/site_models.py` | new — `train_site_models(global_model, df, X, y, ...)` builds, evaluates, and saves per-site models |
| `ml/training/evaluation.py` | `save_artifacts()` accepts `name_prefix` so site models save under `site_<id>_model.cbm` / `site_<id>_calibrator.pkl` |
| `ml/cli.py` | `cmd_train` calls `train_site_models()` after global save; prints per-site AUC vs global summary |
| `ml/score.py` | loads site models at startup, groups sessions by site_id, routes each group to its own model |
| `CLAUDE.md` | flip ML Architecture section: "Tier 2 (future)" → "Tier 2 (active 2026-05-10)" |
| `.cursor/rules/engineering-discipline.mdc` | new baseline AUC = max(global, best per-site) |

No new migrations, no schema changes, no new event types. Existing `model_prediction_score` column already stores the calibrated probability — orthogonal to which model produced it.

## Rollout

1. Implement on local
2. Smoke test with `python3 -m ml train --synthetic` (synthetic has 1 site → all cold-start; verifies no crash on the per-site loop)
3. Push to prod, `git pull && python3 -m ml train`
4. Inspect per-site AUC summary; expect 4 site models written (or fewer if any underperform global)
5. Next `surfai-ml-score` timer tick (within 5 min) loads site models, routes accordingly
6. Watch dashboard `/api/ml/readiness` and per-site conversions for a week before declaring Phase 7 complete

## Reversibility

Trivial. Delete `artifacts/site_*_model.cbm` and the next scorer pass falls back to global for everyone. Any future global retrain naturally invalidates stale site models — they're keyed off whatever global was current when they were fine-tuned, so we re-fine-tune them in the same train pass.

## Open questions parked for later

- **Site model staleness.** A site model fine-tuned today and never refreshed will drift as the site's traffic evolves. For now: every global retrain refreshes all site models. Add a TTL alert later if global retrains become rare.
- **What about cold-start sites that just crossed 30 conv?** Picked up automatically on the next training run — `_fetch_site_conversion_counts` in `score.py` already inspects this.
- **Per-site calibrators** are saved alongside per-site models. Open question whether they meaningfully differ from the global calibrator on small validation slices; tracked in metrics output for observation.
