# Cleanup Report

## Purpose

This report captures the current maintainability risks in the codebase and a practical cleanup plan to address them before the next major feature. The code is still working and `bun run verify` is passing, but several structural issues are already visible. If left alone, the next feature will likely make the project harder to reason about, harder to test, and slower to change safely.

## Executive Summary

The main problem is not correctness. The main problem is concentration of responsibility.

Two files carry too much of the system:

- `src/protocol.ts`
- `src/gwebcache_client.ts`

The first is a god-module and the second is trending in the same direction. `GnutellaServent` in particular has become a god-object. It owns config loading, runtime state, peer management, handshake behavior, protocol routing, HTTP serving, downloads, bootstrap behavior, timers, and event emission. That makes it the default destination for every new feature, which is exactly how codebases get sloppy.

The second major problem is weak boundaries. Tests frequently patch internal methods and internal state with `as any` and `unknown as`. That is not just a test smell. It is evidence that the production design does not expose the right seams.

The third problem is that some typing and ownership discipline is starting to soften exactly where complexity is highest. There are still `any`-heavy signatures, duplicated helpers, and shared modules with fuzzy ownership.

The project is still in a recoverable state. This is the right time to clean it up.

## Current Shape

Approximate file sizes:

- `src/protocol.ts`: 4117 lines
- `src/gwebcache_client.ts`: 1087 lines
- `src/cli.ts`: 283 lines
- `src/shared.ts`: 214 lines
- `src/types.ts`: 321 lines

This is the clearest signal in the repo. The complexity is heavily concentrated, not distributed.

## Primary Findings

### 1. `src/protocol.ts` is carrying too many responsibilities

`src/protocol.ts` currently contains:

- config document loading and migration
- runtime config derivation
- packet encoders and decoders
- handshake parsing and formatting
- peer connection lifecycle
- routing and deduplication
- QRP logic
- HTTP serving logic
- HTTP client download logic
- push download logic
- bootstrap orchestration
- node lifecycle and scheduled maintenance

Representative sections:

- `src/protocol.ts#L1618`
- `src/protocol.ts#L2350`
- `src/protocol.ts#L2996`
- `src/protocol.ts#L3289`
- `src/protocol.ts#L3799`
- `src/protocol.ts#L3960`

This file is still understandable only because the code style is disciplined. The structure itself is no longer disciplined enough.

### 2. `GnutellaServent` is both runtime engine and storage model

The class stores `doc`, mutates `doc`, derives config from `doc`, and also owns all transient runtime state.

Examples:

- `src/protocol.ts#L1620`
- `src/protocol.ts#L1720`
- `src/protocol.ts#L1870`
- `src/protocol.ts#L1904`

That leads to several problems:

- persisted state and live state are mixed together
- it is hard to tell which mutations are in-memory only and which are intended to persist
- `config()` reconstructs runtime config on demand instead of exposing a stable runtime configuration object
- future features will be tempted to keep hanging new mutable state off the same class

This is manageable at small scale, but it becomes error-prone once the runtime grows further.

### 3. The test seams are too weak

The tests often patch internals directly rather than depending on stable collaborators. Examples:

- `tests/unit/protocol/node.test.ts#L238`
- `tests/unit/protocol/node.test.ts#L344`
- `tests/unit/protocol/node.test.ts#L1646`
- `tests/integration/protocol.test.ts#L136`

This usually means:

- the class has too many responsibilities
- important behaviors are trapped behind private implementation details
- dependencies are not injectable
- tests are forced to mock methods instead of collaborating through interfaces

This matters because weak seams slow down refactors. Every structural improvement becomes harder when the test suite is coupled to implementation details.

### 4. `src/gwebcache_client.ts` is a second concentration point

This file currently owns:

- request URL building
- response parsing
- timeout and signal handling
- bootstrap fetch behavior
- bootstrap retry policy
- bootstrap state mutation
- self-report behavior

Representative sections:

- `src/gwebcache_client.ts#L183`
- `src/gwebcache_client.ts#L620`
- `src/gwebcache_client.ts#L773`
- `src/gwebcache_client.ts#L925`
- `src/gwebcache_client.ts#L1030`

It is not yet as problematic as `src/protocol.ts`, but it is heading the same way. If left as-is, the next feature involving peer discovery or remote metadata will probably be dumped into this file too.

