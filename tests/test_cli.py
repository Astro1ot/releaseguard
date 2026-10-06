import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rg', Path(__file__).resolve().parents[1] / 'cli/rg.py')
rg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rg)


class ReleaseTests(unittest.TestCase):
    def args(self):
        return SimpleNamespace(release='releaseguard', namespace='test', context='kind-test', environment='local', image_tag='abc123', fault=None, url='http://localhost:3000')

    def test_missing_release_is_distinct_from_helm_failure(self):
        with patch.object(rg, 'run', return_value=SimpleNamespace(stdout='[]')):
            self.assertIsNone(rg.previous_revision(self.args()))
        with patch.object(rg, 'run', side_effect=subprocess.CalledProcessError(1, ['helm'])):
            with self.assertRaises(subprocess.CalledProcessError): rg.previous_revision(self.args())

    def test_uses_deployed_revision_not_latest_history_entry(self):
        responses = [SimpleNamespace(stdout='[{"name":"releaseguard"}]'), SimpleNamespace(stdout=json.dumps([{'revision': 8, 'status': 'deployed'}, {'revision': 9, 'status': 'failed'}]))]
        with patch.object(rg, 'run', side_effect=responses): self.assertEqual(rg.previous_revision(self.args()), 8)

    def test_failed_smoke_rolls_back_exact_revision_and_keeps_exit_failure(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(rg, 'ROOT', Path(folder)), patch.object(rg, 'previous_revision', return_value=8), patch.object(rg, 'run') as run, patch.object(rg, 'smoke', side_effect=[RuntimeError('bad release'), {'passed': True}]):
            self.assertEqual(rg.deploy(self.args()), 1)
            rollback = [c.args[0] for c in run.call_args_list if c.args[0][1] == 'rollback']
            self.assertEqual(rollback[0][2:4], ['releaseguard', '8'])
            report = json.loads(next((Path(folder) / 'artifacts/releases').glob('*.json')).read_text())
            self.assertEqual(report['rollback'], 'verified')

    def test_recovery_failure_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(rg, 'ROOT', Path(folder)), patch.object(rg, 'previous_revision', return_value=3), patch.object(rg, 'run'), patch.object(rg, 'smoke', side_effect=RuntimeError('still broken')):
            self.assertEqual(rg.deploy(self.args()), 1)
            report = json.loads(next((Path(folder) / 'artifacts/releases').glob('*.json')).read_text())
            self.assertEqual(report['rollback'], 'failed-verification')

    def test_first_install_never_rolls_back_to_unknown_revision(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(rg, 'ROOT', Path(folder)), patch.object(rg, 'previous_revision', return_value=None), patch.object(rg, 'run') as run, patch.object(rg, 'smoke', side_effect=RuntimeError('bad')):
            self.assertEqual(rg.deploy(self.args()), 1)
            self.assertFalse(any(c.args[0][1] == 'rollback' for c in run.call_args_list))

    def test_latest_tag_rejected(self):
        args = self.args(); args.image_tag = 'latest'
        with self.assertRaises(ValueError): rg.release_values(args)

    def test_invalid_json_in_business_response_triggers_recovery(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(rg, 'ROOT', Path(folder)), patch.object(rg, 'previous_revision', return_value=2), patch.object(rg, 'run'), patch.object(rg, 'smoke', side_effect=[json.JSONDecodeError('invalid', '<html>', 0), {'passed': True}]):
            self.assertEqual(rg.deploy(self.args()), 1)
            report = json.loads(next((Path(folder) / 'artifacts/releases').glob('*.json')).read_text())
            self.assertEqual(report['rollback'], 'verified')


if __name__ == '__main__': unittest.main()
