#!/usr/bin/env bash
# Isolated kind stand: Gateway API CRDs, Istio ambient (istiod, istio-cni, ztunnel), Argo Rollouts
# with the Gateway API traffic-router plugin, Prometheus, and the app in canary mode behind a
# waypoint, with two traffic sources: in-mesh and through an ingress gateway. Idempotent.
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

"${KUBECTL[@]}" apply --server-side -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/$GATEWAY_API_VERSION/standard-install.yaml"

istioctl install -y --context "$RG_KUBE_CONTEXT" -f deploy/kind/istio-ambient.yaml
"${KUBECTL[@]}" -n istio-system rollout status deploy/istiod --timeout=300s
"${KUBECTL[@]}" -n istio-system rollout status ds/istio-cni-node --timeout=300s
"${KUBECTL[@]}" -n istio-system rollout status ds/ztunnel --timeout=300s

"${KUBECTL[@]}" create namespace argo-rollouts --dry-run=client -o yaml | "${KUBECTL[@]}" apply -f -
"${KUBECTL[@]}" -n argo-rollouts apply --server-side -f "https://github.com/argoproj/argo-rollouts/releases/download/$ARGO_ROLLOUTS_VERSION/install.yaml"
arch=amd64; plugin_sha=$GATEWAYAPI_PLUGIN_SHA256_AMD64
if [ "$(docker info --format '{{.Architecture}}')" = aarch64 ]; then arch=arm64; plugin_sha=$GATEWAYAPI_PLUGIN_SHA256_ARM64; fi
"${KUBECTL[@]}" apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata: {name: argo-rollouts-config, namespace: argo-rollouts}
data:
  trafficRouterPlugins: |-
    - name: argoproj-labs/gatewayAPI
      location: https://github.com/argoproj-labs/rollouts-plugin-trafficrouter-gatewayapi/releases/download/$GATEWAYAPI_PLUGIN_VERSION/gatewayapi-plugin-linux-$arch
      sha256: $plugin_sha
EOF
"${KUBECTL[@]}" apply -f deploy/kind/argo-rollouts-gatewayapi-rbac.yaml
# The controller serves /healthz only after downloading the plugin (~77 MB); a startupProbe keeps the
# liveness probe from killing it on a slow link (up to 10 minutes). It is not part of install.yaml, so
# it does not conflict with the server-side apply above.
"${KUBECTL[@]}" -n argo-rollouts patch deploy/argo-rollouts --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"argo-rollouts","startupProbe":{"httpGet":{"path":"/healthz","port":"healthz"},"periodSeconds":10,"failureThreshold":60}}]}}}}'
# The controller loads plugins only at startup.
"${KUBECTL[@]}" -n argo-rollouts rollout restart deploy/argo-rollouts
"${KUBECTL[@]}" -n argo-rollouts rollout status deploy/argo-rollouts --timeout=300s

"${KUBECTL[@]}" apply -f deploy/kind/prometheus.yaml
"${KUBECTL[@]}" -n monitoring rollout status deploy/prometheus --timeout=300s

ns=rg-canary
bootstrap_namespace "$ns"
# Ambient data plane for the namespace: no sidecars, ztunnel handles L4, the waypoint L7.
"${KUBECTL[@]}" label namespace "$ns" istio.io/dataplane-mode=ambient --overwrite
helm upgrade --install releaseguard charts/releaseguard --namespace "$ns" --kube-context "$RG_KUBE_CONTEXT" \
  -f environments/kind-progressive.yaml --wait --timeout 600s
"${KUBECTL[@]}" -n "$ns" wait gateways.gateway.networking.k8s.io/releaseguard-waypoint --for=condition=Programmed --timeout=300s
"${KUBECTL[@]}" -n "$ns" wait gateways.gateway.networking.k8s.io/releaseguard-ingress --for=condition=Programmed --timeout=300s
"${KUBECTL[@]}" -n "$ns" wait rollout/releaseguard --for=jsonpath='{.status.phase}'=Healthy --timeout=600s

# Two traffic sources: in-mesh calls to the Service, and calls through the ingress gateway.
"${KUBECTL[@]}" -n "$ns" create configmap releaseguard-loadgen --from-file=deploy/kind/loadgen.mjs --dry-run=client -o yaml \
  | "${KUBECTL[@]}" -n "$ns" apply -f -
"${KUBECTL[@]}" -n "$ns" apply -f deploy/kind/loadgen.yaml
"${KUBECTL[@]}" -n "$ns" rollout status deploy/releaseguard-loadgen --timeout=300s
"${KUBECTL[@]}" -n "$ns" rollout status deploy/releaseguard-loadgen-ingress --timeout=300s
echo "Canary stand ready: namespace $ns (ambient), context $RG_KUBE_CONTEXT"
