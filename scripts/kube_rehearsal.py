"""Use only with a dedicated lab namespace. Exercises an actual Helm rollback."""
import argparse
import json
import subprocess
import sys
import time
from integration import ROOT, rg

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--context', required=True)
    parser.add_argument('--namespace', required=True)
    args = parser.parse_args()
    # Port-forward the edge, not a pod: reconnect automatically after API rollout.
    forward = subprocess.Popen(['kubectl', '--context', args.context, '-n', args.namespace, 'port-forward', 'service/releaseguard-edge', '18080:8080'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ready_deadline = time.monotonic() + 120
        for attempt in range(30):
            try: rg.smoke('http://127.0.0.1:18080', timeout=20); break
            except (OSError, RuntimeError):
                if attempt == 29 or time.monotonic() >= ready_deadline: raise
                time.sleep(2)
        before = set((ROOT / 'artifacts/releases').glob('*.json')) if (ROOT / 'artifacts/releases').exists() else set()
        result = subprocess.run([sys.executable, str(ROOT / 'cli/rg.py'), 'deploy', '--context', args.context, '--namespace', args.namespace, '--environment', 'local', '--fault', 'catalog-500', '--url', 'http://127.0.0.1:18080'], cwd=ROOT)
        assert result.returncode == 1, 'Failed release must remain a failed pipeline'
        paths = set((ROOT / 'artifacts/releases').glob('*.json')) - before
        assert len(paths) == 1
        report = json.loads(paths.pop().read_text())
        assert report.get('rollback') == 'verified', report
        assert report['result'] == 'failed', report
        print('Bad release rejected, exact previous revision restored, business smoke passed.')
    finally:
        forward.terminate()
        try: forward.wait(timeout=5)
        except subprocess.TimeoutExpired: forward.kill(); forward.wait()