### 5. Type discipline is weaker than it should be in the hardest code

There are still important `any`-based or weakly typed areas in production code, for example:

- `src/protocol.ts#L1674`
- `src/protocol.ts#L2897`
- `src/protocol.ts#L3504`
- `src/protocol.ts#L3691`
- `src/types.ts#L139`
- `src/shared.ts#L9`
- `src/cli_shared.ts#L28`

This is the wrong place to give up type precision. These are core pathways:

- descriptor dispatch
- download flows
- event/error propagation
- pending push bookkeeping

Loose typing here means future refactors will have less compiler support exactly where they need the most support.

### 6. Utility ownership is getting fuzzy

`errMsg` exists in two places:

- `src/shared.ts#L9`
- `src/cli_shared.ts#L28`

This is a small issue, but it is a warning sign. Shared modules should not accumulate overlapping helpers with unclear ownership. That is how projects slowly drift into “I think there is already a helper for this somewhere” territory.

### 7. The CLI is not large, but its state model is implicit

`src/cli.ts` is still manageable, but it keeps session state in module-level mutable variables:

- `src/cli.ts#L24`
- `src/cli.ts#L73`
- `src/cli.ts#L217`

This is workable for a single process with one session, but it makes reuse and testing less clear than it needs to be. A small `CliSession` object would make ownership of prompt state, timers, and REPL lifecycle more explicit.

### 8. `verify` mixes validation and mutation

`scripts/verify-all.sh` currently runs `format:write` as part of `verify`:

- `scripts/verify-all.sh#L16`

That is convenient locally, but it is not ideal workflow design. A verification command should be read-only. Otherwise:

- local diffs get changed during verification
- CI semantics become less clear
- users cannot easily distinguish “check” from “fix”

This is a smaller problem than the structural ones, but it is worth correcting.

## What This Means for the Next Feature

If the next large feature lands before cleanup, the most likely outcome is:

1. More code gets added to `src/protocol.ts`
2. Tests patch even more internals
3. More state ends up on `GnutellaServent`
4. It becomes harder to tell where protocol logic ends and application/runtime logic begins
5. Feature work slows down because every change requires broad context

The project will still work, but each feature will cost more to add and more to verify.

## Recommended Cleanup Direction

The right approach is not a rewrite. The right approach is staged extraction with stable public APIs.

### Stage 1: Turn `src/protocol.ts` into a facade

Keep the current public exports stable, but move implementation into submodules under `src/protocol/`.

Suggested layout:

```text
src/protocol/
  codec.ts
  config_doc.ts
  handshake.ts
  http_transfer.ts
  peer_store.ts
  query_match.ts
  qrp.ts
  routing.ts
  node.ts
```

Suggested ownership:

- `codec.ts`: encoders, decoders, header parsing, byte-range parsing
- `config_doc.ts`: config defaults, migration, persistence helpers
- `handshake.ts`: handshake parsing, formatting, capability building
- `http_transfer.ts`: inbound `/get` serving and outbound HTTP download flows
- `peer_store.ts`: persisted peer state handling and ranking
- `query_match.ts`: indexing and query matching helpers
- `qrp.ts`: QRP table logic
- `routing.ts`: seen cache, routes, push routes, pong cache
- `node.ts`: orchestration only

The important rule is this: `node.ts` should coordinate collaborators, not implement everything itself.

### Stage 2: Separate persisted state from runtime state

Right now, the storage model and runtime model are too tightly coupled.

Recommended split:

- `ConfigDoc`: strictly on-disk shape
- `RuntimeConfig`: stable in-memory config
- `PeerStore`: persisted known-peer management
- `RouteStore`: transient message routing and dedupe state
- `TransferState`: downloads, pending pushes, active auto-paths
- `AdvertisedAddressTracker`: learned/pending advertised host logic

This gives each area a clear owner and makes it much easier to reason about save/load behavior.

### Stage 3: Add explicit collaborators for side effects

Instead of forcing tests to patch methods on `GnutellaServent`, expose injectable collaborators.

Examples:

- `clock.now()`
- `scheduler.setTimeout()`
- `scheduler.setInterval()`
- `netFactory.createConnection()`
- `bootstrapClient.connectBootstrapPeers()`
- `bootstrapClient.reportSelf()`

