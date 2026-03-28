# Cleanup Plan

## Purpose

This document reflects the current cleanup state of the repo after the large protocol and GWebCache extraction pass.

The earlier version of this document was accurate for the pre-extraction codebase, but it is no longer a good description of the current tree. The goal now is not "break up the two giant files." That work is mostly done. The goal now is to finish the boundary work so the extracted modules stay maintainable.

## Executive Summary

The codebase is in better shape than the original report described:

- `src/protocol.ts` is now a thin public facade.
- `src/gwebcache_client.ts` is now a thin public facade.
- protocol and GWebCache logic are distributed across focused internal modules.
- most of the contributor guardrails from the original report now live in `AGENTS.md`.

The main cleanup work left is different:

- `GnutellaServent` still owns both persisted state and transient runtime state.
- tests still patch internals with `as any` and `unknown as` instead of using stable seams.
- a few production `any` remain, and helper ownership is still slightly fuzzy.
- the CLI still relies on module-level session state.
- `bun run verify` still mutates the worktree.

This is no longer a monolith emergency. It is now a seam-hardening and ownership cleanup pass.

## Current Shape

Current line counts for the most relevant files:

- `src/protocol.ts`: 20
- `src/gwebcache_client.ts`: 13
- `src/protocol/node_protocol_runtime.ts`: 918
- `src/protocol/node_transfer.ts`: 669
- `src/protocol/node_state.ts`: 635
- `src/protocol/codec.ts`: 569
- `src/protocol/peer_state.ts`: 489
- `src/protocol/node_handshake.ts`: 465
- `src/gwebcache/bootstrap.ts`: 487
- `src/gwebcache/response.ts`: 372
- `src/cli.ts`: 283

The complexity is now distributed instead of being concentrated in two entry modules. That is good progress.

The remaining concentration point is the `GnutellaServent` object and the set of modules that still treat it as the place where every kind of state and side effect lives.

## What Is Already Done

### 1. `src/protocol.ts` is now a facade

This part of the original plan is complete in substance.

The public protocol entrypoint now re-exports from internal modules instead of implementing the protocol directly:

- `src/protocol/codec.ts`
- `src/protocol/qrp.ts`
- `src/protocol/peer_state.ts`
- `src/protocol/node.ts`
- `src/protocol/node_handshake.ts`
- `src/protocol/node_lifecycle.ts`
- `src/protocol/node_protocol_runtime.ts`
- `src/protocol/node_transfer.ts`
- `src/protocol/node_state.ts`

That extraction already achieved the main goal of reducing the amount of context required to work on the protocol layer.

### 2. `src/gwebcache_client.ts` is now a facade

This part of the original plan is also complete in substance.

The GWebCache entrypoint now delegates to:

- `src/gwebcache/bootstrap.ts`
- `src/gwebcache/response.ts`
- `src/gwebcache/shared.ts`
- `src/gwebcache/types.ts`

There is still optional cleanup available inside those modules, but the original "second giant all-purpose helper" concern has largely been addressed.

### 3. The maintainability guardrails were adopted

The most important contributor-facing rules from the original report now exist in `AGENTS.md`, including:

- keep `src/protocol.ts` as a public facade
- avoid turning `src/gwebcache_client.ts` into a catch-all
- prefer extraction over growth
- avoid new production `any`
- prefer explicit seams over monkeypatching
- keep helper ownership tight

That means this document no longer needs to act as the only place where those rules are written down.

## Primary Remaining Findings

### 1. `GnutellaServent` still mixes persisted and runtime state

`GnutellaServent` is no longer a giant implementation file, but it still acts as the central storage object for too many unrelated concerns.

Today it still owns:

- persisted config document data through `doc`
- runtime peer maps and dedupe/routing state
- downloads and pending push queues
- GWebCache bootstrap/report state
- advertised host learning state
- timers, listeners, and server handles

This is better than the original monolith, but it still blurs the boundary between:

- on-disk state
- stable runtime configuration
- transient routing/runtime state
- transfer state
- side-effect collaborators

The most obvious signal is that `config()` still derives a `RuntimeConfig` from `doc` on demand instead of exposing a stable runtime config object.

### 2. The test seams are still too weak

This is now the highest-value remaining cleanup item.

The tests still replace internals directly in several places, for example by monkeypatching methods on `GnutellaServent` or replacing `config()` in helpers. That makes the tests workable, but it also means the production design still does not expose the right seams for:

- scheduling
- time
- network creation
- bootstrap behavior
- selected protocol actions

This matters more than file size now. If the seams stay weak, future refactors will still be expensive even though the code is split into more files.

### 3. Type cleanup is not finished

The biggest type cleanup from the original report was completed. For example, the old descriptor-header complaint is effectively addressed by the typed protocol module layout.

But a few important cleanup items remain:

- `PendingPush` still uses `resolve: (v: any) => void`
- `PendingPush` still uses `reject: (e: any) => void`
- `errMsg` still accepts `any`
- `errMsg` still exists in both `src/shared.ts` and `src/cli_shared.ts`

These are small compared with the old monolith problem, but they are still exactly the kind of drift that weakens a codebase over time.

### 4. The CLI state model is still implicit

`src/cli.ts` is not large, but it still stores session state in module-level mutable variables for:

- the active readline interface
- the active node
- prompt throbber frame state
- prompt throbber timers

This is still manageable, but a small `CliSession` object would make ownership and lifecycle clearer and would make the module easier to test.

