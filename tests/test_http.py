"""Real NestJS HTTP processes in explicitly in-memory mode (no database claims)."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import time
from urllib.error import HTTPError, URLError
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rg_http', ROOT / 'cli/rg.py')
rg = importlib.util.module_from_spec(spec); spec.loader.exec_module(rg)


class Server:
    def __init__(self, fault='none'):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        self.process = subprocess.Popen(['node', 'dist/main.js'], cwd=ROOT, env={**os.environ, 'DEMO_MODE': 'true', 'HOST': '127.0.0.1', 'PORT': str(port), 'RELEASE_FAULT': fault}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try: rg.request(self.url, '/health/live'); return
                except (OSError, ValueError):
                    if self.process.poll() is not None: raise RuntimeError('NestJS process exited early')
                    time.sleep(.1)
            raise RuntimeError('NestJS startup timed out')
        except Exception:
            self.close(); raise

    def close(self):
        self.process.terminate()
        try: self.process.wait(timeout=10)
        except subprocess.TimeoutExpired: self.process.kill(); self.process.wait()


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.server = Server()
    @classmethod
    def tearDownClass(cls): cls.server.close()

    def test_business_smoke_reaches_completion(self):
        result = rg.smoke(self.server.url)
        self.assertTrue(result['passed']); self.assertEqual(result['status'], 'completed')

    def test_same_key_different_payload_returns_conflict(self):
        key = str(uuid.uuid4())
        rg.request(self.server.url, '/api/orders', body={'productId': 'asset-01'}, key=key)
        with self.assertRaises(HTTPError) as caught:
            rg.request(self.server.url, '/api/orders', body={'productId': 'asset-02'}, key=key)
        self.assertEqual(caught.exception.code, 409)

    def test_disabled_dependencies_are_not_shown_as_healthy(self):
        status = rg.request(self.server.url, '/api/status')
        self.assertEqual(status['mode'], 'demo / in-memory')
        self.assertEqual(set(status['disabled']), {'PostgreSQL', 'Redis', 'Kafka'})
        self.assertTrue(all(c['name'] == 'Catalog API' for c in status['components']))

    def test_bad_release_is_ready_but_fails_business_gate(self):
        broken = Server('catalog-500')
        try:
            self.assertEqual(rg.request(broken.url, '/health/ready')['status'], 'ready')
            with self.assertRaises(HTTPError) as caught: rg.smoke(broken.url)
            self.assertEqual(caught.exception.code, 503)
            for _ in range(40):
                status = rg.request(broken.url, '/api/status')
                if status['state'] == 'degraded': break
                time.sleep(.5)
            self.assertEqual(status['state'], 'degraded')
            self.assertEqual(len(status['incidents']), 1)
        finally: broken.close()


if __name__ == '__main__': unittest.main()
