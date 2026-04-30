"""Score unscored sessions with the trained CatBoost model.

Run via:  python3 -m ml score
          python3 -m ml score --model ml/artifacts/latest_model.cbm
          python3 -m ml score --batch-size 1000 --all  # re-score everything

Cold-start strategy:
  Sites with fewer than MIN_SITE_CONVERSIONS real conversions are scored with
  the global base model (which knows the vertical's patterns from other sites).
  This is logged so operators can track when a site graduates to site-specific
  model territory.
"""

import logging

import numpy as np
import pandas as pd
import psycopg2

from ml.config import (
    ARTIFACTS_DIR,
    BOOLEAN_FEATURES,
    CATEGORICAL_FEATURES,
    DATABASE_URL,
    JSONB_WINDOW_COLUMNS,
    MIN_SITE_CONVERSIONS,
    NUMERIC_FEATURES,
)
from ml.data.preprocessing import cast_booleans, expand_jsonb_windows

log = logging.getLogger(__name__)

MIN_EVENT_COUNT = 10
DEFAULT_BATCH_SIZE = 500

# derived via JOIN — not a raw session_features column
_DERIVED_FEATURES = {"vertical"}


def load_model(model_path=None):
    from catboost import CatBoostClassifier

    path = model_path or ARTIFACTS_DIR / "latest_model.cbm"
    model = CatBoostClassifier()
    model.load_model(str(path))
    log.info(f"Loaded model from {path}")
    return model


def load_calibrator(calibrator_path=None):
    """Load isotonic regression calibrator if it exists. Returns None gracefully."""
    import joblib

    path = calibrator_path or ARTIFACTS_DIR / "latest_calibrator.pkl"
    if not path.exists():
        log.info("No calibrator found — using raw model probabilities")
        return None
    calibrator = joblib.load(str(path))
    log.info(f"Loaded calibrator from {path}")
    return calibrator


def _fetch_site_conversion_counts(conn):
    """Return {site_id: conversion_count} for all sites."""
    cur = conn.cursor()
    cur.execute(
        """SELECT sf.site_id, COUNT(*) AS conv_count
           FROM session_features sf
           WHERE sf.converted = true
           GROUP BY sf.site_id"""
    )
    result = {row[0]: row[1] for row in cur.fetchall()}
    cur.close()
    return result


def _fetch_ids(conn, rescore_all):
    """Return all session_ids that need scoring, ordered newest first."""
    score_filter = "" if rescore_all else "AND model_prediction_score IS NULL"
    cur = conn.cursor()
    cur.execute(
        f"""SELECT session_id FROM session_features
            WHERE event_count >= %s
              AND (is_bot IS NULL OR is_bot = false)
              {score_filter}
            ORDER BY computed_at DESC""",
        (MIN_EVENT_COUNT,),
    )
    ids = [row[0] for row in cur.fetchall()]
    cur.close()
    return ids


def _fetch_features_for_ids(conn, session_ids):
    raw_cols = (
        ["session_id"]
        + NUMERIC_FEATURES
        + BOOLEAN_FEATURES
        + [c for c in CATEGORICAL_FEATURES if c not in _DERIVED_FEATURES]
        + JSONB_WINDOW_COLUMNS
    )
    cols_sql = ", ".join(f"sf.{c}" for c in raw_cols)
    placeholders = ",".join(["%s"] * len(session_ids))
    return pd.read_sql_query(
        f"""SELECT {cols_sql},
                   COALESCE(p.vertical, '__missing__') AS vertical
            FROM session_features sf
            LEFT JOIN projects p ON p.project_id = sf.project_id
            WHERE sf.session_id IN ({placeholders})""",
        conn,
        params=session_ids,
    )


