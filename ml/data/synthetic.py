"""Synthetic data generator for pipeline smoke tests.

WARNING: This data is for validating the training pipeline only.
Do NOT use synthetic data to evaluate model quality or make product decisions.
"""

import json

import numpy as np
import pandas as pd

from ml.config import (
    BOOLEAN_FEATURES,
    CATEGORICAL_FEATURES,
    JSONB_WINDOW_COLUMNS,
    NUMERIC_FEATURES,
)


def _make_window_array(n_windows, base_value, noise_scale=0.1):
    """Generate a plausible JSONB sliding-window array."""
    windows = []
    ts = 1710000000000
    for i in range(n_windows):
        avg = max(0, base_value + np.random.normal(0, noise_scale * base_value))
        windows.append({
            "ts": ts + i * 500,
            "avg": round(avg, 4),
            "max": round(avg * (1 + np.random.uniform(0.1, 0.5)), 4),
            "min": round(avg * max(0, 1 - np.random.uniform(0.1, 0.5)), 4),
            "count": int(np.random.randint(3, 20)),
        })
    return windows


_CATEGORICAL_VALUES = {
    "session_time_bucket": ["night", "morning", "day", "evening"],
    "ctx_traffic_source": ["direct", "organic", "referral", "social", "paid"],
    "ctx_device_type": ["desktop", "mobile", "tablet"],
    "ctx_browser": ["chrome", "firefox", "safari", "edge"],
    "ctx_os": ["windows", "macos", "linux", "ios", "android"],
    "ctx_connection_type": ["4g", "wifi", "3g", "ethernet"],
}

# Plausible ranges for numeric features: (low, high)
_NUMERIC_RANGES = {
    "mouse_avg_velocity": (0.05, 3.0),
    "mouse_max_velocity": (0.5, 15.0),
    "mouse_avg_acceleration": (0.0001, 0.05),
    "mouse_avg_jitter": (0.1, 2.0),
    "mouse_avg_curvature": (1.0, 3.0),
    "mouse_total_distance": (100, 50000),
    "mouse_event_count": (0, 2000),
    "scroll_max_depth": (0, 100),
    "scroll_avg_speed": (0.001, 0.5),
    "scroll_direction_changes": (0, 50),
    "scroll_pause_count": (0, 20),
    "scroll_fast_ratio": (0, 1),
    "scroll_slow_ratio": (0, 1),
    "scroll_event_count": (0, 500),
    "click_total": (0, 100),
    "click_avg_rhythm_ms": (200, 10000),
    "click_rhythm_std": (100, 5000),
    "click_spatial_clusters": (0, 30),
    "click_rage_count": (0, 10),
    "click_cta_ratio": (0, 1),
    "click_external_ratio": (0, 0.5),
    "form_total_interactions": (0, 50),
    "form_avg_fill_ms": (500, 15000),
    "form_hesitation_count": (0, 10),
    "form_correction_count": (0, 8),
    "form_field_skip_rate": (0, 1),
    "form_submit_count": (0, 5),
    "form_abandon_count": (0, 3),
    "engagement_active_ms": (1000, 300000),
    "engagement_idle_ms": (0, 200000),
    "engagement_active_ratio": (0.1, 1.0),
    "engagement_max_scroll": (0, 100),
    "engagement_micro_scrolls": (0, 50),
    "session_duration_ms": (1000, 600000),
    "session_page_count": (1, 20),
    "session_avg_nav_speed": (500, 30000),
    "ctx_screen_w": (320, 3840),
    "ctx_screen_h": (480, 2160),
    "cross_visit_number": (1, 30),
}


def generate_synthetic_sessions(n=500, conversion_rate=0.15):
    """Generate n synthetic sessions with weak but real correlations to conversion.

    Returns a DataFrame matching the session_features schema.
    """
    rng = np.random.default_rng(42)
    rows = []

    for _ in range(n):
        # Hidden engagement score drives both features and conversion
        engagement = rng.beta(2, 5)

        row = {}

        # Numeric features
        for feat in NUMERIC_FEATURES:
            lo, hi = _NUMERIC_RANGES.get(feat, (0, 1))
            base = rng.uniform(lo, hi)

            # Correlate a few key features with engagement
            if feat == "engagement_active_ratio":
                base = 0.2 + 0.7 * engagement + rng.normal(0, 0.05)
                base = np.clip(base, 0, 1)
            elif feat == "click_cta_ratio":
                base = 0.05 + 0.4 * engagement + rng.normal(0, 0.05)
                base = np.clip(base, 0, 1)
            elif feat == "session_duration_ms":
                base = 3000 + 300000 * engagement + rng.normal(0, 20000)
                base = max(1000, base)
            elif feat == "engagement_max_scroll":
                base = 10 + 80 * engagement + rng.normal(0, 5)
                base = np.clip(base, 0, 100)

            # Integer features
            if feat.endswith("_count") or feat in (
                "session_page_count", "ctx_screen_w", "ctx_screen_h",
                "cross_visit_number", "click_total", "click_spatial_clusters",
            ):
                row[feat] = int(round(base))
            else:
                row[feat] = round(float(base), 4)

        # Boolean features
        for feat in BOOLEAN_FEATURES:
            if feat == "session_is_bounce":
                row[feat] = bool(rng.random() < (0.4 - 0.3 * engagement))
            elif feat == "engagement_readthrough":
                row[feat] = bool(rng.random() < (0.2 + 0.6 * engagement))
            else:
                row[feat] = bool(rng.random() < 0.3)

        # Categorical features
        for feat in CATEGORICAL_FEATURES:
            values = _CATEGORICAL_VALUES[feat]
            row[feat] = rng.choice(values)

        # JSONB window columns
        base_vel = row.get("mouse_avg_velocity", 0.5)
        for col in JSONB_WINDOW_COLUMNS:
            n_windows = int(rng.integers(3, 15))
            row[col] = json.dumps(_make_window_array(n_windows, base_vel))

        # Target: conversion correlated with engagement
        conv_prob = conversion_rate * (1 + 3 * engagement)
        conv_prob = min(conv_prob, 0.95)
        converted = bool(rng.random() < conv_prob)
        row["converted"] = converted
        row["conversion_count"] = int(rng.integers(1, 4)) if converted else 0
        row["primary_goal_converted"] = converted and bool(rng.random() < 0.7)
        row["event_count"] = int(rng.integers(20, 500))

        rows.append(row)

    return pd.DataFrame(rows)
