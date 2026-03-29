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

run_step "Type checker" bun run typecheck
run_step "jscpd" bun run dupcheck
run_step "ESLint" bun run lint
run_step "ts-unused-exports" bun run unused-exports
run_step "Unit tests" bun run test:unit
run_step "Integration tests" bun run test:integration
run_step "Prettier" bun run format:check
run_step "Build" bun run build:all
