# Quickstart

This guide gets you from zero to a working CLI session with sharing, searching, browsing, and downloading.

## 1. Get The CLI

You can either:

- download a prebuilt binary from the [releases page](https://github.com/RickCarlino/gnutella-bun-client/releases)
- run from source with Bun

If you are running from source:

```bash
bun install
```

Throughout this guide, commands use:

```bash
bun run bin/gnutella.ts
```

If you are using a compiled binary, replace that prefix with the executable path.

## 2. Create A Config

```bash
bun run bin/gnutella.ts init --config gnutella.json
```

This creates a config file and a downloads folder.

By default, GBun shares files from `./downloads` and also saves downloaded files there.

## 3. Put Files In Your Share Folder

Copy any files you want to share into `./downloads`.

If you changed `config.data_dir`, use `<data_dir>/downloads` instead.

## 4. Start The Client

```bash
bun run bin/gnutella.ts run --config gnutella.json
```

GBun will try to bootstrap on its own. If you already know a peer and want to connect to it directly, you can still use `connect <host:port>` after startup.

Useful first commands:

```text
status
peers
shares
```

## 5. Search For Files

```text
query hello world
results
info 1
```

`results` gives you numbered hits.

`info 1` shows the details for result `1`.

If you want a magnet link for a result:

```text
magnet 1
```

## 6. Browse A Host

If a peer looks interesting, you can browse its whole shared library.

First list your connected peers:

```text
peers
```

Then browse by peer key:

```text
browse p1
```

You can also browse directly by address:

```text
browse 203.0.113.10:6346
```

## 7. Download A Result

Download to the default folder:

```text
download 1
```

Or pick an explicit destination:

```text
download 1 ./my-copy.bin
```

If the destination file already exists, GBun resumes from the current file size when possible.

## 8. Save And Quit

```text
save
quit
```

`save` writes the current config and remembered peers to disk right away.

## If Something Looks Empty

- No peers yet: give bootstrap a little time, or run `connect <host:port>` if you already know a live peer.
- No results yet: wait a few seconds after connecting, then try another query.
- Want the full command list and config reference: read [CLI.md](CLI.md).
