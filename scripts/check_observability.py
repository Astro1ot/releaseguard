"""Verify real monitoring endpoints without printing local credentials."""
import base64
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[1]


def get(url, auth=None):
    headers = {}
    if auth: headers['Authorization'] = 'Basic ' + base64.b64encode(auth.encode()).decode()
    with urlopen(Request(url, headers=headers), timeout=10) as response: return json.load(response)


if __name__ == '__main__':
    env = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines() if line and not line.startswith('#'))
    targets = get('http://127.0.0.1:9090/api/v1/targets')['data']['activeTargets']
    assert any(t['labels'].get('job') == 'releaseguard' and t['health'] == 'up' for t in targets)
    query = get('http://127.0.0.1:9090/api/v1/query?' + urlencode({'query': 'sum(rg_http_requests_total)'}))
    assert query['status'] == 'success' and float(query['data']['result'][0]['value'][1]) > 0
    groups = get('http://127.0.0.1:9090/api/v1/rules')['data']['groups']
    rules = [r for g in groups for r in g['rules']]
    expected = {'ReleaseGuardUnavailable', 'ReleaseGuardErrors', 'ReleaseGuardDependency',
                'ReleaseGuardLag', 'ReleaseGuardLatency', 'ReleaseGuardRejectedEvents'}
    assert expected <= {r['name'] for r in rules} and all(r['health'] == 'ok' for r in rules)
    grafana = get('http://127.0.0.1:3001/api/datasources/uid/prometheus/health', 'admin:' + env['GRAFANA_PASSWORD'])
    assert grafana['status'] == 'OK'
    alertmanager = get('http://127.0.0.1:9093/api/v2/status')
    assert 'versionInfo' in alertmanager
    report = {'passed': True, 'prometheusTarget': 'up', 'ruleCount': len(rules), 'ruleHealth': 'ok', 'grafanaDatasource': grafana['status'], 'alertmanager': 'reachable'}
    folder = ROOT / 'artifacts'; folder.mkdir(exist_ok=True)
    (folder / 'observability.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
