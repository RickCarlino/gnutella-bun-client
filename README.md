# GBun: A Gnutella Client for Bun

GnutellaBun is a Gnutella 0.6 servent written for Bun. You can use it in two ways:

- as an interactive command-line client for sharing, searching, and downloading files
- as a TypeScript library for embedding a Gnutella node in your own code

It aims to be straightforward to run and pleasant to extend.

## Why Use It

If you want a Gnutella client, this gives you:

- a real interactive CLI
- automatic peer reconnect and peer discovery
- local file sharing from a directory
- network search with routed query hits
- direct downloads, ranged resume, and push fallback
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
- `PING` and `PONG`
- `QUERY` and `QUERY_HIT`
- `PUSH`
- `BYE`
- peer discovery from pongs and `X-Try`
- routed traffic across multi-peer meshes

### Search Features

- local indexing of a shared directory
- recursive share scanning
- SHA-1 URN generation for shared files
- keyword-based query matching
- local result buffer with numbered results
- `clear` command to reset the current result set

### Download Features

- `GET /get/<index>/<name>`
- `GET /uri-res/N2R?<urn>`
- `HEAD` support
- byte range support
- resume from the current size of an existing destination file
- push fallback when direct download fails

### Optional Protocol Features

- deflate compression
- Query Routing Protocol
- GGEP-aware query behavior
- pong caching
- ultrapeer-related handshake headers

## Quick Start

Create a config:

```bash
bun run gnutella.ts init --config gnutella.json
```

Edit `gnutella.json`:

- set `advertisedHost` and `advertisedPort` to values other peers can reach
- add one or more bootstrap peers to `config.peers`
- put files you want to share in `config.sharedDir`

Run the client:

```bash
bun run gnutella.ts run --config gnutella.json
```

The prompt shows:

- connected peers
- configured max peers
- inbound activity
- buffered result count

## CLI Commands

| Command                          | What it does                                                  |
| -------------------------------- | ------------------------------------------------------------- |
| `help`                           | Show the command list.                                        |
| `status`                         | Show peer, share, result, and known-peer counts.              |
| `peers`                          | List connected peers.                                         |
| `connect <host:port>`            | Connect to a peer and remember it for future boots.           |
| `shares`                         | List the files currently being shared.                        |
| `results`                        | Show the current search-result table.                         |
| `clear`                          | Clear the current result buffer and restart result numbering. |
| `ping [ttl]`                     | Send a ping.                                                  |
| `query <terms...>`               | Search the network.                                           |
| `download <resultNo> [destPath]` | Download one result by its local result number.               |
| `rescan`                         | Rebuild the shared-file index.                                |
| `save`                           | Write the current config to disk.                             |
| `sleep`                          | Pause during scripted runs.                                   |
| `quit` / `exit`                  | Stop the node cleanly.                                        |

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

## How Search and Download Work

### Search

When you run `query`, the node broadcasts a Gnutella query and buffers any hits that route back.

- Results are assigned local numbers such as `1`, `2`, `3`
- Those numbers are only local UI numbers
- `clear` wipes the buffer and starts numbering over
- `results` prints the buffer in a readable table

### Download

When you run `download <resultNo>`, the node tries:

1. a URI-RES request if the result includes a SHA-1 URN and URI-RES is enabled
2. a normal `/get` request
3. a `PUSH` request if direct download fails

If the destination file already exists, the node resumes from the current file size by using an HTTP range request.

## Peer Management

The node builds its peer list from several places:

- peers you put in `config.peers`
- peers you connect to manually with `connect`
- peers discovered from `PONG`
- peers discovered from `X-Try`

Known peers are saved in the config so the node can reconnect on the next start.

## Configuration

The config file has two top-level keys:

- `config`: runtime settings
- `state`: persistent runtime identity

The only persistent runtime state kept by default is `serventIdHex`.

### Network Identity

| Field                               | Meaning                                                               |
| ----------------------------------- | --------------------------------------------------------------------- |
| `listenHost` / `listenPort`         | Where the node listens locally.                                       |
| `advertisedHost` / `advertisedPort` | What the node tells peers to use when connecting back or downloading. |
| `peers`                             | Bootstrap peers to try on startup and reconnect.                      |
| `userAgent`                         | User-agent string sent in the handshake.                              |
| `vendorCode`                        | Vendor code placed in query-hit metadata.                             |

### Sharing and Downloads

| Field                 | Meaning                                                 |
| --------------------- | ------------------------------------------------------- |
| `sharedDir`           | Directory to share recursively.                         |
| `downloadsDir`        | Default destination for downloads.                      |
| `rescanSharesSec`     | How often the share index is refreshed.                 |
| `downloadTimeoutMs`   | Timeout for direct downloads and push callbacks.        |
| `pushWaitMs`          | How long to wait for a push callback before giving up.  |
| `serveUriRes`         | Whether the node serves and requests URI-RES downloads. |
| `advertisedSpeedKBps` | Speed reported in query hits.                           |

### Connectivity and Routing

| Field                  | Meaning                                                |
| ---------------------- | ------------------------------------------------------ |
| `maxConnections`       | Maximum live peer connections.                         |
| `connectTimeoutMs`     | Timeout for normal outbound peer dials.                |
| `reconnectIntervalSec` | How often to retry known peers.                        |
| `pingIntervalSec`      | How often to send automatic pings.                     |
| `routeTtlSec`          | How long routes stay valid.                            |
| `seenTtlSec`           | How long duplicate-suppression entries stay valid.     |
| `maxPayloadBytes`      | Maximum accepted descriptor payload size.              |
| `maxTtl`               | Maximum TTL allowed for forwarded traffic.             |
| `defaultPingTtl`       | Default TTL used by the CLI `ping` command.            |
| `defaultQueryTtl`      | Default TTL used by `query`.                           |
| `maxResultsPerQuery`   | Maximum number of local results returned to one query. |

### Optional Protocol Flags

| Field                 | Meaning                                |
| --------------------- | -------------------------------------- |
| `enableCompression`   | Enable negotiated deflate compression. |
| `enableQrp`           | Enable Query Routing Protocol support. |
| `enableBye`           | Send and honor `BYE`.                  |
| `enablePongCaching`   | Cache recent pong payloads.            |
| `enableGgep`          | Enable GGEP-related query behavior.    |
| `queryRoutingVersion` | Advertised QRP version string.         |
| `advertiseUltrapeer`  | Advertise ultrapeer-related headers.   |

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

- add each node to the other node's `config.peers`
- put one test file in each `sharedDir`
- search from one side with `query <name>`
- view results with `results`
- fetch one with `download <resultNo>`

That is the core loop this project is built around.
