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
- Start a leaf node listening for inbound connections on port 6346
- Accept incoming Gnutella connections

## Limitations

- Leaf only - This node does not have ultra peer capabilities
- Sharing WIP - The client has the ability to offer files and respond to query hits (QRP support and all!) but there is no way to actually send the file to a requester yet.

## Goals

- Use Bun standard lib as much as possible. Make exceptions only for security reasons.
- Maintain reference compatibility with GTK-Gnutella v1.2.3, eg: it should aspire to maintain a featureset that is interoperable with GTK Gnutella.

## TODO

- Ability to share a directory
- Re-add outbound peering (disabled during QRP debugging)
- Push IP to all known GWebCaches
- Periodically update caches and discover new peers

### GWebCache Server

Optional. You can host a GWebCache to help clients bootstrap. I don't know if its any good.

```bash
bun cache-server.ts
```

## Resources

- [Gnutella spec](./docs/Gnutella-0.6-spec.txt)
- [WebCache Spec](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
- [GTKGnutella Network Pane Docs](https://gtk-gnutella.sourceforge.io/manual/gnutellanet.html) - My main network debugger for ensuring protocol compliance.
- [WebCache Pseudopec, by DeepResearchTM](./docs/gwebcache-spec.md)
- [QRP Pseudospec, by DeepResearchTM](./docs/qrp-pseudospec.md)
- Gnutella example clients I found while researching this: [1](https://github.com/comick/mini-gnutella), [2](https://github.com/advait/crepe), [3](https://github.com/thapam/gnutella-client). The clients I tried, like my client, struggle to connect to real world Gnutella nodes due to missing QRP and compression.
