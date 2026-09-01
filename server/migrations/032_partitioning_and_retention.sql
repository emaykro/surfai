-- Migration 032: PostgreSQL Partitioning Helpers and Data Retention Functions
-- Prepares the platform for declarative partitioning and high-throughput retention policies.

-- 1. Function to safely create monthly partition for high-volume logging/raw tables
CREATE OR REPLACE FUNCTION create_monthly_partition(
  parent_table TEXT,
  target_date DATE DEFAULT CURRENT_DATE
) RETURNS TEXT AS $$
DECLARE
  start_date DATE := DATE_TRUNC('month', target_date);
  end_date DATE := DATE_TRUNC('month', target_date + INTERVAL '1 month');
  partition_name TEXT := parent_table || '_y' || TO_CHAR(start_date, 'YYYY') || 'm' || TO_CHAR(start_date, 'MM');
BEGIN
  -- Check if table exists
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = partition_name) THEN
    EXECUTE FORMAT(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L);',
      partition_name, parent_table, start_date, end_date
    );
    RETURN FORMAT('Created partition %s from %s to %s', partition_name, start_date, end_date);
  END IF;
  RETURN FORMAT('Partition %s already exists', partition_name);
EXCEPTION WHEN OTHERS THEN
  RETURN FORMAT('Skipped partition creation for %s: %s', partition_name, SQLERRM);
END;
$$ LANGUAGE plpgsql;

-- 2. Procedure to drop or archive old raw event data beyond retention threshold
CREATE OR REPLACE FUNCTION cleanup_old_raw_batches(days_to_keep INT DEFAULT 90)
RETURNS INT AS $$
DECLARE
  deleted_count INT := 0;
BEGIN
  DELETE FROM raw_batches
  WHERE received_at < NOW() - (days_to_keep * INTERVAL '1 day');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
