-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_pending_idx ON outbox(created_at) WHERE published_at IS NULL;
