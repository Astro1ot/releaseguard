# Toolbox for GitLab docker:dind jobs: Docker CLI with Compose/Buildx plugins, bash, git,
# Python and Node. kind, kubectl, Helm and istioctl are installed by scripts/ci/install-tools.sh.
FROM docker:28.3-cli
RUN apk add --no-cache bash coreutils curl git nodejs python3 \
 && git config --system --add safe.directory '*'