### 5. `verify` still mixes checks and mutation

This is still an open item from the original report.

`scripts/verify-all.sh` still runs `format:write` during `bun run verify`. That means verification is not read-only, which has a few downsides:

- running verification can change local diffs
- CI semantics are less clear than they should be
- "check" and "fix" are still blended together

This is not a difficult cleanup, but it is still worth doing.

### 6. Some modules should be watched, not immediately split

The original plan called for a large extraction pass. That is no longer the right next move.

The more realistic stance now is:

- do not proactively split modules just because they are the biggest remaining ones
- do split them if the next feature would push them across a clear responsibility boundary

The main watch-list modules are:

- `src/protocol/node_protocol_runtime.ts`
- `src/protocol/node_state.ts`
- `src/protocol/node_transfer.ts`
- `src/gwebcache/bootstrap.ts`
- `src/gwebcache/response.ts`

None of these are a crisis today. They are just the most likely places to accumulate the next round of design debt if left unguarded.

## Updated Cleanup Direction

### Stage 1: Preserve the facade structure

Treat this as already done and non-negotiable:

- `src/protocol.ts` stays export-only except for tiny facade wiring
- `src/gwebcache_client.ts` stays export-only except for tiny facade wiring

The cleanup plan should not reopen the old monolith shape.

### Stage 2: Separate persisted state from runtime state

This is the most important structural item still open.

Recommended direction:

- keep `ConfigDoc` strictly about on-disk shape
- introduce a stable runtime config object instead of recomputing from `doc`
- move persisted peer bookkeeping behind explicit peer-state helpers
- isolate transient routing/download/bootstrap state from persisted state
- reduce the number of places that mutate `node.doc` directly

The goal is not a framework. The goal is to make save/load behavior and transient runtime behavior easy to distinguish.

### Stage 3: Add explicit collaborators for side effects

Instead of making tests patch instance methods, add a small collaborator bag to the node runtime.

The likely collaborators are:

- `clock.now()`
- `scheduler.setTimeout()`
- `scheduler.clearTimeout()`
- `scheduler.setInterval()`
- `scheduler.clearInterval()`
- `netFactory.createConnection()`
- `netFactory.createServer()`
- `bootstrapClient.connectBootstrapPeers()`
- `bootstrapClient.reportSelfToGWebCaches()`

This does not need a dependency-injection framework. A simple options bag on construction is enough.

This is the cleanup that would pay down the most `as any` usage in the tests.

### Stage 4: Tighten remaining types and unify helpers

Specific targets:

- replace `PendingPush` callback `any` types with explicit signatures
- make error-formatting helpers accept `unknown`
- centralize `errMsg` in one module
- remove the remaining production `any` unless there is a real interop reason

This is a good companion task to the seam work because both changes improve refactor confidence.

### Stage 5: Encapsulate CLI session state

Wrap the module-level CLI globals in a small session object, for example:

```text
type CliSession = {
  rl: readline.Interface | null;
  node: GnutellaServent | null;
  promptFrame: number;
  promptTimer: ReturnType<typeof setTimeout> | null;
  promptInitial: boolean;
};
```

This is not urgent, but it is a clean and low-risk follow-up once the higher-value runtime seams are in place.

### Stage 6: Make verification read-only

Recommended command split:

- `bun run verify`: checks only
- `bun run fix`: formatting and other safe auto-fixes

At minimum, move `format:write` out of `verify` and keep `format:check` inside it.

### Stage 7: Only split the remaining larger modules when a boundary is clear

Do not create extraction work just to create extraction work.

Good examples of justified follow-up splits would be:

- route-cache and descriptor-dispatch logic separating from `node_protocol_runtime.ts`
- transfer-session state separating from `node_transfer.ts`
- self-report/update behavior separating from `gwebcache/bootstrap.ts`
- request execution separating from response parsing in `gwebcache/response.ts`

Those are worthwhile only if feature work starts pushing those files across a real responsibility boundary.

## Updated Priority Order

### Priority 1

- add explicit collaborators so tests stop patching internals
- separate persisted state from transient runtime state
- remove the remaining production `any` and helper duplication around `errMsg`

### Priority 2

- make `verify` read-only
- encapsulate CLI session state
- reduce direct `doc` mutation points

### Priority 3

- add short architecture notes for the remaining protocol submodules
- split the current larger internal modules only when feature work forces a real boundary

## A Practical Next Milestone

The best next milestone is not another extraction sweep. It is a zero-behavior boundary pass.

Recommended first pass:

1. Add a small collaborator/options bag to `GnutellaServent` for clock, scheduler, net, and bootstrap side effects.
2. Convert the tests that currently monkeypatch methods to use those collaborators instead.
3. Replace the remaining production `any` in `PendingPush` and error formatting.
4. Centralize `errMsg`.
5. Split `verify` and `fix`.

That milestone would remove the most misleading cleanup debt left in the repo without reopening the architecture.

## Final Assessment

The old plan correctly identified that responsibility was too concentrated, but the repo has already moved past the worst version of that problem.

Today the main risk is not "two giant entrypoint files." The main risk is that the extracted modules still share a runtime object with weak seams, mixed state ownership, and a few lingering type/utility shortcuts.

That is a much healthier problem to have. The cleanup plan should now focus on making the current design easier to test and safer to evolve, not on repeating the extraction work that has already been completed.
