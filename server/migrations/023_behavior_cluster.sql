-- Migration 023: behavioral cluster label for each session
-- Assigned by `python3 -m ml cluster` (k-means on behavioral features only).
-- NULL until the cluster job has run at least once.
-- Treated as a categorical feature in CatBoost (fillna → "__missing__").
ALTER TABLE session_features
  ADD COLUMN IF NOT EXISTS behavior_cluster SMALLINT;
