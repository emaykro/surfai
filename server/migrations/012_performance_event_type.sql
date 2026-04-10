-- Migration: 012_performance_event_type
-- Adds the `performance` event type (Core Web Vitals + Navigation Timing
-- + Long Task counters) and the derived perf_* columns on session_features.
--
-- The new event type MUST be added to events.events_type_check atomically
-- with the SDK deploy — see the 2026-04-10 post-mortem in vault/bugs/
-- for what happens when an unrecognized type hits atomic persistBatch.

-- 1. Allow the new event type in the events table
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_type_check;
ALTER TABLE events ADD CONSTRAINT events_type_check
  CHECK (type IN (
    'mouse', 'scroll', 'idle', 'click', 'form', 'engagement',
    'session', 'context', 'cross_session', 'goal', 'bot_signals',
    'performance'
  ));

-- 2. Add derived performance columns to session_features
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_lcp                DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_fcp                DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_fid                DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_inp                DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_cls                DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_ttfb               DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_dom_interactive    DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_dom_content_loaded DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_load_event         DOUBLE PRECISION;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_transfer_size      INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_long_task_count    INTEGER;
ALTER TABLE session_features ADD COLUMN IF NOT EXISTS perf_long_task_total_ms DOUBLE PRECISION;

-- Useful index for dashboard queries like "slowest pages last 24h"
CREATE INDEX IF NOT EXISTS idx_session_features_perf_lcp ON session_features (perf_lcp) WHERE perf_lcp IS NOT NULL;
