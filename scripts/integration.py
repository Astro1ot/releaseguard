"""Business integration assertions against a running real dependency lab."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import time
from urllib.error import HTTPError
import uuid
import argparse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rg', ROOT / 'cli/rg.py')
rg = importlib.util.module_from_spec(spec); spec.loader.exec_module(rg)
base = 'http://127.0.0.1:3000'

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-demo', action='store_true', help='Explicitly allow in-memory HTTP checks; not infrastructure verification')
    args = parser.parse_args()
    mode = rg.request(base, '/api/status')['mode']
    if mode != 'infrastructure lab' and not args.allow_demo:
        raise SystemExit('Refusing infrastructure verification against in-memory demo. Stop the demo and start Compose, or explicitly pass --allow-demo for HTTP-only checks.')
    for attempt in range(60):
        try:
            result = rg.smoke(base)
            break
        except (OSError, RuntimeError, KeyError):
            if attempt == 59: raise
            time.sleep(2)
    key = str(uuid.uuid4())
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
        orders = list(pool.map(lambda _: rg.request(base, '/api/orders', body={'productId': 'asset-01'}, key=key), range(40)))
    assert len({o['id'] for o in orders}) == 1, 'Concurrent requests created duplicate orders'
    try:
        rg.request(base, '/api/orders', body={'productId': 'asset-02'}, key=key)
        raise AssertionError('Conflicting payload was accepted')
    except HTTPError as error: assert error.code == 409
    try:
        rg.request(base, '/api/orders', body={'productId': 'asset-01', 'unexpected': True}, key=str(uuid.uuid4()))
        raise AssertionError('Unexpected field accepted')
    except HTTPError as error: assert error.code == 400
    out = ROOT / 'artifacts'; out.mkdir(exist_ok=True)
    (out / 'integration.json').write_text(json.dumps({'mode': mode, 'smoke': result, 'concurrentRequests': 40, 'uniqueOrders': 1, 'conflictStatus': 409, 'unknownFieldStatus': 400}, indent=2))
    print('Integration passed: fulfillment, concurrent idempotency, payload conflict and input validation.')