def _preprocess(df):
    df = expand_jsonb_windows(df)
    df = cast_booleans(df)

    window_features = []
    for col in JSONB_WINDOW_COLUMNS:
        for suffix in ("mean_avg", "std_avg", "max_max", "min_min", "count_sum", "trend"):
            window_features.append(f"{col}_{suffix}")

    all_features = NUMERIC_FEATURES + window_features + BOOLEAN_FEATURES + CATEGORICAL_FEATURES
    available = [f for f in all_features if f in df.columns]

    X = df[available].copy()
    for col in CATEGORICAL_FEATURES:
        if col in X.columns:
            X[col] = X[col].fillna("__missing__").astype(str)

    return X, available


def _write_scores(conn, session_ids, scores):
    cur = conn.cursor()
    for sid, score in zip(session_ids, scores):
        cur.execute(
            """UPDATE session_features
               SET model_prediction_score = %s, model_scored_at = NOW()
               WHERE session_id = %s""",
            (float(score), sid),
        )
    conn.commit()
    cur.close()


def run_scoring(model_path=None, batch_size=DEFAULT_BATCH_SIZE, rescore_all=False):
    model = load_model(model_path)
    calibrator = load_calibrator()

    conn = psycopg2.connect(DATABASE_URL)
    total_scored = 0

    try:
        site_conv_counts = _fetch_site_conversion_counts(conn)

        # Log cold-start status for each site
        cold_start_sites = {
            sid: cnt for sid, cnt in site_conv_counts.items()
            if cnt < MIN_SITE_CONVERSIONS
        }
        graduated_sites = {
            sid: cnt for sid, cnt in site_conv_counts.items()
            if cnt >= MIN_SITE_CONVERSIONS
        }
        if cold_start_sites:
            log.info(
                f"Cold-start sites (< {MIN_SITE_CONVERSIONS} conversions, using global model): "
                + ", ".join(f"{sid}={cnt}" for sid, cnt in cold_start_sites.items())
            )
        if graduated_sites:
            log.info(
                f"Graduated sites (>= {MIN_SITE_CONVERSIONS} conversions): "
                + ", ".join(f"{sid}={cnt}" for sid, cnt in graduated_sites.items())
            )

        all_ids = _fetch_ids(conn, rescore_all)
        log.info(f"Sessions to score: {len(all_ids)}")

        expected_features = list(model.feature_names_) if hasattr(model, "feature_names_") else None

        for i in range(0, len(all_ids), batch_size):
            batch_ids = all_ids[i: i + batch_size]
            df = _fetch_features_for_ids(conn, batch_ids)
            session_ids = df["session_id"].tolist()
            df = df.drop(columns=["session_id"], errors="ignore")
            X, available = _preprocess(df)

            # Fail fast on feature drift instead of letting CatBoost emit
            # cryptic "cat_features[N] = M" errors. Catches the case where
            # FEATURE_COLUMNS changed but the model wasn't retrained, OR a
            # column expected by the model is missing from the scoring df.
            if expected_features is not None and i == 0:
                missing = [f for f in expected_features if f not in X.columns]
                extra = [f for f in X.columns if f not in expected_features]
                if missing or extra:
                    raise RuntimeError(
                        "Feature drift between trained model and scoring df. "
                        f"Model expects {len(expected_features)} features, df has {len(X.columns)}. "
                        f"Missing in df: {missing[:8]}{'…' if len(missing) > 8 else ''}. "
                        f"Extra in df: {extra[:8]}{'…' if len(extra) > 8 else ''}. "
                        "Retrain the model (python3 -m ml train) or fix the feature pipeline."
                    )
                # Reorder columns to match the model's training order — defensive.
                X = X[expected_features]

            raw_scores = model.predict_proba(X)[:, 1]

            # Apply calibrator so stored scores are calibrated probabilities,
            # not raw model outputs. Critical for synthetic conversion accuracy.
            if calibrator is not None:
                scores = calibrator.predict(raw_scores)
            else:
                scores = raw_scores

            _write_scores(conn, session_ids, scores)
            total_scored += len(session_ids)
            log.info(f"Scored batch of {len(session_ids)} (total so far: {total_scored})")

    finally:
        conn.close()

    log.info(f"Scoring complete. Total sessions scored: {total_scored}")
    return total_scored
