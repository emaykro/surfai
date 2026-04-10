import os
from pathlib import Path

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://localhost:5432/surfai"
)

ARTIFACTS_DIR = Path(__file__).parent / "artifacts"

TARGET_COLUMN = "converted"

TEST_SIZE = 0.2
RANDOM_SEED = 42
MIN_POSITIVE_SAMPLES = 10

# --- Feature column lists (must match session_features table) ---

NUMERIC_FEATURES = [
    "mouse_avg_velocity",
    "mouse_max_velocity",
    "mouse_avg_acceleration",
    "mouse_avg_jitter",
    "mouse_avg_curvature",
    "mouse_total_distance",
    "mouse_event_count",
    "scroll_max_depth",
    "scroll_avg_speed",
    "scroll_direction_changes",
    "scroll_pause_count",
    "scroll_fast_ratio",
    "scroll_slow_ratio",
    "scroll_event_count",
    "click_total",
    "click_avg_rhythm_ms",
    "click_rhythm_std",
    "click_spatial_clusters",
    "click_rage_count",
    "click_cta_ratio",
    "click_external_ratio",
    "form_total_interactions",
    "form_avg_fill_ms",
    "form_hesitation_count",
    "form_correction_count",
    "form_field_skip_rate",
    "form_submit_count",
    "form_abandon_count",
    "engagement_active_ms",
    "engagement_idle_ms",
    "engagement_active_ratio",
    "engagement_max_scroll",
    "engagement_micro_scrolls",
    "session_duration_ms",
    "session_page_count",
    "session_avg_nav_speed",
    "ctx_screen_w",
    "ctx_screen_h",
    # Extended context (added 2026-04-10)
    "ctx_tz_offset",
    "ctx_language_count",
    "ctx_viewport_w",
    "ctx_viewport_h",
    "ctx_dpr",
    "ctx_hardware_concurrency",
    "ctx_device_memory",
    # GeoIP enrichment (added 2026-04-10)
    "geo_latitude",
    "geo_longitude",
    "geo_asn",
    # Performance / Web Vitals (added 2026-04-10)
    "perf_lcp",
    "perf_fcp",
    "perf_fid",
    "perf_inp",
    "perf_cls",
    "perf_ttfb",
    "perf_dom_interactive",
    "perf_dom_content_loaded",
    "perf_load_event",
    "perf_transfer_size",
    "perf_long_task_count",
    "perf_long_task_total_ms",
    "cross_visit_number",
    "bot_score",
]

BOOLEAN_FEATURES = [
    "engagement_readthrough",
    "session_is_bounce",
    "session_is_hyper",
    "cross_return_24h",
    "cross_return_7d",
    "is_bot",
    # Extended context
    "ctx_reduced_motion",
    # GeoIP enrichment
    "geo_is_datacenter",
    "geo_is_mobile_carrier",
]

CATEGORICAL_FEATURES = [
    "session_time_bucket",
    "ctx_traffic_source",
    "ctx_device_type",
    "ctx_browser",
    "ctx_os",
    "ctx_connection_type",
    # Extended context (added 2026-04-10)
    "ctx_timezone",
    "ctx_color_scheme",
    "ctx_referrer_host",
    "ctx_utm_source",
    "ctx_utm_medium",
    "ctx_utm_campaign",
    "ctx_utm_term",
    "ctx_utm_content",
    # GeoIP enrichment (added 2026-04-10)
    "geo_country",
    "geo_region",
    "geo_city",
    "geo_timezone",
    "geo_asn_org",
]

JSONB_WINDOW_COLUMNS = [
    "mouse_velocity_1s",
    "mouse_velocity_5s",
    "mouse_velocity_30s",
]

# --- CatBoost hyperparameters ---

CATBOOST_PARAMS = {
    "iterations": 1000,
    "learning_rate": 0.05,
    "depth": 6,
    "l2_leaf_reg": 3,
    "loss_function": "Logloss",
    "eval_metric": "AUC",
    "auto_class_weights": "Balanced",
    "early_stopping_rounds": 50,
    "random_seed": RANDOM_SEED,
    "verbose": 100,
    "nan_mode": "Min",
}
