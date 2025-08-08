# Repository Guidelines

## Project Structure & Module Organization

- `main.ts`: Bun entrypoint; starts `GnutellaNode` and HTTP server.
- `src/`: Core TypeScript modules (protocol, server, routing, utils). Notable: `gnutella-node.ts`, `GnutellaServer.ts`, `Message*`, `core/*`, `http.tsx` (Hono routes).
- `templates/`: Hono JSX views (e.g., `index.tsx`).
- `gnutella-library/`: Local files exposed via the HTTP UI and URN endpoints.
- `docs/`: Protocol specs and reference materials.
- `cache-server.ts`: Optional GWebCache service.
- `settings.json`: Peer/cache state. Treat as local data.

## Build, Test, and Development Commands

- Install deps: `bun install`
- Run node (dev): `bun main.ts` (serves HTTP on 8080; Gnutella on 6346).
- Run GWebCache: `bun cache-server.ts`
- Lint: `bun run lint` (ESLint)
- Fix lint: `bun run lint:fix`
- Format: `bun run format` (Prettier)
- Type-check: `bun run typecheck` (tsc noEmit)
- All checks: `bun run all`
- Tests (when present): `bun test` or `bun test path/to/file.test.ts`

## Coding Style & Naming Conventions

- Language: TypeScript (ESM). Strict TS enabled.
- Formatting: Prettier defaults (2 spaces, double quotes, semicolons).
- Linting: ESLint with `@typescript-eslint`.
- Custom rule: no `else if` (`custom/no-else-if`). Prefer `switch`, lookup maps, or early returns.
- Naming: `PascalCase` for classes/types; `camelCase` for functions/vars; `SCREAMING_SNAKE_CASE` for constants.
- Imports: keep relative module paths explicit (project uses `.ts` imports, ESM).

## Testing Guidelines

- Framework: Bun test runner.
- Location: colocate as `src/**/*.test.ts`.
- Naming: `*.test.ts` with descriptive `describe()` blocks.
- Run: `bun test` (add `--watch` locally if desired). Aim for unit tests around parsers, routers, and hashing utilities.

## Commit & Pull Request Guidelines

- Commits: concise, imperative subject (≤72 chars). Conventional Commits preferred (`feat:`, `fix:`, `chore:`, `refactor:`).
- PRs: include summary, rationale, before/after notes, and manual test steps. Link related issues; attach logs or screenshots for protocol/HTTP changes.
- Checks: ensure `bun run all` passes before requesting review.

## Security & Configuration Tips

- Do not commit private IPs, tokens, or large binaries. `settings.json` is local state.
- Default ports: HTTP `8080`, Gnutella `6346`. Expose carefully when running on public hosts.
