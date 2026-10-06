"""Bounded synthetic load. Saves measured results, never invented performance claims."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import statistics
import time
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url', default='http://127.0.0.1:3000/api/catalog')
    p.add_argument('--requests', type=int, default=500)
    p.add_argument('--concurrency', type=int, default=10)
    args = p.parse_args()
    if not 1 <= args.requests <= 10000 or not 1 <= args.concurrency <= 100: p.error('Use 1–10000 requests and 1–100 workers')
    def hit(_):
        start = time.monotonic()
        try:
            with urlopen(args.url, timeout=5) as response: response.read(); status = response.status
        except HTTPError as error: status = error.code
        except (URLError, TimeoutError): status = 0
        return status, (time.monotonic() - start) * 1000
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool: results = list(pool.map(hit, range(args.requests)))
    elapsed = time.monotonic() - started
    latencies = sorted(r[1] for r in results)
    report = {'url': args.url, 'requests': args.requests, 'concurrency': args.concurrency, 'durationSeconds': elapsed, 'rps': args.requests / elapsed, 'statusCounts': dict(Counter(r[0] for r in results)), 'latencyMs': {'p50': statistics.median(latencies), 'p95': latencies[min(len(latencies)-1, int(len(latencies)*.95))], 'max': max(latencies)}}
    folder = Path(__file__).resolve().parents[1] / 'artifacts/load'; folder.mkdir(parents=True, exist_ok=True)
    (folder / f'{time.time_ns()}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
