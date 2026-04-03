# CLI Guide

This guide covers the full terminal interface: setup, configuration, commands, and common workflows.

## Running GBun

You can use either:

- a prebuilt binary from the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases)
- the source checkout with Bun

If you are running from source:

```bash
bun install
```

Throughout this guide, commands use:

```bash
bun run bin/gnutella.ts
```

If you are using a compiled binary, replace that prefix with the executable path.

## Create A Config

```bash
bun run bin/gnutella.ts init --config gnutella.json
```

That creates a default config if it does not already exist.

Start the client with:

```bash
bun run bin/gnutella.ts run --config gnutella.json
```

## Config File Reference

GBun keeps both settings and remembered state in the same JSON file.

### Main Settings

| Setting                            | What it is for                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.data_dir`                  | Root folder for GBun data. Shared files and downloaded files both live under `<data_dir>/downloads`.                                                      |
| `config.listen_host`               | Local IPv4 address to bind to. Leave `0.0.0.0` unless you need something more specific.                                                                   |
| `config.listen_port`               | Local TCP port GBun listens on.                                                                                                                           |
| `config.advertised_host`           | External IPv4 address other peers should use to reach you. Useful when your local bind address is not the address seen on the internet.                   |
| `config.advertised_port`           | External TCP port other peers should use to reach you.                                                                                                    |
| `config.blocked_ips`               | IPv4 addresses to refuse, forget, and stop dialing.                                                                                                       |
| `config.gwebcache_urls`            | Optional custom Gnutella Web Cache list. When set, it replaces the built-in list. This is mainly useful for local development or controlled environments. |
| `config.ultrapeer`                 | Set `true` if you want GBun to behave like a larger relay-style node. Leave `false` for a lighter client.                                                 |
| `config.max_connections`           | Overall peer connection cap.                                                                                                                              |
| `config.max_ultrapeer_connections` | Cap for ultrapeer-to-ultrapeer links.                                                                                                                     |
| `config.max_leaf_connections`      | Cap for leaf links.                                                                                                                                       |
| `config.log_ignore`                | Event categories to hide when `monitor` is enabled.                                                                                                       |
| `config.rtc`                       | Enables the experimental WebRTC download path.                                                                                                            |
| `config.rtc_rendezvous_urls`       | Rendezvous server URLs for RTC.                                                                                                                           |
| `config.rtc_stun_servers`          | STUN servers for RTC.                                                                                                                                     |

### Saved State

| Setting                | What it is for                                                               |
| ---------------------- | ---------------------------------------------------------------------------- |
| `state.peers`          | Optional peers GBun will try on startup. GBun can also bootstrap on its own. |
| `state.servent_id_hex` | GBun's node identity. In normal use, leave it alone.                         |

## Where Files Go

GBun uses `<data_dir>/downloads` for two things:

- files you want to share
- files you download

With the default config, that folder is `./downloads`.

## Command Reference

### Session And Visibility

| Command         | What it does                                            |
| --------------- | ------------------------------------------------------- |
| `help`          | Shows the available commands.                           |
| `status`        | Shows peer, share, result, and known-peer counts.       |
| `monitor`       | Toggles noisy live logging.                             |
| `clear`         | Clears the current search result list.                  |
| `save`          | Writes the current config and remembered state to disk. |
| `sleep`         | Pauses scripted command sequences.                      |
| `quit` / `exit` | Stops the node cleanly.                                 |

### Peers And Network

| Command               | What it does                                        |
| --------------------- | --------------------------------------------------- |
| `peers`               | Lists connected peers and their keys such as `p1`.  |
| `connect <host:port>` | Connects to a peer and remembers it for later runs. |
| `ping [ttl]`          | Sends a network ping.                               |
| `blocked`             | Lists blocked IPv4 addresses.                       |
| `block <ipv4>`        | Blocks an IPv4 address and drops matching peers.    |
| `unblock <ipv4>`      | Removes an IPv4 address from the block list.        |

### Searching And Browsing

| Command                       | What it does                                                                |
| ----------------------------- | --------------------------------------------------------------------------- |
| `query <search terms...>`     | Searches the network.                                                       |
| `results`                     | Shows the current result list.                                              |
| `info <resultNo>`             | Shows detailed information for one result.                                  |
| `magnet <resultNo>`           | Prints a magnet link for one result.                                        |
| `browse <peerKey\|host:port>` | Loads a peer's full shared library by connected peer key or direct address. |

### Sharing And Downloads

| Command                          | What it does                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `shares`                         | Lists the files you are sharing.                                                           |
| `rescan`                         | Rebuilds the local share index.                                                            |
| `download <resultNo> [destPath]` | Downloads one result. If `destPath` is omitted, GBun picks a path in the downloads folder. |

## Common Tasks

### Search Then Download

```text
query jazz piano
results
info 1
download 1
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

If you like `monitor` but want less noise, add event names to `config.log_ignore`.

## Scripted Usage

You can queue CLI commands with repeated `--exec` flags.

```bash
bun run bin/gnutella.ts run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for smoke tests, local demos, and small automation tasks.

## Standalone RTC Relay

If you only want the RTC rendezvous service, run:

```bash
bun run bin/rtc_relay.ts --host 0.0.0.0 --port 6346
```

That process serves the rendezvous endpoints and a Gnutella Web Cache, but it is not a full search and download client on its own.

## Next Step

If you want the shortest path to a working session, go back to [QUICKSTART.md](QUICKSTART.md).

If you want to control GBun from code instead of the terminal, read [DEVELOPER.md](DEVELOPER.md).
