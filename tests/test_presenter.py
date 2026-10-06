import importlib.util
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('presenter', Path(__file__).resolve().parents[1] / 'scripts/presenter.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


class PresenterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = p.ThreadingHTTPServer(('127.0.0.1', 0), p.Handler)
        p.PORT = cls.server.server_address[1]
        cls.base = f'http://127.0.0.1:{p.PORT}'
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls): cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def post(self, headers, body=b'{"scenario":"smoke"}'):
        return urlopen(Request(self.base + '/run', data=body, headers={'Content-Type': 'application/json', **headers}), timeout=3)

    def test_page_is_local_and_contains_session_token(self):
        with urlopen(self.base) as response: self.assertIn(p.TOKEN, response.read().decode())

    def test_commands_reject_missing_csrf_token(self):
        with self.assertRaises(HTTPError) as error: self.post({'Origin': self.base})
        self.assertEqual(error.exception.code, 403)

    def test_commands_reject_cross_origin_even_with_token(self):
        with self.assertRaises(HTTPError) as error: self.post({'Origin': 'https://example.org', 'X-Demo-Token': p.TOKEN})
        self.assertEqual(error.exception.code, 403)

    def test_arbitrary_commands_are_not_accepted(self):
        with self.assertRaises(HTTPError) as error: self.post({'Origin': self.base, 'X-Demo-Token': p.TOKEN}, b'{"scenario":"shell"}')
        self.assertEqual(error.exception.code, 400)

    def test_unknown_host_is_rejected(self):
        with self.assertRaises(HTTPError) as error: urlopen(Request(self.base, headers={'Host': 'example.org'}))
        self.assertEqual(error.exception.code, 403)


if __name__ == '__main__': unittest.main()
