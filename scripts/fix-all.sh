#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

run_step() {
  printf '\n==> %s\n' "$1"
  shift
  "$@"
}

cd "$REPO_ROOT"

run_step "Prettier write" bun run format:write
