-- Migration: 004_feature_store
-- Feature store table for ML-ready feature vectors per session

CREATE TABLE IF NOT EXISTS session_features (
  id              SERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE REFERENCES sessions(session_id),

  -- Mouse dynamics
  mouse_avg_velocity      DOUBLE PRECISION,  -- px/ms average
  mouse_max_velocity      DOUBLE PRECISION,
  mouse_avg_acceleration  DOUBLE PRECISION,  -- px/ms² average
  mouse_avg_jitter        DOUBLE PRECISION,  -- direction change magnitude
  mouse_avg_curvature     DOUBLE PRECISION,  -- deviation from straight lines
  mouse_total_distance    DOUBLE PRECISION,  -- total px traveled
  mouse_event_count       INTEGER DEFAULT 0,

  -- Mouse sliding windows (JSON arrays of windowed stats)
  mouse_velocity_1s       JSONB,  -- [{ts, avg, max, min}, ...]
  mouse_velocity_5s       JSONB,
  mouse_velocity_30s      JSONB,

  -- Scroll behavior
  scroll_max_depth        DOUBLE PRECISION,  -- 0..100
  scroll_avg_speed        DOUBLE PRECISION,  -- percent/ms
  scroll_direction_changes INTEGER DEFAULT 0,
  scroll_pause_count      INTEGER DEFAULT 0, -- pauses > 2s between scrolls
  scroll_fast_ratio       DOUBLE PRECISION,  -- fraction of fast scrolls
  scroll_slow_ratio       DOUBLE PRECISION,  -- fraction of slow scrolls
  scroll_event_count      INTEGER DEFAULT 0,

  -- Click patterns
  click_total             INTEGER DEFAULT 0,
  click_avg_rhythm_ms     DOUBLE PRECISION,  -- avg ms between clicks
  click_rhythm_std        DOUBLE PRECISION,  -- stddev of inter-click time
  click_spatial_clusters  INTEGER DEFAULT 0, -- distinct spatial clusters (50px radius)
  click_rage_count        INTEGER DEFAULT 0, -- 3+ clicks in <500ms in same area
  click_cta_ratio         DOUBLE PRECISION,  -- fraction of CTA clicks
  click_external_ratio    DOUBLE PRECISION,

  -- Form behavior
  form_total_interactions INTEGER DEFAULT 0,
  form_avg_fill_ms        DOUBLE PRECISION,  -- avg field fill duration
  form_hesitation_count   INTEGER DEFAULT 0, -- focus then idle >3s before input
  form_correction_count   INTEGER DEFAULT 0, -- focus same field multiple times
  form_field_skip_rate    DOUBLE PRECISION,  -- fields focused then abandoned / total
  form_submit_count       INTEGER DEFAULT 0,
  form_abandon_count      INTEGER DEFAULT 0,

  -- Engagement (latest snapshot or aggregated)
  engagement_active_ms    DOUBLE PRECISION,
  engagement_idle_ms      DOUBLE PRECISION,
  engagement_active_ratio DOUBLE PRECISION,  -- activeMs / (activeMs + idleMs)
  engagement_max_scroll   DOUBLE PRECISION,
  engagement_readthrough   BOOLEAN,
  engagement_micro_scrolls INTEGER DEFAULT 0,

  -- Session-level signals
  session_duration_ms     DOUBLE PRECISION,
  session_page_count      INTEGER,
  session_avg_nav_speed   DOUBLE PRECISION,
  session_is_bounce       BOOLEAN,
  session_is_hyper        BOOLEAN,
  session_time_bucket     TEXT,  -- night/morning/day/evening

  -- Context (device/traffic — copied for feature vector completeness)
  ctx_traffic_source      TEXT,
  ctx_device_type         TEXT,
  ctx_browser             TEXT,
  ctx_os                  TEXT,
  ctx_screen_w            INTEGER,
  ctx_screen_h            INTEGER,
  ctx_connection_type     TEXT,

  -- Cross-session
  cross_visit_number      INTEGER,
  cross_return_24h        BOOLEAN,
  cross_return_7d         BOOLEAN,

  -- Metadata
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_count   INTEGER DEFAULT 0,  -- total events used for computation

  CONSTRAINT fk_session FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX idx_session_features_session_id ON session_features (session_id);
CREATE INDEX idx_session_features_computed_at ON session_features (computed_at);
