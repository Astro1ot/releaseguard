# PostgreSQL migration and lock incident

Owner: platform. Alert: `ReleaseGuardLatency`.

Inspect active waits and blockers:

```sql
SELECT pid, state, wait_event_type, wait_event,
       pg_blocking_pids(pid) AS blockers,
       now() - query_start AS elapsed, left(query, 150) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
ORDER BY query_start;
```

Do not kill arbitrary backends. Identify the owner, transaction age and user impact before cancelling a known lab blocker. The migration runner sets `lock_timeout = 2s`, `statement_timeout = 60s` and uses an advisory lock.

## Expand / migrate / contract

1. Add a nullable column. Old binaries continue to work.
2. Deploy code that can handle both forms, then backfill in small committed primary-key batches. Measure WAL, replica lag, bloat and row locks. A single full-table `UPDATE` can be expensive even without a schema lock.
3. Validate completeness and deploy the new read path.
4. Remove obsolete schema only after the rollback window. Contract is deliberately excluded from automatic migrations in this lab.

The included executable example implements expansion and concurrent indexing. A production backfill/contract release is a documented extension, not an implemented feature.

## Failed concurrent index

```sql
SELECT indexrelid::regclass, indisvalid, indisready
FROM pg_index WHERE indrelid = 'orders'::regclass;
```

`CREATE INDEX CONCURRENTLY IF NOT EXISTS` can silently skip an invalid existing index. The runner checks for invalid indexes before running a nontransactional migration and stops for review. After identifying the exact failed index in the lab, remove that invalid index with `DROP INDEX CONCURRENTLY index_name`, outside a transaction, then retry. Never delete an arbitrary valid index.

Use `python scripts/migration_drill.py` to hold a blocker, assert a fast lock timeout and verify additive DDL while writes continue. Preserve its measured JSON report.
