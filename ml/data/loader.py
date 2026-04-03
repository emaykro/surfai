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


def load_session_features(min_event_count=10, target_column="converted"):
    """Load labeled session features from the database.

    Only returns sessions with enough events and a non-null target.
    """
    columns = (
        NUMERIC_FEATURES
        + BOOLEAN_FEATURES
        + CATEGORICAL_FEATURES
        + JSONB_WINDOW_COLUMNS
        + [target_column, "conversion_count", "primary_goal_converted", "event_count"]
    )

    cols_sql = ", ".join(columns)

    query = f"""
        SELECT {cols_sql}
        FROM session_features
        WHERE event_count >= %(min_events)s
          AND {target_column} IS NOT NULL
    """

    conn = psycopg2.connect(DATABASE_URL)
    try:
        df = pd.read_sql_query(query, conn, params={"min_events": min_event_count})
    finally:
        conn.close()

    print(f"Loaded {len(df)} sessions from database (min_events={min_event_count})")
    return df
