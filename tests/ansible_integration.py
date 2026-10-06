"""Linux-only integration of the optional Vault API and ansible-runner wrapper."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from ansible.parsing.vault import VaultLib, VaultSecret

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rg_vault', ROOT / 'cli/vault.py')
vault = importlib.util.module_from_spec(spec); spec.loader.exec_module(vault)

with tempfile.TemporaryDirectory(prefix='releaseguard-ansible-') as directory:
    folder = Path(directory)
    password = 'temporary-test-password-only'
    encrypted = VaultLib([('default', VaultSecret(password.encode()))]).encrypt(json.dumps({'demo': 'synthetic-value'}).encode())
    path = folder / 'test.vault'; path.write_bytes(encrypted)
    assert vault.read_vault(path, password) == {'demo': 'synthetic-value'}
    try:
        vault.read_vault(path, 'wrong-password')
        raise AssertionError('Wrong Vault password was accepted')
    except Exception as error:
        if isinstance(error, AssertionError): raise
    project = folder / 'project'; project.mkdir()
    (project / 'verify.yml').write_text('- hosts: localhost\n  connection: local\n  gather_facts: false\n  tasks:\n    - ansible.builtin.assert:\n        that: "1 + 1 == 2"\n')
    result = subprocess.run([sys.executable, str(ROOT / 'cli/rg.py'), 'ansible', '--private-data-dir', str(folder), '--playbook', 'verify.yml'], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report == {'status': 'successful', 'rc': 0}, report
print('Vault encrypt/decrypt, invalid password rejection and ansible-runner wrapper passed.')
