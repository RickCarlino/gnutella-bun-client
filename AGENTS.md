# Repository Guidelines

## Project Structure & Module Organization

The public CLI entrypoint is [`gnutella.ts`](gnutella.ts). Runtime configuration lives in `gnutella.json`; use `gnutella.json.example` as the template for new setups. The protocol implementation lives in [`src/protocol.ts`](src/protocol.ts), shared literal constants live in [`src/const.ts`](src/const.ts), shared simple type declarations live in [`src/types.ts`](src/types.ts), and shared helpers live in [`src/shared.ts`](src/shared.ts) and [`src/cli_shared.ts`](src/cli_shared.ts). Build automation is in `scripts/build-all-targets.sh`. Compiled artifacts are written to `dist/` and should not be committed.

## Build, Test, and Development Commands

Use Bun directly from the repo root:

- `bun run gnutella.ts init --config gnutella.json` creates a default config and required directories.
- `bun run gnutella.ts run --config gnutella.json` starts the interactive client.
- `bun run gnutella.ts run --config gnutella.json --exec 'query hello' --exec 'quit'` runs scripted checks.
- `./scripts/build-all-targets.sh` compiles standalone binaries into `dist/`.

## Coding Style & Naming Conventions

Match the existing style in `gnutella.ts`: 2-space indentation, semicolons, single quotes, and small helper functions with explicit `type` aliases. Prefer `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for protocol constants, and short, protocol-oriented names (`parsePeer`, `writeDoc`, `TYPE_NAME`). Keep new logic dependency-free unless there is a strong reason to change the project model.

## Testing Guidelines

There is no formal test framework yet. Validate changes with scripted Bun runs and the two-node localhost setup described in `README.md`. When changing routing, downloads, or handshake logic, test both interactive flow and `--exec` automation. If you add automated tests later, place them in a top-level `tests/` directory and name files `*.test.ts`.

## Commit & Pull Request Guidelines

You can read Git but do not write commits without asking.

## Security & Configuration Tips

Do not commit real peer addresses or private runtime state from `gnutella.json`. Review `advertisedHost`, `advertisedPort`, and shared/download directories before testing outside localhost.
