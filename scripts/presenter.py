"""Local-only presentation console for fixed, reversible lab exercises."""
from __future__ import annotations
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import webbrowser
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
PORT = 8877
TOKEN = secrets.token_urlsafe(32)
LOCK = threading.Lock()
STATE = {'running': False, 'scenario': None, 'result': None, 'lines': [], 'history': []}
HISTORY_PATH = ROOT / 'artifacts/presenter-history.json'
try:
    saved_history = json.loads(HISTORY_PATH.read_text(encoding='utf-8'))
    if isinstance(saved_history, list):
        STATE['history'] = [item for item in saved_history if isinstance(item, dict) and isinstance(item.get('scenario'), str) and item.get('result') in {'passed', 'failed'} and isinstance(item.get('seconds'), (int, float)) and isinstance(item.get('time'), str)][:30]
except (OSError, ValueError, TypeError): pass
PYTHON = sys.executable
COMMANDS = {
    'start': [['docker', 'compose', 'up', '-d', '--build', '--wait', '--wait-timeout', '300']],
    'smoke': [[PYTHON, 'scripts/integration.py']],
    'broker-contract': [[PYTHON, 'scripts/broker_contract.py']],
    'consumer-recovery': [[PYTHON, 'scripts/consumer_recovery.py']],
    'proof-tour': [[PYTHON, 'scripts/integration.py'], [PYTHON, 'scripts/broker_contract.py'], [PYTHON, 'scripts/consumer_recovery.py']],
    'redis': [[PYTHON, 'scripts/drill.py', 'redis']],
    'kafka': [[PYTHON, 'scripts/drill.py', 'kafka']],
    'rate-limit': [[PYTHON, 'scripts/drill.py', 'rate-limit']],
    'migration': [[PYTHON, 'scripts/migration_drill.py']],
    'rollback': [[PYTHON, 'scripts/kube_rehearsal.py', '--context', 'kind-releaseguard', '--namespace', 'rg-local']],
    'prepare-kube': [[PYTHON, 'scripts/setup_kube.py']],
    'recover': [['docker', 'compose', 'start', 'redis', 'kafka'], [PYTHON, 'scripts/integration.py']],
    'stop': [['docker', 'compose', 'stop']],
}


