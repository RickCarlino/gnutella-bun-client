# CLI Guide

This guide covers the full terminal interface: setup, configuration, commands, and common workflows.

## Running Gnutonium

You can use either:

- a prebuilt binary from the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases)
- the source checkout with Bun

If you are running from source:

```bash
bun install
```

Throughout this guide, commands use the CLI command:

```bash
gnutonium
```

If you are running from source, replace `gnutonium` with:

```bash
bun run bin/gnutonium.ts
```

If you are using a compiled binary, replace `gnutonium` with the executable path.

## Create A Config

```bash
gnutonium init --config gnutella.json
```

That creates a default config if it does not already exist.

Start the client with:

```bash
gnutonium run --config gnutella.json
```

## Config File Reference

Gnutonium keeps both settings and remembered state in the same JSON file.

### Main Settings

| Setting                               | What it is for                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.data_dir`                     | Root folder for Gnutonium runtime data. Completed downloads default to `<data_dir>/downloads` and partial downloads default to `<data_dir>/incomplete`. |
| `config.listen_ip`                    | Local IPv4 address to bind to. Leave `0.0.0.0` unless you need something more specific.                                                                   |
| `config.listen_port`                  | Local TCP port Gnutonium listens on.                                                                                                                    |
| `config.advertised_ip`                | External IPv4 address other peers should use to reach you. Useful when your local bind address is not the address seen on the internet.                   |
| `config.advertised_port`              | External TCP port other peers should use to reach you.                                                                                                    |
| `config.blocked_ips`                  | IPv4 addresses to refuse, forget, and stop dialing.                                                                                                       |
| `config.gwebcache_urls`               | Optional custom Gnutella Web Cache list. When set, it replaces the built-in list. This is mainly useful for local development or controlled environments. |
| `config.ultrapeer`                    | Set `true` if you want Gnutonium to behave like a larger relay-style node. Leave `false` for a lighter client.                                          |
| `config.max_ultrapeer_connections`    | Cap for ultrapeer-to-ultrapeer links.                                                                                                                     |
| `config.max_leaf_connections`         | Cap for leaf links.                                                                                                                                       |
| `config.max_ttl`                      | Maximum descriptor TTL to advertise and relay. Defaults to `4`.                                                                                           |
| `config.log_ignore`                   | Event categories to hide when `monitor` is enabled.                                                                                                       |
| `config.downloads_dir`                | Final destination for completed downloads. Relative paths are resolved under `data_dir`. Defaults to `<data_dir>/downloads`.                              |
| `config.incomplete_downloads_dir`     | Workspace for partial downloads. Relative paths are resolved under `data_dir`. Defaults to `<data_dir>/incomplete`.                                       |
| `config.download_queue_size`          | Maximum active downloads. Defaults to `6`.                                                                                                                |
| `config.download_max_active_per_host` | Maximum active downloads from one remote host. Defaults to `2`.                                                                                           |
| `config.download_retry_limit`         | Maximum consecutive attempts without saved progress per source before a job fails. Defaults to `10`. New saved bytes reset this counter.                                                                                         |
| `config.download_retry_backoff_sec`   | Delay before retrying a failed source. Defaults to `60`.                                                                                                  |
| `config.download_idle_timeout_ms` | Maximum idle time while receiving a download body, in milliseconds. Defaults to `60000`. Connection and HTTP-header timeouts remain 15 seconds. |
| `config.verify_downloads`             | Verify completed downloads against SHA1 URNs when available. Defaults to `true`.                                                                          |

### Saved State

| Setting                | What it is for                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `state.peers`          | Optional peers Gnutonium will try on startup. Gnutonium can also bootstrap on its own. |
| `state.servent_id_hex` | Gnutonium's node identity. In normal use, leave it alone.                                |

## Where Files Go

Gnutonium uses `<data_dir>/downloads` for two things by default:

- files you want to share
- completed downloads

Partial downloads live under `<data_dir>/incomplete` by default and are resumed across restarts. Completed downloads with SHA1 URNs are verified before they are moved into the downloads folder.

## Command Reference

### Session And Visibility

| Command         | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `help`          | Shows the available commands.                           |
| `status`        | Shows peer, share, result, and known-peer counts.       |
| `monitor [on\|off\|all\|downloads]` | Toggles live logging or selects a mode.                             |
| `clear`         | Clears the current search result list.                  |
| `save`          | Writes the current config and remembered state to disk. |
| `sleep`         | Pauses scripted command sequences.                      |
| `quit` / `exit` | Stops the node cleanly.                                 |

### Peers And Network

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `peers`             | Lists connected peers and their keys such as `p1`.  |
| `connect <ip:port>` | Connects to a peer and remembers it for later runs. |
| `ping [ttl]`        | Sends a network ping.                               |
| `blocked`           | Lists blocked IPv4 addresses.                       |
| `block <ipv4>`      | Blocks an IPv4 address and drops matching peers.    |
| `unblock <ipv4>`    | Removes an IPv4 address from the block list.        |

### Searching And Browsing

| Command                     | What it does                                                                     |
| --------------------------- | -------------------------------------------------------------------------------- |
| `query <search terms...>`   | Searches the network.                                                            |
| `results`                   | Shows the current result list.                                                   |
| `info <resultNo\|jobId>`           | Shows details for a search result or download job, e.g. `info 740` or `info d5`.                                       |
| `magnet <resultNo>`         | Prints a magnet link for one result.                                             |
| `browse <peerKey\|ip:port>` | Loads a peer's full shared library by connected peer key or direct IPv4 address. |

### Sharing And Downloads

| Command                          | What it does                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `shares`                         | Lists the files you are sharing.                                                                                                         |
| `rescan`                         | Rebuilds the local share index.                                                                                                          |
| `download <resultNo> [destPath]` | Creates or updates a background download job for one result. If `destPath` is omitted, Gnutonium picks a path in the downloads folder. |
| `downloads`                      | Lists persisted download jobs and current progress.                                                                                      |
| `pause <jobId>`                  | Stops a queued or active download while keeping partial data.                                                                            |
| `resume <jobId>`                 | Requeues a paused or failed download.                                                                                                    |
| `remove <jobId>`                 | Removes a download job and deletes its incomplete file. Completed files are left alone.                                                  |

`clear` only clears search results and resets result numbering to 1. Active and queued downloads retain their source details and keep running. Use `info d5` to inspect a download after clearing results; its original result number is historical and may be reused by a new search.

Download details include progress, file paths, timestamps, the active source, total source attempts, consecutive attempts without progress, and errors. A transfer that saves new bytes can retry beyond the total attempt count; `resume` resets the no-progress counter while retaining the total attempt history.

## Common Tasks

### Search Then Download

```text
query jazz piano
results
info 1
download 1
downloads
```

### Browse The Host Behind A Result

If a result came from `198.51.100.25:6346`, you can browse that host directly:

```text
browse 198.51.100.25:6346
```

If the peer is already connected, you can also browse by key:

```text
peers
browse p1
```

### Remember A Useful Peer

```text
connect 203.0.113.10:6346
save
```

That peer is then kept in `state.peers` for the next run.

### Quiet A Noisy Session

Turn live logging on or off:

```text
monitor
```

```text
monitor downloads
```

This shows download lifecycle events, transfer failures, and download-manager errors while hiding peer traffic and handshake warnings. Commands such as `peers`, `downloads`, and `info d5` still print their requested output.

Use `monitor off` to silence live logs or `monitor all` (also `monitor on`) to restore general monitoring. Bare `monitor` toggles logging off or back to general monitoring. Mode selection lasts for the current session and also works with `--exec 'monitor downloads'`.

`config.log_ignore` still applies to enabled categories in both modes.

## Scripted Usage

You can queue CLI commands with repeated `--exec` flags.

```bash
gnutonium run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for smoke tests, local demos, and small automation tasks.

## Next Step

If you want the shortest path to a working session, go back to [QUICKSTART.md](QUICKSTART.md).

If you want to control Gnutonium from code instead of the terminal, read [DEVELOPER.md](DEVELOPER.md).
