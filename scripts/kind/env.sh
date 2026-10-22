# Sourced by the kind scripts: pinned versions, local tool directory and fixed names.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
source infra/versions.env
export PATH="$ROOT/.tools:$PATH"
CLUSTER=${RG_CLUSTER:-releaseguard}
export RG_KUBE_CONTEXT="kind-$CLUSTER"
KUBECTL=(kubectl --context "$RG_KUBE_CONTEXT")
ARTIFACTS=${RG_ARTIFACTS:-artifacts}
mkdir -p "$ARTIFACTS"

bootstrap_namespace() { # namespace; creates namespace + secret once, never rotates an existing secret
  if "${KUBECTL[@]}" -n "$1" get secret releaseguard-secrets -o name >/dev/null 2>&1; then return; fi
  python3 cli/rg.py bootstrap --context "$RG_KUBE_CONTEXT" --namespace "$1"
}
