#!/usr/bin/env bash
# Runs a command inside the toolbox container on the docker:dind host's network and filesystem.
# The repository is copied to the same absolute path on the dind host, so Compose bind mounts,
# ports published on 127.0.0.1 and kind's API server address all work as on a workstation.
# Artifacts are copied back to ./artifacts even when the command fails.
set -uo pipefail
cd "$(dirname "$0")/../.."
work=/rg/project

docker build -q -t rg-toolbox -f ci/toolbox.Dockerfile ci >/dev/null
docker rm -f rg-seed >/dev/null 2>&1 || true
docker run --rm -v /rg:/rg rg-toolbox rm -rf "$work"
docker create --name rg-seed -v /rg:/rg rg-toolbox true >/dev/null
docker cp . "rg-seed:$work"

status=0
docker run --rm --network host -v /var/run/docker.sock:/var/run/docker.sock -v "$work:$work" -w "$work" \
  -e RG_BASE_REF -e RG_KEEP_NAMESPACES -e CI -e CI_COMMIT_SHA \
  rg-toolbox bash -c "$*" || status=$?

bash scripts/ci/dind-collect.sh
exit $status
