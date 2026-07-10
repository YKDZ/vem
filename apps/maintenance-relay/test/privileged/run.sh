#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
image="vem-maintenance-relay-privileged-test:node24-bookworm-20260710"

docker build \
  --file "$root/apps/maintenance-relay/test/privileged/Dockerfile" \
  --tag "$image" \
  "$root"

docker run \
  --rm \
  --privileged \
  --network none \
  "$image"
