"""Exercise lock_timeout and an additive migration while synthetic writes continue."""
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import time
import uuid
from integration import ROOT, rg


def psql(sql, *, check=True):
    return subprocess.run(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'releaseguard', '-d', 'releaseguard', '-v', 'ON_ERROR_STOP=1', '-tAc', sql], cwd=ROOT, text=True, capture_output=True, check=check)


if __name__ == '__main__':
    locker = subprocess.Popen(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'releaseguard', '-d', 'releaseguard', '-v', 'ON_ERROR_STOP=1', '-c', "SET application_name='rg-lock-drill'; BEGIN; LOCK TABLE orders IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;"], cwd=ROOT, stdout=subprocess.DEVNULL)
    try:
        for attempt in range(30):
            if psql("SELECT count(*) FROM pg_stat_activity WHERE application_name='rg-lock-drill' AND wait_event='PgSleep'").stdout.strip() == '1': break
            time.sleep(.1)
        else: raise RuntimeError('Could not observe blocker')
        started = time.monotonic()
        blocked = psql("SET lock_timeout='500ms'; ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note text", check=False)
        elapsed = time.monotonic() - started
        assert blocked.returncode != 0 and 'lock timeout' in blocked.stderr.lower(), blocked.stderr
        assert elapsed < 5, 'DDL did not fail fast'
    finally:
        locker.wait(timeout=15)
    def write(_):
        start = time.monotonic()
        rg.request('http://127.0.0.1:3000', '/api/orders', body={'productId': 'asset-01'}, key=str(uuid.uuid4()))
        return time.monotonic() - start
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(write, i) for i in range(150)]
        psql("SET lock_timeout='1s'; ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note text")
        # PGOPTIONS preserves a standalone CREATE INDEX (no implicit multi-statement transaction).
        rg.run(['docker', 'compose', 'exec', '-T', '-e', 'PGOPTIONS=-c lock_timeout=1000 -c statement_timeout=60000', 'postgres', 'psql', '-U', 'releaseguard', '-d', 'releaseguard', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_drill_product_idx ON orders(product_id)'])
        latencies = sorted(f.result() for f in futures)
    report = {'scenario': 'migration', 'passed': True, 'blockedDdlSeconds': elapsed, 'writes': len(latencies), 'writeP95Seconds': latencies[int(len(latencies)*.95)], 'invalidIndexes': int(psql("SELECT count(*) FROM pg_index WHERE NOT indisvalid AND indrelid='orders'::regclass").stdout.strip())}
    assert report['invalidIndexes'] == 0
    out = ROOT / 'artifacts/drills'; out.mkdir(parents=True, exist_ok=True)
    (out / f'migration-{time.time_ns()}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
