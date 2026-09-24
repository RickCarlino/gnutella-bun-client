#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for program in unshare ip bun; do
  command -v "$program" >/dev/null || { echo "interop prerequisite missing: $program" >&2; exit 1; }
done
exec unshare --user --map-root-user --net -- bash -euc '
  ip link set lo up
  ip address add 10.44.0.1/32 dev lo
  ip address add 10.44.0.2/32 dev lo
  export GNUTONIUM_INTEROP_ISOLATED=1
  exec unshare --user --map-user=1000 --map-group=1000 -- bun "$1/tests/interop/run.ts"
' bash "$REPO_ROOT"
