# GBun: A Gnutella Client for Bun

GnutellaBun is a Gnutella 0.6 servent written for Bun. You can use it in two ways:

- as an interactive command-line client for sharing, searching, and downloading files
- as a TypeScript library for embedding a Gnutella node in your own code

It aims to be straightforward to run and pleasant to extend.

## Download Binaries

Prebuilt binaries for the latest release:

- [Windows](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64.exe)
- [Windows (older CPUs)](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64-baseline.exe)
- [macOS Intel](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-x64)
- [macOS Apple Silicon](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-arm64)
- [Linux builds](https://github.com/RickCarlino/gnutella-bun-client/releases)

## Why Use It

If you want a Gnutella client, this gives you:

- a real interactive CLI
- automatic peer reconnect and peer discovery
- local file sharing from a directory
- network search with routed query hits
- direct downloads, ranged resume, and push fallback
- leaf and ultrapeer operating modes
- optional compression, query routing, pong caching, GGEP, and `BYE`
- a scriptable mode for repeatable command sequences

If you want a library, this gives you:

- a reusable `GnutellaServent` runtime
- typed events for peer, query, and download activity
- config helpers for creating and loading node configs
- direct access to the protocol implementation in `src/protocol.ts`

## What It Supports

### Core Network Features

- Gnutella 0.6 inbound and outbound handshake
- leaf and ultrapeer node modes
- `PING` and `PONG`
- `QUERY` and `QUERY_HIT`
- `PUSH`
- `BYE`
- peer discovery from pongs and `X-Try`
- routed traffic across multi-peer meshes

### Search Features

- local indexing of the download directory
- recursive share scanning
- SHA-1 URN generation for shared files
- keyword-based query matching
- outgoing URN queries
- browse-host style index queries
- local result buffer with numbered results
- detailed per-result inspection
- `clear` command to reset the current result set

### Download Features

- `GET /get/<index>/<name>`
- `GET /uri-res/N2R?<urn>`
- `HEAD` support
- byte range support
- resume from the current size of an existing destination file
- push fallback when direct download fails

### Optional Protocol Features

- opportunistic peer-link TLS
- deflate compression
- Query Routing Protocol
- GGEP-aware query behavior
- pong caching

## Quick Start

Create a config:

```bash
bun run gnutella.ts init --config gnutella.json
```

Edit `gnutella.json`:

- add one or more bootstrap peers to `state.peers`, for example `"127.0.0.1:6346": 0`
- put files you want to share in `<data_dir>/downloads`
- downloads also go to `<data_dir>/downloads`
- set `advertised_port` if your external port differs from `listen_port`
- optionally set `advertised_host` only when you need to override automatic `Remote-IP` learning
- set `config.ultrapeer` to `true` to run as an ultrapeer or `false` to force leaf mode
- adjust `max_connections`, `max_leaf_connections`, and `max_ultrapeer_connections` if you want a smaller or larger peer footprint than the defaults
- set `config.log_ignore` if you want `monitor` to suppress noisy event classes such as `PING` and `PONG`

Run the client:

```bash
bun run gnutella.ts run --config gnutella.json
```

The prompt shows:

- connected peers
- max peers
- inbound activity
- buffered result count

## CLI Commands

| Command                          | What it does                                                    |
| -------------------------------- | --------------------------------------------------------------- |
| `monitor`                        | Toggle verbose live protocol logging. Off by default.           |
| `help`                           | Show the command list.                                          |
| `status`                         | Show peer, share, result, and known-peer counts.                |
| `peers`                          | List connected peers and their direction/compression/TLS flags. |
| `connect <host:port>`            | Connect to a peer and remember it for future boots.             |
| `shares`                         | List the files currently being shared.                          |
| `results`                        | Show the current search-result table.                           |
| `clear`                          | Clear the current result buffer and restart result numbering.   |
| `ping [ttl]`                     | Send a ping.                                                    |
| `query <terms...>`               | Search the network. Supports quoted args, escapes, and URNs.    |
| `browse`                         | Send the Gnutella index query used for browse-host responses.   |
| `info <resultNo>`                | Show detailed information for one buffered result.              |
| `download <resultNo> [destPath]` | Download one result by its local result number.                 |
| `rescan`                         | Rebuild the local file index.                                   |
| `save`                           | Write the current config to disk.                               |
| `sleep`                          | Pause during scripted runs.                                     |
| `quit` / `exit`                  | Stop the node cleanly.                                          |

In the `peers` table, the `FL` column is a compact three-character flag set:

- `O` or `I`: outbound or inbound connection
- `Z` or `-`: deflate compression active or not active
- `L` or `-`: TLS active or not active

For example, `OZL` means an outbound peer with deflate and TLS, and `I--` means an inbound plaintext peer with no compression or encryption.

## Scripted Use

The CLI accepts repeated `--exec` arguments. Each one is run in order after startup.

```bash
bun run gnutella.ts run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for:

- scripted demos
- reproducible manual checks
- running several local nodes in separate terminals

## Monitoring

`monitor` is the high-noise live trace mode for the CLI. It is off by default so normal startup stays readable.

When enabled, it prints:

- handshake progress and failures
- peer up/down events
- inbound and outbound descriptor traffic
- query sends, receives, skips, and hits
- push and download activity
- maintenance errors and share refreshes

`log_ignore` lets you suppress log classes you do not care about. The values are matched against the monitor tags, so broad tags such as `PING` and `PONG` work, and more specific tags such as `RX:PING`, `TX:PONG`, `QUERY_RESULT`, or `PEER_CONNECTED` also work.

## How Search and Download Work

### Search

When you run `query`, the node broadcasts a Gnutella query and buffers any hits that route back.

- Results are assigned local numbers such as `1`, `2`, `3`
- Those numbers are only local UI numbers
- `clear` wipes the buffer and starts numbering over
- `results` prints the buffer in a readable table

### Query Parsing

The REPL uses a small shell-style argument parser before it sends the search text.

- `search` is an alias for `query`
- single quotes and double quotes preserve spaces
- backslash escapes the next character
- `query ""` sends an empty textual query
- tokens shaped like `urn:...` are emitted as URN query extensions instead of plain text

Examples:

```text
query hello world
query "hello world"
query ""
query urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2
query urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2 "alpha mix"
```

Pure URN searches go out with an empty textual search and one or more URN extensions. Mixed searches carry both the text portion and the URN list.

### Browse and Result Inspection

`browse` sends the special Gnutella index query: an exact four-space search string with `TTL=1`. This is the browse-host style query shape used by Gnutella nodes. It is broadcast to your currently connected peers; it is not a targeted request to one specific host.

In practice:

- run `browse`
- wait for hits to come back
- use `results` for the compact table
- use `info <resultNo>` for the full view of one hit

`info` prints the fields that matter when deciding whether to fetch a result: remote host and port, file index, servent ID, query ID and hops, vendor code, SHA-1 URN, any extra URNs, metadata, and the push/busy flags.

### Download

When you run `download <resultNo>`, the node tries:

1. a URI-RES request if the result includes a SHA-1 URN and URI-RES is enabled
2. a normal `/get` request
3. a `PUSH` request if direct download fails

If the destination file already exists, the node resumes from the current file size by using an HTTP range request.

## Peer Management

The node keeps one persistent peer store in `state.peers`.

- peers you connect to manually with `connect`
- peers discovered from `PONG`
- peers discovered from `X-Try`
- peers discovered from gwebcache fallback bootstrapping

The keys are normalized `host:port` strings. The values are Unix timestamps for the last stable connection, or `0` until the node has stayed connected to that peer long enough to trust it. Startup dialing sorts this map from most recently stable peer to least recent, with `0` entries last.

## Configuration

The config file has two top-level keys:

- `config`: runtime settings
- `state`: persistent runtime identity

Persistent runtime state includes `servent_id_hex` and the `peers` map.

### Network Identity

| Field                                 | Meaning                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listen_host` / `listen_port`         | Where the node listens locally.                                                                                                                                                                                  |
| `advertised_host` / `advertised_port` | Optional overrides for what the node tells peers to use when connecting back or downloading. By default it learns the host from peer `Remote-IP` reports and uses `listen_port` unless `advertised_port` is set. |

### Sharing and Downloads

| Field      | Meaning                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `data_dir` | Root directory for runtime data. Files you share and files you download both live in `<data_dir>/downloads`. |

### Node Mode

`config.ultrapeer` controls how the node presents itself to the network:

- `true`: run as an ultrapeer
- `false`: run as a leaf
- omitted: default to leaf mode

When running as an ultrapeer, the node advertises ultrapeer capability in the handshake, accepts both mesh peers and leaves, relays traffic, and uses Query Routing Protocol updates for attached peers. The default connection caps are intentionally conservative for smaller hosts: up to `12` mesh peers plus `24` leaves.

When running as a leaf, the node behaves as a shielded client and keeps up to `4` ultrapeer connections by default.

| Field                       | Meaning                                     |
| --------------------------- | ------------------------------------------- |
| `max_connections`           | Mesh-peer cap when running as an ultrapeer. |
| `max_leaf_connections`      | Leaf-peer cap when running as an ultrapeer. |
| `max_ultrapeer_connections` | Ultrapeer cap when running as a leaf.       |

### TLS and Monitoring

| Field        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `log_ignore` | Case-insensitive list of monitor tags to suppress when `monitor` is on. |

Peer-link TLS is opportunistic by default. The node advertises `Upgrade: TLS/1.0` and upgrades connections when peers agree.

On-disk config uses snake_case only.

Most other networking, timing, feature, and protocol tuning values are compile-time constants in the codebase.

## Library Use

The main library entry is [`src/protocol.ts`](src/protocol.ts).

### Minimal Example

```ts
import { GnutellaServent, loadDoc } from "./src/protocol";
import type { GnutellaEvent } from "./src/types";

const configPath = "./gnutella.json";
const doc = await loadDoc(configPath);

const node = new GnutellaServent(configPath, doc, {
  onEvent(event: GnutellaEvent) {
    if (event.type === "QUERY_RESULT") {
      console.log(
        `#${event.hit.resultNo} ${event.hit.fileName} from ${event.hit.remoteHost}:${event.hit.remotePort}`,
      );
    }

    if (event.type === "DOWNLOAD_SUCCEEDED") {
      console.log("downloaded to", event.destPath);
    }
  },
});

