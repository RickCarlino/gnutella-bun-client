# Gnutella Bun Experiments

This repository contains a variety tools related to Gnutella 0.6. It is the result of a Gnutella deep-dive I did for fun in 2025.

- [A minimal GWebCache Server - Run via `bun cache-server.ts`](cache-server.ts)
- [An interface for calling GWebCache servers like the one above](cache-client.ts) - run `bun cache-client.ts` to get peer IPs.
- [Outbound Gnutella connection handler](gnutella-connection.ts)
- [Parser of varaious Gnutella messages](parser.ts)

## Notes

It is pretty much impossible to peer with Gnutella peers in 2025 if you do not have the "Query Routing Protocol" and "Compressed Connections".

I am not sure if I will implement these or not since it appears to be hard to find a spec.

Although this is mostly complete, I don't think it is usable as a real gnutella client without these additions.

## TODO

- Inbound connection handler.
- auto bootstrapping and caching of peers so that I don't need to copy/paste peers into `FIND_PEERS_USING_WEB_CACHES`.
- QRP (maybe)
- Compressed connections (maybe)

## Running the Gnutella Client

1. Use the cache client to find initial peers.
2. Update the value of the IP address in list in client.ts
3. Run `bun client.ts`

## Resources

- [Gnutella spec](./docs/Gnutella-0.6-spec.txt)
- [WebCache Spec](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
- [WebCache Spec, by DeepResearchTM](./docs/gwebcache-spec.md)
- Gnutella example clients I found while researching this: [1](https://github.com/comick/mini-gnutella), [2](https://github.com/advait/crepe), [3](https://github.com/thapam/gnutella-client)
