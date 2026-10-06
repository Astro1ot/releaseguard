import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { createHash } from 'node:crypto';

async function migrate() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET lock_timeout='2s'; SET statement_timeout='60s'");
    await client.query('SELECT pg_advisory_lock(772619)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = resolve(process.cwd(), 'migrations');
    for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
      const sql = readFileSync(resolve(dir, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = (await client.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name])).rows[0];
      if (existing) { if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`); continue; }
      if (sql.includes('-- no-transaction')) {
        // Concurrent indexes must be outside a transaction, one SQL statement per file.
        // IF NOT EXISTS alone can silently retain an invalid index after failure.
        const invalid = await client.query('SELECT indexrelid::regclass::text AS name FROM pg_index WHERE NOT indisvalid AND indrelid IN (\'orders\'::regclass, \'outbox\'::regclass)');
        if (invalid.rowCount) throw new Error('Invalid index exists. Follow docs/runbooks/postgres.md before retrying.');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      } else {
        await client.query('BEGIN');
        try { await client.query(sql); await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, checksum]); await client.query('COMMIT'); }
        catch (error) { await client.query('ROLLBACK'); throw error; }
      }
      console.log(`Applied ${name}`);
    }
  } finally { await client.end(); }
}
void migrate().catch(error => { console.error(error.message); process.exitCode = 1; });
