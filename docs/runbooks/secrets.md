# Secrets and certificates

The local `.env` is ignored; `init-env` creates cryptographically random values. Kubernetes bootstrap creates the Secret over stdin without writing plaintext manifests. Re-running bootstrap fails on an existing Secret instead of silently breaking the DB password.

`cli/vault.py` demonstrates decrypting and parsing JSON with the Ansible Vault Python API. It reads the password interactively and does not print values. `cli/rg.py ansible` delegates to `ansible-runner`; install `requirements-ansible.txt` on Linux/WSL and provide a reviewed private data directory.

Example setup (Linux/WSL):

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements-ansible.txt
mkdir -p .secrets
ansible-vault create .secrets/config.vault
python cli/vault.py .secrets/config.vault
```

Enter a JSON object in the Vault editor. Keep vault passwords outside git. The CLI example validates the decrypted object; it does not silently inject secrets into deployment settings.

For ansible-runner, copy `infra/ansible/project/deploy.yml` to your private data directory's `project/` and put `rg_repo`, `rg_context`, `rg_namespace`, `rg_url`, `rg_image_tag` in `env/extravars`. Run `python cli/rg.py ansible --private-data-dir PATH`. These variables are deployment coordinates, not credentials; kube credentials remain in your local authorized context.

## Rotation

1. Create/enable the replacement credential at the backing service.
2. Update the consumer Secret and roll out the dependent workloads.
3. Run business checks.
4. Revoke the old credential and verify the old path is unusable.

Updating a PostgreSQL container environment variable does not change the password of an existing role or initialized volume. Coordinate role password changes with clients. If a credential reached git, revoke it first; removing a file from the latest commit is insufficient. Review exposure and history separately.

TLS ingress accepts an existing secret. For a public deployment, add a reviewed cert-manager DNS-01 issuer using a least-privilege DNS token, expiration alerts and a renewal runbook. This repo does not configure a DNS provider, certificate issuer, werf secret encryption or Deckhouse ModuleConfig. Do not claim those as completed capabilities.
