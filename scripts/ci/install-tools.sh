#!/usr/bin/env bash
# Download pinned kind, kubectl, Helm and istioctl into .tools/ and verify published SHA-256 sums.
set -euo pipefail
cd "$(dirname "$0")/../.."
source infra/versions.env
os=linux; arch=amd64
[ "$(uname -m)" = aarch64 ] || [ "$(uname -m)" = arm64 ] && arch=arm64
dest=.tools; mkdir -p "$dest"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

fetch() { curl -fsSL --retry 3 -o "$1" "$2"; }
verify() { # file, expected hash
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || { echo "Checksum mismatch for $1" >&2; exit 1; }
}

fetch "$tmp/kind" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$os-$arch"
fetch "$tmp/kind.sha" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-$os-$arch.sha256sum"
verify "$tmp/kind" "$(cut -d' ' -f1 "$tmp/kind.sha")"
install -m 0755 "$tmp/kind" "$dest/kind"

fetch "$tmp/kubectl" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$os/$arch/kubectl"
fetch "$tmp/kubectl.sha" "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/$os/$arch/kubectl.sha256"
verify "$tmp/kubectl" "$(cut -d' ' -f1 "$tmp/kubectl.sha")"
install -m 0755 "$tmp/kubectl" "$dest/kubectl"

helm_tgz="helm-$HELM_VERSION-$os-$arch.tar.gz"
fetch "$tmp/$helm_tgz" "https://get.helm.sh/$helm_tgz"
fetch "$tmp/helm.sha" "https://get.helm.sh/$helm_tgz.sha256sum"
verify "$tmp/$helm_tgz" "$(cut -d' ' -f1 "$tmp/helm.sha")"
tar -xzf "$tmp/$helm_tgz" -C "$tmp" && install -m 0755 "$tmp/$os-$arch/helm" "$dest/helm"

istio_tgz="istioctl-$ISTIO_VERSION-$os-$arch.tar.gz"
fetch "$tmp/$istio_tgz" "https://github.com/istio/istio/releases/download/$ISTIO_VERSION/$istio_tgz"
fetch "$tmp/istio.sha" "https://github.com/istio/istio/releases/download/$ISTIO_VERSION/$istio_tgz.sha256"
verify "$tmp/$istio_tgz" "$(cut -d' ' -f1 "$tmp/istio.sha")"
tar -xzf "$tmp/$istio_tgz" -C "$tmp" && install -m 0755 "$tmp/istioctl" "$dest/istioctl"

"$dest/kind" version; "$dest/kubectl" version --client; "$dest/helm" version --short; "$dest/istioctl" version --remote=false
