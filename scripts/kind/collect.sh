#!/usr/bin/env bash
# Diagnostics for one namespace: live manifests, rendered Helm release, logs, events and
# Argo Rollouts / AnalysisRun state. Never fails the pipeline by itself.
set -uo pipefail
source "$(dirname "$0")/env.sh"
ns=$1
out="$ARTIFACTS/cluster/$ns"; mkdir -p "$out/logs"
k() { "${KUBECTL[@]}" -n "$ns" "$@"; }
k get all,rollouts,analysisruns,analysistemplates,gateways.gateway.networking.k8s.io,httproutes.gateway.networking.k8s.io,pdb,networkpolicies,jobs,pvc -o wide > "$out/summary.txt" 2>&1
for kind in rollouts analysisruns analysistemplates gateways.gateway.networking.k8s.io httproutes.gateway.networking.k8s.io deployments replicasets services pods jobs networkpolicies; do
  k get "$kind" -o yaml > "$out/$kind.yaml" 2>&1
done
k get events --sort-by=.lastTimestamp > "$out/events.txt" 2>&1
helm get manifest releaseguard -n "$ns" --kube-context "$RG_KUBE_CONTEXT" > "$out/helm-manifest.yaml" 2>&1
helm get values releaseguard -n "$ns" --kube-context "$RG_KUBE_CONTEXT" -o yaml > "$out/helm-values.yaml" 2>&1
helm history releaseguard -n "$ns" --kube-context "$RG_KUBE_CONTEXT" > "$out/helm-history.txt" 2>&1
for pod in $(k get pods -o name 2>/dev/null); do
  name=${pod#pod/}
  k logs "$pod" --all-containers --prefix --timestamps > "$out/logs/$name.log" 2>&1
  k logs "$pod" --all-containers --prefix --timestamps --previous > "$out/logs/$name.previous.log" 2>/dev/null || rm -f "$out/logs/$name.previous.log"
done
"${KUBECTL[@]}" -n argo-rollouts logs deploy/argo-rollouts --timestamps > "$ARTIFACTS/cluster/argo-rollouts.log" 2>&1
"${KUBECTL[@]}" -n istio-system logs deploy/istiod --timestamps --tail=2000 > "$ARTIFACTS/cluster/istiod.log" 2>&1
"${KUBECTL[@]}" -n istio-system logs ds/ztunnel --timestamps --tail=2000 > "$ARTIFACTS/cluster/ztunnel.log" 2>&1
"${KUBECTL[@]}" -n argo-rollouts get configmap argo-rollouts-config -o yaml > "$ARTIFACTS/cluster/argo-rollouts-config.yaml" 2>&1
"${KUBECTL[@]}" get nodes -o wide > "$ARTIFACTS/cluster/nodes.txt" 2>&1
exit 0
