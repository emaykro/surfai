"""Score unscored sessions with the trained CatBoost model.

Run via:  python3 -m ml score
          python3 -m ml score --model ml/artifacts/latest_model.cbm
          python3 -m ml score --batch-size 1000 --all  # re-score everything
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
    NUMERIC_FEATURES,
)
from ml.data.preprocessing import cast_booleans, expand_jsonb_windows

log = logging.getLogger(__name__)

MIN_EVENT_COUNT = 10
DEFAULT_BATCH_SIZE = 500


def load_model(model_path=None):
    from catboost import CatBoostClassifier

    path = model_path or ARTIFACTS_DIR / "latest_model.cbm"
    model = CatBoostClassifier()
    model.load_model(str(path))
    log.info(f"Loaded model from {path}")
    return model


def _fetch_batch(conn, batch_size, rescore_all):
    columns = (
        ["session_id"]
        + NUMERIC_FEATURES
        + BOOLEAN_FEATURES
        + CATEGORICAL_FEATURES
        + JSONB_WINDOW_COLUMNS
    )
    cols_sql = ", ".join(columns)
    score_filter = "" if rescore_all else "AND model_prediction_score IS NULL"
    query = f"""
        SELECT {cols_sql}
        FROM session_features
        WHERE event_count >= %(min_events)s
          AND (is_bot IS NULL OR is_bot = false)
          {score_filter}
        ORDER BY computed_at DESC
        LIMIT %(batch_size)s
    """
    return pd.read_sql_query(
        query, conn, params={"min_events": MIN_EVENT_COUNT, "batch_size": batch_size}
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
    conn = psycopg2.connect(DATABASE_URL)
    total_scored = 0
    try:
        while True:
            df = _fetch_batch(conn, batch_size, rescore_all)
            if df.empty:
                break
            session_ids = df["session_id"].tolist()
            df = df.drop(columns=["session_id"])
            X, _ = _preprocess(df)
            scores = model.predict_proba(X)[:, 1]
            _write_scores(conn, session_ids, scores)
            total_scored += len(session_ids)
            log.info(f"Scored batch of {len(session_ids)} (total so far: {total_scored})")
            if len(session_ids) < batch_size:
                break
    finally:
        conn.close()
    log.info(f"Scoring complete. Total sessions scored: {total_scored}")
    return total_scored
