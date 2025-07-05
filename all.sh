#!/usr/bin/env bash
bun run all        # run your Bun script
status=$?          # capture Bun’s exit code
[[ $status -eq 0 ]] && exit 0   # success → 0
exit 2                          # any non-zero → 2
