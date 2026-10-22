#!/usr/bin/env bash
# Full kind run: canary drills, pod failure, migration compatibility and the existing Helm
# rollback rehearsal. Every step runs even if an earlier one failed; diagnostics are collected
# per namespace before it is deleted; the exit code is non-zero if any step failed.
set -uo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$ARTIFACTS/logs"
steps=()
failed=0

step() { # name, command...
  local name=$1; shift
  local started=$SECONDS status=passed
  echo "=== $name"
  "$@" > >(tee "$ARTIFACTS/logs/$name.log") 2>&1 || status=failed
  [ "$status" = failed ] && failed=1
  steps+=("{\"name\":\"$name\",\"status\":\"$status\",\"durationSeconds\":$((SECONDS - started))}")
  echo "=== $name: $status"
}
write_steps() { (IFS=,; echo "[${steps[*]}]") > "$ARTIFACTS/steps.json"; }
trap write_steps EXIT

step stand-setup bash scripts/kind/up.sh
if [ $failed = 1 ]; then
  bash scripts/kind/collect.sh rg-canary
  exit 1
fi

step canary-promote node scripts/scenarios/canary.mjs --case promote
step canary-errors node scripts/scenarios/canary.mjs --case errors
step canary-latency node scripts/scenarios/canary.mjs --case latency
step pod-kill node scripts/scenarios/pod_kill.mjs
bash scripts/kind/collect.sh rg-canary
[ "${RG_KEEP_NAMESPACES:-}" = 1 ] || "${KUBECTL[@]}" delete namespace rg-canary --wait=true --timeout=300s

step migration-compat bash -c 'bash scripts/kind/compat-up.sh && node scripts/scenarios/migration_compat.mjs'
bash scripts/kind/collect.sh rg-compat
[ "${RG_KEEP_NAMESPACES:-}" = 1 ] || "${KUBECTL[@]}" delete namespace rg-compat --wait=true --timeout=300s

# Existing regression: failed Helm release -> verified rollback to the recorded revision.
step helm-rollback bash -c "python3 scripts/setup_kube.py && python3 scripts/kube_rehearsal.py --context $RG_KUBE_CONTEXT --namespace rg-local"
bash scripts/kind/collect.sh rg-local

write_steps
node scripts/scenarios/report.mjs || failed=1
exit $failed