await node.start();
await node.connectToPeer("127.0.0.1:6346");
node.sendQuery("hello world");
```

### What the Library Gives You

- config helpers: `defaultDoc()`, `loadDoc()`, `writeDoc()`
- node lifecycle: `start()`, `stop()`, `save()`, `refreshShares()`
- network actions: `connectToPeer()`, `sendPing()`, `sendQuery()`
- transfer actions: `downloadResult()`
- runtime inspection: `getStatus()`, `getPeers()`, `getKnownPeers()`, `getShares()`, `getResults()`, `getDownloads()`
- event subscription through the constructor or `subscribe()`

For developers who want deeper protocol access, `src/protocol.ts` also exposes the packet encoders, decoders, and request builders used by the CLI and runtime.

## Internal Module Notes

- `src/protocol/node.ts` keeps the public `GnutellaServent` facade thin and binds the focused runtime modules.
- `src/protocol/node_state.ts` owns runtime config, persisted peer state, timers, share refreshes, and save/load-adjacent bookkeeping.
- `src/protocol/node_protocol_runtime.ts` owns live peer attachment, descriptor routing, pong/query route caches, and Query Routing Protocol exchange.
- `src/protocol/node_transfer.ts` owns `/get`, `uri-res`, resumable downloads, push callbacks, and download bookkeeping.
- `src/protocol/node_handshake.ts` and `src/protocol/node_tls.ts` own handshake negotiation and optional TLS upgrades.
- `src/gwebcache/bootstrap.ts` handles cache discovery and self-report orchestration, while `src/gwebcache/response.ts` handles cache-response parsing.
- `src/protocol.ts` and `src/gwebcache_client.ts` should stay facades unless new feature work creates a clearer boundary.

## Developer Checks

- `bun run verify` is read-only. It runs type checking, duplication checks, linting, unused-export checks, unit tests, integration tests, Prettier checks, and the multi-target build.
- `bun run fix` runs the safe formatter pass.

## Using It as a Client

This is a good fit if you want:

- a Gnutella 0.6 client you can run locally
- a client that can be scripted from the command line
- a node you can point at a peer list and watch work
- a simple codebase to study or extend

## Using It as a Library

This is a good fit if you want:

- a reusable Gnutella runtime without a framework
- a typed event stream for searches, peers, and downloads
- direct control over config, lifecycle, and commands
- access to the lower-level protocol helpers without fighting a large abstraction layer

## Standalone Binary Build

If you want a compiled executable instead of `bun run`, build the CLI with:

```bash
./scripts/build-all-targets.sh
```

Compiled artifacts are written to `dist/`.

## Files You Will Care About

| Path                                             | Purpose                     |
| ------------------------------------------------ | --------------------------- |
| [`gnutella.ts`](gnutella.ts)                     | CLI entrypoint              |
| [`src/cli.ts`](src/cli.ts)                       | Interactive client runtime  |
| [`src/protocol.ts`](src/protocol.ts)             | Gnutella 0.6 implementation |
| [`src/types.ts`](src/types.ts)                   | Public type definitions     |
| [`gnutella.json.example`](gnutella.json.example) | Example config              |

## First Local Run

Start one node in each of two terminals:

```bash
bun run gnutella.ts init --config a.json
bun run gnutella.ts run --config a.json
```

```bash
bun run gnutella.ts init --config b.json
bun run gnutella.ts run --config b.json
```

Then:

- add each node to the other node's `state.peers` map with a value of `0`
- put one test file in each node's `<data_dir>/downloads`
- search from one side with `query <name>`
- view results with `results`
- fetch one with `download <resultNo>`

That is the core loop this project is built around.
