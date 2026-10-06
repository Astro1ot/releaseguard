"""Reversible failures in this Compose project only; dependencies restart in finally."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import urlopen
import uuid

from integration import rg, ROOT


def wait_state(component, state, deadline=60):
    until = time.monotonic() + deadline
    while time.monotonic() < until:
        status = rg.request('http://127.0.0.1:3000', '/api/status')
        if any(c['name'] == component and c['state'] == state for c in status['components']): return status
        time.sleep(2)
    raise RuntimeError(f'{component} did not reach {state}')


def drill(component):
    base = 'http://127.0.0.1:3000'; name = {'redis': 'Redis', 'kafka': 'Kafka'}[component]
    wait_state(name, 'operational')
    started = time.monotonic()
    try:
        rg.run(['docker', 'compose', 'stop', component])
        incident = wait_state(name, 'degraded')
        detected = time.monotonic() - started
        assert rg.request(base, '/health/ready')['status'] == 'ready'
        if component == 'redis':
            result = rg.smoke(base)
        else:
            result = rg.smoke(base, fulfillment=False)
            assert result['status'] == 'pending', 'Broker outage should leave new order pending'
    finally:
        rg.run(['docker', 'compose', 'start', component])
    wait_state(name, 'operational', deadline=90)
    if component == 'kafka':
        deadline = time.monotonic() + 90
        while rg.request(base, '/api/orders/' + result['orderId'])['status'] != 'completed':
            if time.monotonic() > deadline: raise RuntimeError('Backlog did not recover')
            time.sleep(2)
    recovered = rg.request(base, '/api/orders/' + result['orderId'])
    return {'scenario': component, 'passed': True, 'detectionSeconds': round(detected, 2), 'totalSeconds': round(time.monotonic() - started, 2), 'orderDuringOutage': result, 'orderAfterRecovery': recovered, 'incident': incident['incidents'][0]}


def rate_limit():
    def hit(_):
        try:
            with urlopen('http://127.0.0.1:8080/api/catalog', timeout=10) as response: return response.status
        except HTTPError as error: return error.code
    with ThreadPoolExecutor(max_workers=50) as executor: counts = Counter(executor.map(hit, range(200)))
    assert counts[429] > 0 and counts[200] > 0, counts
    assert not any(code >= 500 for code in counts), counts
    assert rg.request('http://127.0.0.1:3000', '/health/ready')['status'] == 'ready'
    hidden = {}
    for path in ['/metrics', '/METRICS/', '/health/ready', '/HEALTH/live']:
        try:
            with urlopen('http://127.0.0.1:8080' + path, timeout=5) as response: hidden[path] = response.status
        except HTTPError as error: hidden[path] = error.code
    assert all(code == 404 for code in hidden.values()), hidden
    return {'scenario': 'rate-limit', 'passed': True, 'responses': dict(counts), 'privatePaths': hidden}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('scenario', choices=['redis', 'kafka', 'rate-limit'])
    args = parser.parse_args()
    report = rate_limit() if args.scenario == 'rate-limit' else drill(args.scenario)
    output = ROOT / 'artifacts/drills'; output.mkdir(parents=True, exist_ok=True)
    (output / f'{args.scenario}-{time.time_ns()}.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
