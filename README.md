# GBun: A Gnutella Client for Bun

GBun is a compact Gnutella client you can run from the terminal or embed in a TypeScript application.

- share files from a local folder
- search the Gnutella network for files
- inspect results before downloading
- download files with resume support
- keep enough local state to be useful across restarts

You can use it in three ways:

- as an interactive CLI
- as a TypeScript library
- as a scripted runner for repeatable command sequences

The project is aimed at people who want a working Gnutella client without a large framework or a heavy UI. It is also a good fit if you want to automate searches and downloads from shell scripts or use the node as part of another app.

## Status

This is a real, functional Gnutella peer. It has been observed to interoperate with Gnutella clients like GTK Gnutella.

It also implements new protocol extensions, such as WebRTC for NAT/firewall traversal.

## CLI Usage

### Installation

If you want a prebuilt executable, download one of the release binaries:

- [Windows](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64.exe)
- [Windows (older CPUs)](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-windows-x64-baseline.exe)
- [macOS Intel](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-x64)
- [macOS Apple Silicon](https://github.com/RickCarlino/gnutella-bun-client/releases/latest/download/gnutella-bun-darwin-arm64)
- [Linux builds](https://github.com/RickCarlino/gnutella-bun-client/releases)

If you are running from source, install dependencies with:

```bash
bun install
```

Throughout this README, CLI examples use:

```bash
bun run bin/gnutella.ts
```

If you are using a compiled binary, replace that prefix with the executable path.

### Create a Config

```bash
bun run bin/gnutella.ts init --config gnutella.json
```

New configs choose a random unprivileged `listen_port` in the `20000-29999` range.

The generated file uses the same shape as [`gnutella.json.example`](gnutella.json.example).

### Core Configuration

These settings are the ones most people will care about first:

| Setting                                                                                     | Purpose                                                                                             |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `state.peers`                                                                               | Starting peers to connect to, for example `"203.0.113.10:6346": 0`                                  |
| `config.data_dir`                                                                           | Root directory for runtime data; shared and downloaded files both live under `<data_dir>/downloads` |
| `config.listen_port`                                                                        | Local TCP port to listen on                                                                         |
| `config.advertised_host` / `config.advertised_port`                                         | Only set these if other peers should reach you at a different external address or port              |
| `config.ultrapeer`                                                                          | `false` for a lighter client, `true` for a larger relay-style node                                  |
| `config.max_connections`, `config.max_ultrapeer_connections`, `config.max_leaf_connections` | Peer connection caps                                                                                |
| `config.log_ignore`                                                                         | Categories to suppress when `monitor` is enabled                                                    |
| `config.rtc`, `config.rtc_rendezvous_urls`, `config.rtc_stun_servers`                       | Only needed if you want to try the experimental RTC download path                                   |

### Start the Client

```bash
bun run bin/gnutella.ts run --config gnutella.json
```

The prompt shows:

- connected peers
- current peer cap
- recent activity
- buffered result count

### Common Commands

| Command                          | What it does                                     |
| -------------------------------- | ------------------------------------------------ |
| `help`                           | Show the available commands                      |
| `status`                         | Show peer, share, result, and known-peer counts  |
| `connect <host:port>`            | Connect to a peer and remember it for later runs |
| `peers`                          | List connected peers                             |
| `shares`                         | List shared files                                |
| `query <terms...>`               | Search the network                               |
| `browse`                         | Ask connected peers for browse-style results     |
| `results`                        | Show the current result list                     |
| `info <resultNo>`                | Show detailed information for one result         |
| `download <resultNo> [destPath]` | Download one result                              |
| `rescan`                         | Rebuild the local share index                    |
| `monitor`                        | Toggle noisy live logging                        |
| `save`                           | Write the current config and state to disk       |
| `quit` / `exit`                  | Stop the node cleanly                            |

### Typical CLI Workflow

1. Create a config and add one or more known peers to `state.peers`.
2. Put files you want to share in `<data_dir>/downloads`.
3. Start the node with `run`.
4. Use `query <terms>` to search.
5. Use `results` and `info <resultNo>` to inspect hits.
6. Use `download <resultNo>` to fetch one.
7. Use `save` before quitting if you want to persist the latest state immediately.

If the destination file already exists, GBun resumes from the current file size instead of starting from zero.

### Monitoring

`monitor` is the high-noise live trace mode for the CLI. It is meant for debugging and active observation, not normal daily use.

If it is too noisy, set `config.log_ignore` to suppress specific event categories such as `PING`, `PONG`, `QUERY_RESULT`, or `PEER_CONNECTED`.

## Library Usage

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

### Main Library Capabilities

- config helpers: `defaultDoc()`, `loadDoc()`, `writeDoc()`
- lifecycle: `start()`, `stop()`, `save()`, `refreshShares()`
- network actions: `connectToPeer()`, `sendPing()`, `sendQuery()`
- transfer actions: `downloadResult()`
- runtime inspection: `getStatus()`, `getPeers()`, `getKnownPeers()`, `getShares()`, `getResults()`, `getDownloads()`
- event subscription through the constructor or `subscribe()`

If you need lower-level helpers as part of an integration, `src/protocol.ts` also exports the request builders and codec helpers used by the CLI.

## Scripted Usage

The CLI accepts repeated `--exec` arguments. Each one is run in order after startup.

```bash
bun run bin/gnutella.ts run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for:

- smoke tests
- repeatable local demos
- multi-node localhost checks
- small automation tasks without writing a separate app

The same pattern works with a compiled binary. Replace `bun run bin/gnutella.ts` with the executable path and keep the rest of the arguments the same.

## Standalone RTC Relay

If you want to host the experimental RTC relay without running a full node, use:

```bash
bun run bin/rtc_relay.ts --host 0.0.0.0 --port 6346
```

That process only provides the relay service for RTC setup. It does not act as a normal search or download node on its own.

## Build a Binary

If you want a compiled executable instead of `bun run`, build the CLI with:

```bash
./scripts/build-all-targets.sh
```

Compiled artifacts are written to `dist/`.

## Development Checks

- `bun run verify` runs the full verification sequence
- `bun run fix` runs the safe formatting pass
