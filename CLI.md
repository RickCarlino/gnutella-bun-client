# CLI Guide

This is the full guide to Gnutonium in the terminal.

If you just want to get connected and run your first search, start with [QUICKSTART.md](QUICKSTART.md).

## Running Gnutonium

You can run Gnutonium either as a prebuilt binary or directly from the source checkout.

Prebuilt binaries are available on the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases).

If you're running from source, install the dependencies first:

```bash
bun install
```

The examples in this guide use:

```bash
gnutonium
```

If you're running from source, use this instead:

```bash
bun run bin/gnutonium.ts
```

If you're using a compiled binary somewhere else on your system, substitute its path as needed.

## First-Time Setup

Create a config file:

```bash
gnutonium init --config gnutella.json
```

This creates a default config unless the file already exists.

Then start Gnutonium:

```bash
gnutonium run --config gnutella.json
```

Once it's running, you'll be dropped into the interactive CLI.

Try:

```text
status
peers
query jazz piano
```

## Configuration

Gnutonium stores both your settings and a small amount of remembered network state in the same JSON file.

Most people won't need to change much beyond the data directory and networking settings.

### Main Settings

| Setting | What it does |
| --- | --- |
| `config.data_dir` | Root directory for Gnutonium's files. Downloads go under `<data_dir>/downloads` and partial downloads under `<data_dir>/incomplete` by default. |
| `config.listen_ip` | Local IPv4 address to listen on. `0.0.0.0` is usually what you want. |
| `config.listen_port` | Local TCP port Gnutonium listens on. |
| `config.advertised_ip` | Public IPv4 address other peers should use to reach you. Useful when your public address differs from your local bind address. |
| `config.advertised_port` | Public TCP port other peers should use to reach you. |
| `config.blocked_ips` | IPv4 addresses Gnutonium should refuse, forget, and stop dialing. |
| `config.gwebcache_urls` | Overrides the built-in Gnutella Web Cache list. Mostly useful for development or private networks. |
| `config.ultrapeer` | Set to `true` to run as an ultrapeer. Leave it `false` for a normal lightweight client. |
| `config.max_ultrapeer_connections` | Maximum number of ultrapeer-to-ultrapeer connections. |
| `config.max_leaf_connections` | Maximum number of leaf connections. |
| `config.max_ttl` | Maximum descriptor TTL Gnutonium will advertise or relay. Defaults to `4`. |
| `config.log_ignore` | Event categories to hide while monitoring is enabled. |
| `config.downloads_dir` | Where completed downloads are stored. Relative paths are resolved under `data_dir`. |
| `config.incomplete_downloads_dir` | Where partial downloads are kept. Relative paths are resolved under `data_dir`. |
| `config.download_queue_size` | Maximum number of active downloads. Defaults to `6`. |
| `config.download_max_active_per_host` | Maximum simultaneous downloads from one remote host. Defaults to `2`. |
| `config.download_retry_limit` | Number of consecutive attempts a source gets without making progress before the job fails. Defaults to `10`. Saving new bytes resets the counter. |
| `config.download_retry_backoff_sec` | How long to wait before retrying a failed source. Defaults to `60` seconds. |
| `config.download_idle_timeout_ms` | Maximum time a download body can stop making progress before timing out. Defaults to `60000` ms. Connection and HTTP-header timeouts stay at 15 seconds. |
| `config.verify_downloads` | Verifies completed files against their SHA1 URN when one is available. Defaults to `true`. |

### Remembered State

Gnutonium also keeps a little state between runs:

| Setting | What it does |
| --- | --- |
| `state.peers` | Peers Gnutonium can try again the next time it starts. You don't need to populate this manually; Gnutonium can bootstrap on its own. |
| `state.servent_id_hex` | Your node's persistent Gnutella identity. Normally, don't touch it. |

## Shared Files and Downloads

By default, Gnutonium uses:

```text
<data_dir>/downloads
```

for both:

- files you want to share
- downloads that have completed

Partial downloads are kept in:

```text
<data_dir>/incomplete
```

Gnutonium keeps partial files across restarts, so interrupted downloads can resume later.

When a download has a SHA1 URN, Gnutonium verifies the completed file before moving it into the downloads directory.

## Commands

### Basic Commands

| Command | What it does |
| --- | --- |
| `help` | Shows the available commands. |
| `status` | Shows a quick summary of peers, shared files, search results, and known peers. |
| `monitor [on\|off\|all\|downloads]` | Controls live logging. |
| `clear [query]` | Clears all searches, or one search such as `clear q2`. |
| `save` | Writes the current configuration and remembered state to disk. |
| `sleep` | Pauses a scripted command sequence. |
| `quit` / `exit` | Shuts Gnutonium down cleanly. |

### Peers and Networking

