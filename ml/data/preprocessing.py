"""Feature preprocessing: JSONB expansion, boolean casting, feature preparation."""

import json

import numpy as np
import pandas as pd

from ml.config import (
    BOOLEAN_FEATURES,
    CATEGORICAL_FEATURES,
    JSONB_WINDOW_COLUMNS,
    NUMERIC_FEATURES,
    TARGET_COLUMN,
)


def expand_jsonb_windows(df):
    """Expand JSONB sliding-window columns into numeric aggregates.

    Each JSONB column produces 6 features:
      - {col}_mean_avg: mean of window averages
      - {col}_std_avg: std of window averages
      - {col}_max_max: peak value across all windows
      - {col}_min_min: floor value across all windows
      - {col}_count_sum: total data points
      - {col}_trend: velocity trend (positive = speeding up)
    """
    df = df.copy()
    new_cols = {}

    for col in JSONB_WINDOW_COLUMNS:
        if col not in df.columns:
            continue

        mean_avgs = []
        std_avgs = []
        max_maxs = []
        min_mins = []
        count_sums = []
        trends = []

        for val in df[col]:
            # Handle various input formats
            if val is None or (isinstance(val, float) and np.isnan(val)):
                mean_avgs.append(np.nan)
                std_avgs.append(np.nan)
                max_maxs.append(np.nan)
                min_mins.append(np.nan)
                count_sums.append(np.nan)
                trends.append(np.nan)
                continue

            windows = val if isinstance(val, list) else json.loads(val)
            if not windows:
                mean_avgs.append(np.nan)
                std_avgs.append(np.nan)
                max_maxs.append(np.nan)
                min_mins.append(np.nan)
                count_sums.append(np.nan)
                trends.append(np.nan)
                continue

            avgs = [w["avg"] for w in windows]
            mean_avgs.append(np.mean(avgs))
            std_avgs.append(np.std(avgs) if len(avgs) > 1 else 0.0)
            max_maxs.append(max(w["max"] for w in windows))
            min_mins.append(min(w["min"] for w in windows))
            count_sums.append(sum(w["count"] for w in windows))

            if len(avgs) > 1:
                trends.append((avgs[-1] - avgs[0]) / len(avgs))
            else:
                trends.append(0.0)

        new_cols[f"{col}_mean_avg"] = mean_avgs
        new_cols[f"{col}_std_avg"] = std_avgs
        new_cols[f"{col}_max_max"] = max_maxs
        new_cols[f"{col}_min_min"] = min_mins
        new_cols[f"{col}_count_sum"] = count_sums
        new_cols[f"{col}_trend"] = trends

        df = df.drop(columns=[col])

    for name, values in new_cols.items():
        df[name] = values

    return df


def cast_booleans(df):
    """Convert boolean columns to int 0/1."""
    df = df.copy()
    for col in BOOLEAN_FEATURES:
        if col in df.columns:
            df[col] = df[col].map({True: 1, False: 0, None: np.nan})
    return df


def prepare_features(df, target_column=None):
    """Full preprocessing pipeline.

    Returns (X, y, feature_names, cat_indices).
    """
    target = target_column or TARGET_COLUMN

    df = expand_jsonb_windows(df)
    df = cast_booleans(df)

    # Build ordered feature list: numeric + expanded JSONB + booleans + categoricals
    window_features = []
    for col in JSONB_WINDOW_COLUMNS:
        for suffix in ("mean_avg", "std_avg", "max_max", "min_min", "count_sum", "trend"):
            window_features.append(f"{col}_{suffix}")

    all_features = NUMERIC_FEATURES + window_features + BOOLEAN_FEATURES + CATEGORICAL_FEATURES

    # Keep only columns that exist in the dataframe
    available = [f for f in all_features if f in df.columns]

    X = df[available].copy()
    y = df[target].astype(int)

    # Fill categorical NaN
    for col in CATEGORICAL_FEATURES:
        if col in X.columns:
            X[col] = X[col].fillna("__missing__").astype(str)

    # Identify categorical column indices for CatBoost
    cat_indices = [i for i, f in enumerate(available) if f in CATEGORICAL_FEATURES]
    feature_names = available

    return X, y, feature_names, cat_indices
