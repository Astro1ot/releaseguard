#!/usr/bin/env bash
# Isolated kind stand: cluster, Istio (sidecar mode), Argo Rollouts, Prometheus and the app
# in canary mode with an in-mesh load generator. Idempotent; reuses an existing cluster.
set -euo pipefail
source "$(dirname "$0")/env.sh"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "${RG_KIND_CONFIG:-infra/kind.yaml}" --image "$KIND_NODE_IMAGE" --wait 180s
fi
"${KUBECTL[@]}" cluster-info

docker build -t releaseguard:local .
kind load docker-image releaseguard:local --name "$CLUSTER"
if [ -n "${RG_BASE_REF:-}" ]; then
  # Previous application version for the migration compatibility scenario.
  base_dir=$(mktemp -d)
  git worktree add --detach "$base_dir" "$RG_BASE_REF"
  docker build -t releaseguard:base "$base_dir"
  git worktree remove --force "$base_dir"
  kind load docker-image releaseguard:base --name "$CLUSTER"
fi

istioctl install -y --context "$RG_KUBE_CONTEXT" --set profile=minimal \
  --set values.pilot.resources.requests.cpu=100m --set values.pilot.resources.requests.memory=256Mi
"${KUBECTL[@]}" -n istio-system rollout status deploy/istiod --timeout=300s

"${KUBECTL[@]}" create namespace argo-rollouts --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
"${KUBECTL[@]}" -n argo-rollouts apply --server-side -f "https://github.com/argoproj/argo-rollouts/releases/download/$ARGO_ROLLOUTS_VERSION/install.yaml"
"${KUBECTL[@]}" -n argo-rollouts rollout status deploy/argo-rollouts --timeout=300s

"${KUBECTL[@]}" apply -f deploy/kind/prometheus.yaml
"${KUBECTL[@]}" -n monitoring rollout status deploy/prometheus --timeout=300s

ns=rg-canary
bootstrap_namespace "$ns"
"${KUBECTL[@]}" label namespace "$ns" istio-injection=enabled --overwrite
helm upgrade --install releaseguard charts/releaseguard --namespace "$ns" --kube-context "$RG_KUBE_CONTEXT" \
  -f environments/kind-progressive.yaml --wait --timeout 600s
"${KUBECTL[@]}" -n "$ns" wait rollout/releaseguard --for=jsonpath='{.status.phase}'=Healthy --timeout=600s
"${KUBECTL[@]}" -n "$ns" create configmap releaseguard-loadgen --from-file=deploy/kind/loadgen.mjs --dry-run=client -o yaml \
  | "${KUBECTL[@]}" -n "$ns" apply -f -
"${KUBECTL[@]}" -n "$ns" apply -f deploy/kind/loadgen.yaml
"${KUBECTL[@]}" -n "$ns" rollout status deploy/releaseguard-loadgen --timeout=300s
echo "Canary stand ready: namespace $ns, context $RG_KUBE_CONTEXT"
