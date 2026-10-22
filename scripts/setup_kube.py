"""Prepare only the dedicated releaseguard kind cluster and rg-local namespace."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
CLUSTER = os.environ.get('RG_CLUSTER', 'releaseguard')
os.environ['PATH'] = str(ROOT / '.tools') + os.pathsep + os.environ['PATH']


def run(command, capture=False):
    return subprocess.run(command, cwd=ROOT, check=True, text=True, stdout=subprocess.PIPE if capture else None)


if __name__ == '__main__':
    clusters = run(['kind', 'get', 'clusters'], True).stdout.splitlines()
    if CLUSTER not in clusters:
        run(['kind', 'create', 'cluster', '--name', CLUSTER, '--config', 'infra/kind.yaml', '--wait', '180s'])
    run(['docker', 'build', '-t', 'releaseguard:local', '.'])
    run(['kind', 'load', 'docker-image', 'releaseguard:local', '--name', CLUSTER])
    run([sys.executable, 'scripts/preload_images.py'])
    kube = ['kubectl', '--context', f'kind-{CLUSTER}']
    namespaces = json.loads(run([*kube, 'get', 'namespaces', '-o', 'json'], True).stdout)
    if not any(x['metadata']['name'] == 'rg-local' for x in namespaces['items']):
        run([sys.executable, 'cli/rg.py', 'bootstrap', '--context', f'kind-{CLUSTER}', '--namespace', 'rg-local'])
    else:
        # Do not rotate existing credentials or print the Secret payload.
        run([*kube, '-n', 'rg-local', 'get', 'secret', 'releaseguard-secrets', '-o', 'name'])
    run(['helm', 'upgrade', '--install', 'releaseguard', 'charts/releaseguard', '-f', 'environments/local.yaml', '--namespace', 'rg-local', '--kube-context', f'kind-{CLUSTER}', '--atomic', '--wait', '--timeout', '600s'])
    print('Dedicated Kubernetes lab is ready. Run the rollback rehearsal next.')
