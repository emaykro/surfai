"""Load session features from PostgreSQL."""

import pandas as pd
import psycopg2

from ml.config import (
    BOOLEAN_FEATURES,
    CATEGORICAL_FEATURES,
    DATABASE_URL,
    JSONB_WINDOW_COLUMNS,
    NUMERIC_FEATURES,
)

# vertical is derived via JOIN on projects — not a raw session_features column
_DERIVED_FEATURES = {"vertical"}


def load_session_features(min_event_count=10, target_column="converted"):
    """Load labeled session features from the database.

    Joins projects to include `vertical` so the model can transfer knowledge
    across sites in the same niche (cold-start path for new sites).
    """
    raw_columns = (
        NUMERIC_FEATURES
        + BOOLEAN_FEATURES
        + [c for c in CATEGORICAL_FEATURES if c not in _DERIVED_FEATURES]
        + JSONB_WINDOW_COLUMNS
        + [target_column, "conversion_count", "primary_goal_converted", "event_count"]
    )

    cols_sql = ", ".join(f"sf.{c}" for c in raw_columns)

    query = f"""
        SELECT {cols_sql},
               COALESCE(p.vertical, '__missing__') AS vertical
        FROM session_features sf
        LEFT JOIN projects p ON p.project_id = sf.project_id
        WHERE sf.event_count >= %(min_events)s
          AND sf.{target_column} IS NOT NULL
          AND (sf.is_bot IS NULL OR sf.is_bot = false)
    """

    conn = psycopg2.connect(DATABASE_URL)
    try:
        df = pd.read_sql_query(query, conn, params={"min_events": min_event_count})
    finally:
        conn.close()

    print(f"Loaded {len(df)} sessions from database (min_events={min_event_count})")
    if "vertical" in df.columns:
        print(f"Verticals: {df['vertical'].value_counts().to_dict()}")
    return df
