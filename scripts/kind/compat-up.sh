#!/usr/bin/env bash
# Namespace for the migration compatibility scenario: Helm Deployment mode with the OLD image.
set -euo pipefail
source "$(dirname "$0")/env.sh"
ns=rg-compat
tag=base
if ! docker image inspect releaseguard:base >/dev/null 2>&1; then
  echo "releaseguard:base not built (set RG_BASE_REF); old and candidate images will be identical" >&2
  tag=local
fi
bootstrap_namespace "$ns"
helm upgrade --install releaseguard charts/releaseguard --namespace "$ns" --kube-context "$RG_KUBE_CONTEXT" \
  -f environments/local.yaml --set-string image.tag=$tag --set-string app.version=$tag --wait --timeout 600s
