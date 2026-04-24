"""Behavioral session clustering.

Fits a k-means model on purely behavioral features (no context / geo / perf)
and writes cluster labels to session_features.behavior_cluster.

Run via:  python3 -m ml cluster
          python3 -m ml cluster --k 6
          python3 -m ml cluster --all   # re-cluster already-labelled sessions
"""

import logging

import joblib
import numpy as np
import pandas as pd
import psycopg2
from sklearn.cluster import KMeans
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from ml.config import ARTIFACTS_DIR, CLUSTER_FEATURES, DATABASE_URL, K_CLUSTERS, RANDOM_SEED

log = logging.getLogger(__name__)

_PIPELINE_PATH = ARTIFACTS_DIR / "latest_kmeans_pipeline.pkl"


# ---------------------------------------------------------------------------
# Fit
# ---------------------------------------------------------------------------

def fit_cluster_pipeline(df: pd.DataFrame, k: int = K_CLUSTERS) -> Pipeline:
    """Fit imputer → scaler → KMeans on available CLUSTER_FEATURES columns."""
    available = [c for c in CLUSTER_FEATURES if c in df.columns]
    if not available:
        raise ValueError("No CLUSTER_FEATURES available in dataframe")

    log.info(f"Fitting k-means (k={k}) on {len(available)} behavioral features, "
             f"{len(df)} sessions")

    X = df[available].copy().astype(float)

    pipeline = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
        ("kmeans", KMeans(n_clusters=k, random_state=RANDOM_SEED, n_init=10)),
    ])
    pipeline.fit(X)

    inertia = pipeline.named_steps["kmeans"].inertia_
    log.info(f"k-means inertia: {inertia:.1f}")

    return pipeline


def save_pipeline(pipeline: Pipeline) -> None:
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipeline, _PIPELINE_PATH)
    log.info(f"Saved cluster pipeline → {_PIPELINE_PATH}")


def load_pipeline() -> Pipeline:
    if not _PIPELINE_PATH.exists():
        raise FileNotFoundError(
            f"No cluster pipeline found at {_PIPELINE_PATH}. "
            "Run `python3 -m ml cluster` first."
        )
    pipeline = joblib.load(_PIPELINE_PATH)
    log.info(f"Loaded cluster pipeline from {_PIPELINE_PATH}")
    return pipeline


# ---------------------------------------------------------------------------
# Assign
# ---------------------------------------------------------------------------

def assign_clusters(df: pd.DataFrame, pipeline: Pipeline) -> np.ndarray:
    available = [c for c in CLUSTER_FEATURES if c in df.columns]
    X = df[available].copy().astype(float)
    return pipeline.predict(X).astype(int)


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def run_clustering(k: int = K_CLUSTERS, recluster_all: bool = False) -> int:
    conn = psycopg2.connect(DATABASE_URL)
    total_written = 0

    try:
        cluster_filter = "" if recluster_all else "AND behavior_cluster IS NULL"
        available_cols = ", ".join(f"sf.{c}" for c in CLUSTER_FEATURES)

        df = pd.read_sql_query(
            f"""SELECT sf.session_id, {available_cols}
                FROM session_features sf
                WHERE sf.event_count >= 10
                  AND (sf.is_bot IS NULL OR sf.is_bot = false)
                  {cluster_filter}""",
            conn,
        )

        if df.empty:
            log.info("No sessions to cluster.")
            return 0

        log.info(f"Sessions to cluster: {len(df)}")

        # Fit new pipeline or load existing (prefer fitting fresh when recluster_all)
        if recluster_all or not _PIPELINE_PATH.exists():
            pipeline = fit_cluster_pipeline(df, k=k)
            save_pipeline(pipeline)
        else:
            pipeline = load_pipeline()

        labels = assign_clusters(df, pipeline)

        # Write labels back to DB
        cur = conn.cursor()
        for session_id, label in zip(df["session_id"], labels):
            cur.execute(
                "UPDATE session_features SET behavior_cluster = %s WHERE session_id = %s",
                (int(label), session_id),
            )
        conn.commit()
        cur.close()

        total_written = len(df)
        log.info(f"Wrote behavior_cluster for {total_written} sessions")

        # Log cluster sizes
        unique, counts = np.unique(labels, return_counts=True)
        for cluster_id, count in zip(unique, counts):
            pct = count / len(labels) * 100
            log.info(f"  Cluster {cluster_id}: {count} sessions ({pct:.1f}%)")

    finally:
        conn.close()

    return total_written
