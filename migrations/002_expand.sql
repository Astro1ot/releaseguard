-- Additive migration: old binaries continue to run. No rewrite / backfill here.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
