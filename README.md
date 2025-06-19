# Gnutella Bun Experiments

This repository contains a variety tools related to Gnutella 0.6. It is the result of a Gnutella deep-dive I did for fun in 2025.

- [./cache-server.ts](A minimal GWebCache Server) - Run via `bun cache-server.ts`
- [./cache-client.ts](An interface for calling GWebCache servers)
- [./gnutella-connection.ts](Outbound connection handler)
- [./parser.ts](Parser of varaious Gnutella messages)

## Running the Gnutella Client

1. Use the cache client to find initial peers.
2. Update the value of the IP address list in client.ts
3. Run `bun client.ts`

## Resources

- [Gnutella spec](./docs/Gnutella-0.6-spec.txt)
- [WebCache Spec](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
- [WebCache Spec, by DeepResearchTM](./docs/gwebcache-spec.md)
- Gnutella example clients I found while researching this: [1](https://github.com/comick/mini-gnutella), [2](https://github.com/advait/crepe), [3](https://github.com/thapam/gnutella-client)
