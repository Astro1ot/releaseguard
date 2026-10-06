"""Exercise malformed/forged/duplicate Kafka deliveries against the local lab."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
result = subprocess.run(
    ['docker', 'compose', 'exec', '-T', 'api', 'node', '-'],
    input=(root / 'scripts/broker_contract.cjs').read_text(encoding='utf-8'),
    cwd=root, text=True, capture_output=True, check=True, timeout=100,
)
evidence = json.loads(result.stdout.strip().splitlines()[-1])
assert evidence['passed']
(root / 'artifacts').mkdir(exist_ok=True)
(root / 'artifacts/broker-contract.json').write_text(json.dumps(evidence, indent=2), encoding='utf-8')
print(json.dumps(evidence))
