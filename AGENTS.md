# Repository Guidelines

## Project Structure & Module Organization

The public CLI entrypoint is [`gnutella.ts`](gnutella.ts). Runtime configuration lives in `gnutella.json`; use `gnutella.json.example` as the template for new setups. The protocol implementation lives in [`src/protocol.ts`](src/protocol.ts), shared literal constants live in [`src/const.ts`](src/const.ts), shared simple type declarations live in [`src/types.ts`](src/types.ts), and shared helpers live in [`src/shared.ts`](src/shared.ts) and [`src/cli_shared.ts`](src/cli_shared.ts). Build automation is in `scripts/build-all-targets.sh`. Compiled artifacts are written to `dist/` and should not be committed.

Keep module ownership tight. Put protocol-specific helpers with the protocol code, GWebCache-specific helpers with the GWebCache code, and reserve `src/shared.ts` for genuinely generic helpers. Avoid adding unrelated responsibilities to the same file just because it is already large or already imported widely.

## Build, Test, and Development Commands

Use Bun directly from the repo root:

- `bun run gnutella.ts init --config gnutella.json` creates a default config and required directories.
- `bun run gnutella.ts run --config gnutella.json` starts the interactive client.
- `bun run gnutella.ts run --config gnutella.json --exec 'query hello' --exec 'quit'` runs scripted checks.
- `bun run verify` runs the required post-change verification sequence: type checker, ESLint, ts-unused-exports, unit tests, integration tests, Prettier, and the multi-target build.
- `./scripts/build-all-targets.sh` compiles standalone binaries into `dist/`.

## Coding Style & Naming Conventions

Match the existing style in `gnutella.ts`: 2-space indentation, semicolons, single quotes, and small helper functions with explicit `type` aliases. Prefer `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for protocol constants, and short, protocol-oriented names (`parsePeer`, `writeDoc`, `TYPE_NAME`). Keep new logic dependency-free unless there is a strong reason to change the project model.

## Maintainability Guardrails

Prefer extraction over growth. If a change meaningfully expands protocol, transfer, bootstrap, or parsing logic, prefer adding a focused module instead of growing the existing monoliths. Treat `src/protocol.ts` as a public facade when practical, and avoid turning `src/gwebcache_client.ts` into a second catch-all module.

Keep files small enough to understand in one pass. As a rule of thumb, avoid adding new source files over roughly 800 lines, and treat anything over 1000 lines as a refactor candidate rather than a normal destination for more code. The repo enforces a 1000-line max through ESLint, which means oversized files will fail `bun run verify` until they are brought back under the limit.

Keep runtime state, persisted state, parsing, transport, and CLI concerns separate. Do not add new features by hanging more mutable state or unrelated behavior directly off `GnutellaServent` unless there is a clear reason.

No new production `any` or `Promise<any>`. If a core path needs a richer shape, define a named type and use it consistently.

Favor explicit seams over monkeypatching. When a test would need `as any` to replace internal methods, treat that as a sign that the production code likely needs a better boundary or injected collaborator.

When adding helpers, prefer one canonical implementation. Do not duplicate generic helpers across `shared` modules unless there is a deliberate module-boundary reason.

## Testing Guidelines

There is no formal test framework yet. Validate changes with scripted Bun runs and the two-node localhost setup described in `README.md`. Run `bun run verify` after any change to the codebase. When changing routing, downloads, or handshake logic, test both interactive flow and `--exec` automation. If you add automated tests later, place them in a top-level `tests/` directory and name files `*.test.ts`.

Prefer tests that exercise public APIs or explicit collaborators. Avoid coupling tests to internal implementation details unless there is no practical alternative.

## Commit & Pull Request Guidelines

You can read Git but do not write commits without asking.

## Security & Configuration Tips

Do not commit real peer addresses or private runtime state from `gnutella.json`. Review `advertisedHost`, `advertisedPort`, and shared/download directories before testing outside localhost.
