"""Read an Ansible Vault encrypted JSON file through the Python API; emit no values.
Use on Linux/WSL: python cli/vault.py .secrets/config.vault
Password is read interactively, never passed as a process argument.
"""
import getpass
import json
from pathlib import Path
import sys


def read_vault(path, password):
    from ansible.parsing.vault import VaultLib, VaultSecret
    payload = VaultLib([('default', VaultSecret(password.encode()))]).decrypt(Path(path).read_bytes())
    value = json.loads(payload)
    if not isinstance(value, dict): raise ValueError('Expected JSON object')
    return value


if __name__ == '__main__':
    try:
        data = read_vault(sys.argv[1], getpass.getpass('Vault password: '))
        print(f'Vault successfully decrypted and parsed: {len(data)} keys. Values not printed.')
    except Exception:
        print('Vault validation failed; no decrypted values were emitted.', file=sys.stderr)
        sys.exit(1)
