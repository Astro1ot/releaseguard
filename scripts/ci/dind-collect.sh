#!/usr/bin/env bash
# Copies artifacts (and, if a kind cluster exists, its node logs) from the dind host to ./artifacts.
# Safe to call from after_script after a timeout or a crash.
set -uo pipefail
cd "$(dirname "$0")/../.."
work=/rg/project
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$work:$work" -w "$work" rg-toolbox bash -c \
  'if [ -x .tools/kind ] && .tools/kind get clusters 2>/dev/null | grep -qx releaseguard; then .tools/kind export logs artifacts/kind-logs --name releaseguard >/dev/null 2>&1; fi' || true
mkdir -p artifacts
docker cp "rg-seed:$work/artifacts/." artifacts/ 2>/dev/null || echo 'No artifacts on the dind host.'
