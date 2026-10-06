"""Force a handler database timeout and verify supervised consumer recovery."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
result = subprocess.run(
    ['docker', 'compose', 'exec', '-T', 'api', 'node', '-'],
    input=(root / 'scripts/consumer_recovery.cjs').read_text(encoding='utf-8'),
    cwd=root, text=True, capture_output=True, check=False, timeout=100,
)
if result.returncode:
    raise SystemExit(result.stderr[-4000:] or 'Container contract check failed')
evidence = json.loads(result.stdout.strip().splitlines()[-1])
assert evidence['passed']
(root / 'artifacts').mkdir(exist_ok=True)
(root / 'artifacts/consumer-recovery.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps(evidence))
