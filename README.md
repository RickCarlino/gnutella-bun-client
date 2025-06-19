# Gnutella Bun Experiments

This repository contains a variety of tools related to [Gnutella 0.6](https://en.wikipedia.org/wiki/Gnutella). It is the result of a Gnutella deep-dive I did for fun in 2025.

- [A minimal GWebCache Server - Run via `bun cache-server.ts`](cache-server.ts)
- [A minimal Gnutella node implementation](main.ts) - run `bun main.ts` to start a full Gnutella node
- [An interface for calling GWebCache servers with persistent data storage](cache-client.ts)
- [Parser of various Gnutella messages](parser.ts)

## Notes

**Most Important:** It does not actually share files! My main interest is learning the protocol and becoming a network participant (bootstrap peers, reply to PING/QUERY messages, etc..). I don't have any actual interest in doing file sharing.

It is pretty much impossible to peer with Gnutella users in 2025 without a client that supports "Query Routing Protocol" and "Compressed Connections".

**If you just want to try it out:** Run GTK-Gnutella locally, uncheck compressed connections, enable LAN connections, run `bun main.ts` and manually add `127.0.0.1::6346`

I am not sure if I will implement these.

Although this is mostly complete, I don't think it is usable as a real gnutella client without these additions.

## TODO

- Update internal host file when we get `X-Try-*` responses.
- Maintain minimum number of peers
- QRP
- Compressed connections

## Running the Gnutella Node

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

## Running Individual Components

### GWebCache Server

Optional. You can host a GWebCache to help clients bootstrap. I don't know if its any good.

```bash
bun cache-server.ts
```

### Manual Gnutella Client (for testing outbound connections)

```bash
bun client.ts
```

## Resources

- [Gnutella spec](./docs/Gnutella-0.6-spec.txt)
- [WebCache Spec](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
- [WebCache Spec, by DeepResearchTM](./docs/gwebcache-spec.md)
- Gnutella example clients I found while researching this: [1](https://github.com/comick/mini-gnutella), [2](https://github.com/advait/crepe), [3](https://github.com/thapam/gnutella-client)