| Command | What it does |
| --- | --- |
| `peers` | Lists your current connections. Connected peers get short names such as `p1`. |
| `connect <ip:port>` | Connects to a peer and remembers it for future runs. |
| `ping [ttl]` | Sends a Gnutella ping. |
| `blocked` | Shows blocked IPv4 addresses. |
| `block <ipv4>` | Blocks an IPv4 address and disconnects matching peers. |
| `unblock <ipv4>` | Removes an address from the block list. |

### Searching

Start a search with:

```text
query jazz piano
```

Useful search commands:

| Command | What it does |
| --- | --- |
| `query <search terms...>` | Starts a search. |
| `queries` | Lists search handles, result counts, and search terms. |
| `results [query]` | Shows results for every search, or one search such as `results q2`. |
| `info <resultNo\|jobId>` | Shows more information about a search result or download job. |
| `magnet <resultNo>` | Prints a magnet link for a search result. |
| `browse <peerKey\|ip:port>` | Requests a peer's full shared-file list. |

Each search gets an ID such as `q1`, `q2`, and so on.

Search results also get numbers. Those numbers are what you pass to commands like `info`, `magnet`, and `download`.

### Sharing and Downloads

| Command | What it does |
| --- | --- |
| `shares` | Shows the files you're currently sharing. |
| `rescan` | Rescans the share directory and rebuilds the local share index. |
| `download <resultNo> [destPath]` | Starts or updates a background download job. If no destination is given, Gnutonium chooses a path in the downloads directory. |
| `downloads` | Shows your download jobs and their current progress. |
| `pause <jobId>` | Pauses a queued or active download without deleting the partial file. |
| `resume <jobId>` | Requeues a paused or failed download. |
| `remove <jobId>` | Removes a download job and deletes its incomplete file. Completed files are left alone. |

Searches and downloads are separate.

If you run:

```text
clear
```

your search results disappear, but active and queued downloads keep running.

Use:

```text
downloads
```

to see download progress, or:

```text
info d5
```

to inspect a particular job.

## Common Workflows

### Search for Something and Download It

A typical session looks like this:

```text
query jazz piano
results
info 1
download 1
downloads
```

`query` starts the search.

`results` shows what came back.

`info 1` lets you inspect result 1 before downloading it.

`download 1` creates a background download job.

`downloads` shows its progress.

### Run Several Searches at Once

You don't have to wait for one search to finish before starting another:

```text
query jazz piano
query ambient techno
```

Then:

```text
queries
```

might show searches such as `q1` and `q2`.

To inspect just one of them:

```text
results q1
```

Then download any result using its result number:

```text
info 1
download 1
```

When you're done with a search:

```text
clear q1
```

Or clear everything:

```text
clear
```

Clearing a search does not cancel downloads that were started from it.

### Browse Everything a Host Is Sharing

Search results tell you which host returned them.

If a result came from:

```text
198.51.100.25:6346
```

you can ask that host for its complete shared library:

```text
browse 198.51.100.25:6346
```

If you're already connected to the host, you can use its short peer ID instead:

```text
peers
browse p1
```

### Remember a Peer

If you know a peer you want Gnutonium to reconnect to later:

```text
connect 203.0.113.10:6346
save
```

The address will be stored in `state.peers` and tried again on future runs.

You normally don't need to maintain a peer list yourself; Gnutonium can discover peers through the normal Gnutella bootstrap process.

### Watch Download Activity Without All the Noise

For general live logs:

```text
monitor on
```

or:

```text
monitor all
```

To focus specifically on downloads:

```text
monitor downloads
```

This shows things such as:

- downloads starting and finishing
- retries
- transfer failures
- download-manager errors

while hiding most peer traffic and handshake noise.

Normal commands still work:

```text
peers
downloads
info d5
```

To turn live logging off:

```text
monitor off
```

Running bare:

```text
monitor
```

toggles monitoring between off and the normal general-monitoring mode.

Your `config.log_ignore` settings still apply.

## Scripted Usage

The interactive CLI is convenient for humans, but commands can also be supplied ahead of time with repeated `--exec` flags.

For example:

```bash
gnutonium run --config gnutella.json \
  --exec 'status' \
  --exec 'query hello world' \
  --exec 'sleep 2' \
  --exec 'results' \
  --exec 'quit'
```

This is useful for smoke tests, demos, and simple automation.

Most interactive commands work through `--exec`, including commands that target individual searches:

```bash
gnutonium run --config gnutella.json \
  --exec 'query jazz piano' \
  --exec 'sleep 2' \
  --exec 'results q1' \
  --exec 'clear q1' \
  --exec 'quit'
```

## Where to Go Next

For the shortest possible path from installation to your first working Gnutella session, read [QUICKSTART.md](QUICKSTART.md).

If you want to embed or control Gnutonium from code rather than through the terminal, read [DEVELOPER.md](DEVELOPER.md).
