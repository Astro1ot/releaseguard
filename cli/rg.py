"""ReleaseGuard CLI. Python 3.11+, stdlib for normal operations."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid

ROOT = Path(__file__).resolve().parents[1]


def run(args: list[str], *, capture=False, input_text=None):
    return subprocess.run(args, cwd=ROOT, check=True, text=True, input=input_text,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def request(base, path, *, body=None, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    req = Request(base.rstrip('/') + path, data=json.dumps(body).encode() if body else None, headers=headers)
    with urlopen(req, timeout=5) as response:
        return json.load(response)


def smoke(base: str, *, fulfillment=True, timeout=45):
    started = time.monotonic()
    catalog = request(base, '/api/catalog')['products']
    if not catalog:
        raise RuntimeError('Catalog is empty')
    body = {'productId': catalog[0]['id']}
    key = str(uuid.uuid4())
    first = request(base, '/api/orders', body=body, key=key)
    second = request(base, '/api/orders', body=body, key=key)
    if first['id'] != second['id']:
        raise RuntimeError('Idempotency invariant violated')
    order = request(base, '/api/orders/' + first['id'])
    if fulfillment:
        while order['status'] != 'completed':
            if time.monotonic() - started > timeout:
                raise RuntimeError('Order not fulfilled before deadline')
            time.sleep(1)
            order = request(base, '/api/orders/' + first['id'])
    return {'passed': True, 'orderId': first['id'], 'status': order['status'], 'durationSeconds': round(time.monotonic() - started, 3)}


def helm_base(args):
    return ['--namespace', args.namespace, '--kube-context', args.context]


def release_values(args):
    flags = ['-f', str(ROOT / 'environments' / f'{args.environment}.yaml')]
    if args.image_tag:
        if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', args.image_tag) or args.image_tag == 'latest':
            raise ValueError('Use a fixed image tag, preferably a git commit SHA')
        flags += ['--set-string', f'image.tag={args.image_tag}', '--set-string', f'app.version={args.image_tag}']
    if args.fault:
        flags += ['--set-string', f'app.fault={args.fault}']
    return flags


def previous_revision(args):
    # helm list distinguishes "not installed" from permission/network failures.
    listed = json.loads(run(['helm', 'list', '--all', '--filter', '^' + re.escape(args.release) + '$', '-o', 'json', *helm_base(args)], capture=True).stdout)
    if not listed:
        return None
    history = json.loads(run(['helm', 'history', args.release, '-o', 'json', *helm_base(args)], capture=True).stdout)
    deployed = [r for r in history if r['status'] == 'deployed']
    if len(deployed) != 1:
        raise RuntimeError('Release has no single deployed revision; recover it before another upgrade')
    return int(deployed[0]['revision'])


def deploy(args):
    flags = release_values(args)
    run(['helm', 'lint', str(ROOT / 'charts/releaseguard'), '--strict', *flags])
    previous = previous_revision(args)
    report = {'release': args.release, 'namespace': args.namespace, 'context': args.context,
              'previousRevision': previous, 'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    started = time.monotonic()
    try:
        run(['helm', 'upgrade', '--install', args.release, str(ROOT / 'charts/releaseguard'),
             *helm_base(args), *flags, '--atomic', '--wait', '--timeout', '300s', '--history-max', '10'])
        report['smoke'] = smoke(args.url)
        report['result'] = 'passed'
    except (subprocess.CalledProcessError, RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        report['result'] = 'failed'
        report['failureType'] = type(error).__name__
        if isinstance(error, HTTPError): report['httpStatus'] = error.code
        if previous is not None:
            try:
                # Explicit revision: never assume "current - 1" is a good release.
                run(['helm', 'rollback', args.release, str(previous), *helm_base(args), '--wait', '--timeout', '300s'])
                report['recovery'] = smoke(args.url)
                report['rollback'] = 'verified'
            except (subprocess.CalledProcessError, RuntimeError, OSError, ValueError, KeyError, TypeError):
                report['rollback'] = 'failed-verification'
        else:
            report['rollback'] = 'unavailable-first-install; inspect or uninstall explicitly'
    finally:
        report['durationSeconds'] = round(time.monotonic() - started, 3)
        output = ROOT / 'artifacts' / 'releases'
        output.mkdir(parents=True, exist_ok=True)
        path = output / f'{time.time_ns()}.json'
        path.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
        print(f'Evidence: {path}')
    return 0 if report['result'] == 'passed' else 1


def init_env():
    path = ROOT / '.env'
    # Exclusive creation: never overwrite an existing password/database identity.
    with path.open('x', encoding='utf-8') as stream:
        stream.write(f'POSTGRES_PASSWORD={secrets.token_hex(24)}\nGRAFANA_PASSWORD={secrets.token_hex(24)}\n')
    if os.name != 'nt':
        path.chmod(0o600)
    print('Created .env with random lab credentials. Keep it out of git.')


def bootstrap(args):
    password = secrets.token_hex(24)
    namespace = {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': args.namespace}}
    kube = ['kubectl', '--context', args.context]
    run([*kube, 'apply', '-f', '-'], input_text=json.dumps(namespace))
    # create (not apply): a second invocation fails, preserving the DB password.
    secret = {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': 'releaseguard-secrets', 'namespace': args.namespace},
              'type': 'Opaque', 'stringData': {
                  'POSTGRES_PASSWORD': password,
                  'DATABASE_URL': f'postgres://releaseguard:{password}@{args.release}-postgres:5432/releaseguard',
                  'REDIS_URL': f'redis://{args.release}-redis:6379',
                  'KAFKA_BROKERS': f'{args.release}-kafka:9092'}}
    run([*kube, 'create', '-f', '-'], input_text=json.dumps(secret))
    print('Namespace and secret created. Secret values were not printed or written to disk.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('init-env', help='Create random Docker Compose credentials')
    p = sub.add_parser('smoke', help='Verify catalog, idempotency and order fulfillment')
    p.add_argument('--url', default='http://127.0.0.1:3000')
    p.add_argument('--accept-pending', action='store_true', help='Dependency drill only; do not use as a release gate')
    p = sub.add_parser('bootstrap', help='Create isolated lab namespace and secret')
    p.add_argument('--context', required=True); p.add_argument('--namespace', required=True); p.add_argument('--release', default='releaseguard')
    for command in ['plan', 'deploy']:
        p = sub.add_parser(command)
        p.add_argument('--environment', choices=['local', 'staging'], default='local')
        p.add_argument('--release', default='releaseguard')
        p.add_argument('--namespace', required=True)
        p.add_argument('--context', required=True)
        p.add_argument('--image-tag')
        p.add_argument('--fault', choices=['none', 'catalog-500'])
        if command == 'deploy': p.add_argument('--url', required=True, help='Reachable API endpoint for post-release business tests')
    p = sub.add_parser('ansible', help='Run a reviewed playbook using ansible-runner (Linux/WSL)')
    p.add_argument('--private-data-dir', required=True)
    p.add_argument('--playbook', default='deploy.yml')
    args = parser.parse_args(argv)
    try:
        if args.command == 'init-env': init_env()
        elif args.command == 'smoke': print(json.dumps(smoke(args.url, fulfillment=not args.accept_pending), indent=2))
        elif args.command == 'bootstrap': bootstrap(args)
        elif args.command == 'plan': run(['helm', 'template', args.release, str(ROOT / 'charts/releaseguard'), *helm_base(args), *release_values(args)])
        elif args.command == 'deploy': return deploy(args)
        elif args.command == 'ansible':
            import ansible_runner
            result = ansible_runner.run(private_data_dir=str(Path(args.private_data_dir).resolve()), playbook=args.playbook, quiet=True)
            print(json.dumps({'status': result.status, 'rc': result.rc}))
            return result.rc or (0 if result.status == 'successful' else 1)
        return 0
    except (subprocess.CalledProcessError, OSError, ValueError, RuntimeError, KeyError) as error:
        # Do not echo subprocess stderr / secret-bearing connection strings.
        print(f'Operation failed ({type(error).__name__}). Inspect the local service or command; secrets are not printed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