def execute(name):
    started = time.monotonic()
    code = 1
    try:
        if name == 'start' and not (ROOT / '.env').exists():
            subprocess.run([PYTHON, 'cli/rg.py', 'init-env'], cwd=ROOT, check=True, capture_output=True)
        for command in COMMANDS[name]:
            code = 1
            with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', env={**os.environ, 'PYTHONUTF8': '1', 'COMPOSE_PROGRESS': 'plain'}) as child:
                for line in child.stdout:
                    line = line.rstrip().replace(str(ROOT), '[project]').replace(str(ROOT).replace('\\', '/'), '[project]')
                    with LOCK:
                        STATE['lines'].append(line)
                        STATE['lines'] = STATE['lines'][-250:]
                code = child.wait()
                if code: break
    except Exception as error:
        code = 1
        with LOCK: STATE['lines'].append(f'Не удалось выполнить сценарий: {type(error).__name__}. Проверьте Docker и установленные инструменты.')
    finally:
        with LOCK:
            STATE['running'] = False
            STATE['result'] = 'passed' if code == 0 else 'failed'
            STATE['history'].insert(0, {'scenario': name, 'result': STATE['result'], 'seconds': round(time.monotonic() - started, 1), 'time': time.strftime('%H:%M:%S'), 'finished_at': datetime.now(timezone.utc).isoformat()})
            STATE['history'] = STATE['history'][:30]
            try:
                HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
                temporary = HISTORY_PATH.with_suffix('.tmp')
                temporary.write_text(json.dumps(STATE['history'], ensure_ascii=False, indent=2), encoding='utf-8')
                temporary.replace(HISTORY_PATH)
            except OSError:
                STATE['lines'].append('Тест завершён, но история не сохранена на диск. Скачайте отчёт этой панели.')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, data, status=200, mime='application/json; charset=utf-8'):
        body = data.encode('utf-8') if isinstance(data, str) else json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers(); self.wfile.write(body)
    def trusted_host(self): return self.headers.get('Host') in {f'127.0.0.1:{PORT}', f'localhost:{PORT}'}
    def do_GET(self):
        if not self.trusted_host(): return self.reply({'error': 'Invalid host'}, 403)
        if self.path == '/':
            page = (ROOT / 'scripts/presenter.html').read_text(encoding='utf-8').replace('__TOKEN__', TOKEN)
            return self.reply(page, mime='text/html; charset=utf-8')
        if self.path == '/state':
            with LOCK: snapshot = json.loads(json.dumps(STATE))
            return self.reply(snapshot)
        if self.path == '/report.json':
            with LOCK:
                report = {'schema_version': 1, 'project': 'ReleaseGuard', 'generated_at': datetime.now(timezone.utc).isoformat(), 'running': STATE['running'], 'scenario': STATE['scenario'], 'history': json.loads(json.dumps(STATE['history'])), 'scope': 'Local scenario results; historical passes are not a current health guarantee'}
            return self.reply(report)
        return self.reply({'error': 'Not found'}, 404)
    def do_POST(self):
        if not self.trusted_host() or self.path != '/run' or self.headers.get('X-Demo-Token') != TOKEN or self.headers.get('Origin') not in {f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'}:
            return self.reply({'error': 'Forbidden'}, 403)
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply({'error': 'Expected application/json'}, 415)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024: raise ValueError()
            raw = self.rfile.read(length)
            if len(raw) != length: raise ValueError()
            payload = json.loads(raw, object_pairs_hook=unique_fields)
            if not isinstance(payload, dict) or set(payload) != {'scenario'}: raise ValueError()
            name = payload['scenario']
            if not isinstance(name, str) or name not in COMMANDS: raise ValueError()
        except (ValueError, AttributeError, TypeError, RecursionError): return self.reply({'error': 'Invalid scenario'}, 400)
        with LOCK:
            if STATE['running']: return self.reply({'error': 'Дождитесь завершения текущего сценария'}, 409)
            STATE.update(running=True, scenario=name, result=None, lines=[])
        threading.Thread(target=execute, args=(name,), daemon=True).start()
        return self.reply({'started': name}, 202)


def unique_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('Duplicate field')
        result[key] = value
    return result


if __name__ == '__main__':
    # Tools stay local and are never included in the source archive.
    tools = ROOT / '.tools'
    os.environ['PATH'] = str(tools) + os.pathsep + os.environ['PATH']
    if not shutil.which('docker'): raise SystemExit('Docker Desktop не найден. Установите и запустите Docker Desktop.')
    try: server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    except OSError:
        try:
            with urlopen(f'http://127.0.0.1:{PORT}/state', timeout=2) as existing:
                active = json.load(existing)
            if {'running', 'scenario', 'history', 'lines'} <= active.keys():
                if '--no-browser' not in sys.argv: webbrowser.open(f'http://127.0.0.1:{PORT}')
                print('Панель ReleaseGuard уже работает.')
                sys.exit(0)
        except (OSError, ValueError, AttributeError): pass
        raise SystemExit(f'Порт {PORT} занят. Проверьте существующую панель по http://127.0.0.1:{PORT}.')
    print(f'ReleaseGuard: http://127.0.0.1:{PORT}', flush=True)
    print('Панель выполняет только перечисленные сценарии в этом проекте. Закройте окно после завершения сценария.', flush=True)
    if '--no-browser' not in sys.argv: webbrowser.open(f'http://127.0.0.1:{PORT}')
    try: server.serve_forever()
    except KeyboardInterrupt: server.server_close()