This does not need a full dependency injection framework. A small options bag is enough.

Benefits:

- tests stop monkeypatching internals
- behavior becomes easier to isolate
- future refactors get safer

### Stage 4: Split `src/gwebcache_client.ts`

Suggested layout:

```text
src/gwebcache/
  parse.ts
  request.ts
  bootstrap.ts
  report.ts
  state.ts
```

Suggested ownership:

- `parse.ts`: line parsing and response models
- `request.ts`: URL building, fetch execution, timeout handling
- `bootstrap.ts`: peer fetch and retry orchestration
- `report.ts`: self-report/update behavior
- `state.ts`: bootstrap state helpers

The protocol layer should not depend on a giant all-purpose helper module.

### Stage 5: Tighten types in core paths

Specific targets:

- replace `hdr: any` with a typed descriptor header shape
- replace `Promise<any>` in download flows with explicit result types
- replace loose `resolve/reject` callbacks in `PendingPush`
- centralize error formatting in one utility
- remove production `any` unless there is a real interop reason

This will improve refactor confidence immediately.

### Stage 6: Encapsulate CLI state

Wrap the CLI globals in a small session object, for example:

```text
type CliSession = {
  rl: readline.Interface | null;
  node: GnutellaServent | null;
  promptFrame: number;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptInitial: boolean;
};
```

This is not urgent, but it is an easy cleanup and makes the REPL lifecycle clearer.

### Stage 7: Make verification read-only

Recommended scripts:

- `bun run verify`: check only
- `bun run fix`: format and maybe auto-fix lint issues

That split is easier to reason about and works better in CI and local review.

## Priority Order

If time is limited, these are the highest-value cleanups:

### Priority 1

- split `src/protocol.ts` into facade plus internal modules
- separate persisted state from runtime state
- add injectable collaborators so tests stop patching internals

### Priority 2

- split `src/gwebcache_client.ts`
- tighten types in descriptor and transfer flows
- remove duplicated/shared helper drift

### Priority 3

- encapsulate CLI session state
- make `verify` read-only
- add lightweight architecture notes for major modules

## Suggested Rules for Future Changes

These are good guardrails to add to `AGENTS.md` or another contributor-facing document.

### Module Size Rules

- No new source file should exceed roughly 800 lines without a very strong reason.
- Any file over 1000 lines is presumed to need decomposition.

### Type Rules

- No new production `any`.
- `Promise<any>` is not allowed in production code.
- If a type is not obvious, define it once instead of repeating inline object literals.

### Testing Rules

- Tests should prefer dependency injection and public seams over monkeypatching class internals.
- If a test needs `as any` to replace a method, treat that as a design smell and consider adding a seam.

### Ownership Rules

- `shared.ts` should contain only clearly generic helpers.
- Protocol-specific helpers belong under `src/protocol/`.
- GWebCache-specific helpers belong under `src/gwebcache/`.

### Feature Rules

- New protocol features should not be added directly to `src/protocol.ts` unless they are tiny exports or facade wiring.
- New peer-discovery behavior should not go into `src/gwebcache_client.ts` unless it clearly belongs to an existing extracted module.

## A Practical First Cleanup Milestone

The best first milestone is a zero-behavior-change extraction pass.

Goal:

- no feature changes
- no protocol behavior changes
- same public exports
- mostly file moves plus import rewiring

Recommended first pass:

1. Extract packet codecs and parsers from `src/protocol.ts`
2. Extract config doc load/save/migration helpers
3. Extract QRP logic
4. Extract HTTP serving/download helpers
5. Leave `GnutellaServent` as the facade/orchestrator

That first pass will already reduce the amount of context required to work on the codebase.

## Final Assessment

The codebase is not sloppy in the sense of being careless. It is sloppy in the sense of accumulating too much responsibility in too few places. That is a structural issue, not a style issue.

The good news is that the current code is still organized enough to refactor safely. The tests pass, the modules have recognizable internal clusters, and the public surface is small enough to preserve while internals are cleaned up.

The main objective now should be to stop `GnutellaServent` and the two large modules from absorbing any more unrelated behavior. If that happens before the next major feature, the project will stay understandable and much easier to evolve.
