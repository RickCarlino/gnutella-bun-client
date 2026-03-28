#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRYPOINT="$REPO_ROOT/gnutella.ts"
OUTDIR="$REPO_ROOT/dist"

TARGETS=(
  bun-linux-x64
  bun-linux-x64-baseline
  bun-linux-x64-musl
  bun-linux-x64-musl-baseline
  bun-linux-arm64
  bun-linux-arm64-musl
  bun-darwin-x64
  bun-darwin-x64-baseline
  bun-darwin-arm64
  bun-windows-x64
  bun-windows-x64-baseline
)

mkdir -p "$OUTDIR"

for target in "${TARGETS[@]}"; do
  outfile="$OUTDIR/gnutella-$target"
  if [[ "$target" == bun-windows-* ]]; then
    outfile="${outfile}.exe"
  fi

  printf 'Building %s -> %s\n' "$target" "$outfile"
  bun build --compile --target="$target" --outfile "$outfile" "$ENTRYPOINT"
done
