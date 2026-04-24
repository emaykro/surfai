-- Migration 025: Core Web Vitals degradation flags
-- Derived from perf_* raw metrics using Google's "Needs Improvement" thresholds.
-- Used as control variables in CatBoost: low engagement on a slow page is
-- explained by perf_slow_lcp=true, not by low intent.
-- NULL when the metric was not captured (short bounce, unsupported browser).
ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS perf_slow_lcp  BOOLEAN,
  ADD COLUMN IF NOT EXISTS perf_slow_inp  BOOLEAN,
  ADD COLUMN IF NOT EXISTS perf_slow_fcp  BOOLEAN,
  ADD COLUMN IF NOT EXISTS perf_slow_ttfb BOOLEAN;
