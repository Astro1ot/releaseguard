-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_created_at_idx ON orders(created_at);
