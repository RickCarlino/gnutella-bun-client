# Gnutella Bun Experiments

This repository contains a variety of tools related to [Gnutella 0.6](https://en.wikipedia.org/wiki/Gnutella). It is the result of a Gnutella deep-dive I did for fun in 2025.

## Components

- **[Gnutella Leaf Node](main.ts)** - Run `bun main.ts` to start a complete Gnutella node with automatic peer discovery and connection management
- **[GWebCache Server](src/cache-server.ts)** - Run `bun src/cache-server.ts` to host a GWebCache for peer discovery. This is complete, but you should probably just use the GWebCache servers in `KNOWN_CACHE_LIST`.
- **[Local Cache Client](src/cache-client.ts)** - Store peer IPs to disk. Fetch peers from PONG messages, `X-Try-*` headers and GWebCache. Built-in re-fetch throttling.
- **[Connection Manager](src/connection-manager.ts)** - (rarely works due to QRP/Compression issues noted below) Automatic outbound connection management with configurable targets.
- **[Message Parser](src/parser.ts)** - Parser and builder for Gnutella protocol messages

## Running the Gnutella Node

You will need to [install Bun](https://bun.sh/docs/installation) before proceeding. Bun supports single-file executables, so I could probably provide binary releases if people asked (raise an issue).

To start a full Gnutella node that automatically bootstraps peers, accepts connections, and maintains cache updates:

```bash
bun main.ts
```

This will:

- Automatically discover and store peers from GWebCaches
- Start a server listening on port 6346
- Push your IP to all known GWebCaches
- Accept incoming Gnutella connections
- Periodically update caches and discover new peers

## Peering Only

**Most Important:** It does not actually share files! My main interest is learning the protocol and becoming a network participant (bootstrap peers, reply to PING/QUERY messages, etc..). I don't have any actual interest in doing file sharing, so there's that. PRs welcome, though.

## A Note About Protocol Extensions

It is nearly impossible to connect to a Gnutella peer in 2025 without a client that supports "Query Routing Protocol" and "Compressed Connections". If you run GTK-Gnutella locally, you can turn compression off (on by default) and peer with `localhost` for testing. Enable LAN connections, run `bun main.ts` and manually add `127.0.0.1:6346`

Although this is mostly complete, I don't think it is usable as a real gnutella client without these additions since it will be difficult to find peers without these extensions.

## TODO

- Connection manager (outbound connection handler) rarely works, probably due to lack of QRP and compression.
- QRP (Query Routing Protocol)
- Compressed connections (Not implementing at this time)

### GWebCache Server

Optional. You can host a GWebCache to help clients bootstrap. I don't know if its any good.

```bash
bun cache-server.ts
```

## Resources

- [Gnutella spec](./docs/Gnutella-0.6-spec.txt)
- [WebCache Spec](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
- [WebCache Pseudopec, by DeepResearchTM](./docs/gwebcache-spec.md)
- [QRP Pseudospec, by DeepResearchTM](./docs/qrp-pseudospec.md)
- Gnutella example clients I found while researching this: [1](https://github.com/comick/mini-gnutella), [2](https://github.com/advait/crepe), [3](https://github.com/thapam/gnutella-client). The clients I tried, like my client, struggle to connect to real world Gnutella nodes due to missing QRP and compression.
