# Gnutella Client for Bun Runtime

A TypeScript implementation of the Gnutella 0.6 P2P protocol using the Bun runtime. This project provides a Gnutella leaf node supporting deflate compression, Query Routing Protocol (QRP), and other modern features (goal: full GTK-Gnutella interop).

## Remaining Work

- [x] CONNECT
- [x] PING / PONG
- [x] QUERY / QUERY HIT
- [x] Deflate Compression
- [ ] Automatic GWebCache bootstrapping
- [ ] (in progress) HTTP Server for file downloads
- [ ] User interface
- [ ] UDP Support

## Requirements

- [Bun](https://bun.sh/docs/installation) runtime

## Quick Start

Start a Gnutella node that automatically discovers peers and listens for connections:

```bash
bun main.ts
```

This will:

- Start a Gnutella leaf node on port 6346
- Automatically discover peers from stored peer list
- Accept incoming Gnutella connections
- Implement Query Routing Protocol (QRP) for efficient query routing

## Project Structure

### Core Components

- **[main.ts](main.ts)** - Entry point that starts a `GnutellaNode` and HTTP server
- **[src/gnutella-node.ts](src/gnutella-node.ts)** - Main Gnutella node (parsing, routing, QRP, bye/compression negotiation, push handling)
- **[src/http.tsx](src/http.tsx)** - Hono routes for UI and file serving

### Protocol Implementation & Utilities

- **[src/binary.ts](src/binary.ts)** - Binary helpers (endian, IP encode/decode, base32)
- **[src/Hash.ts](src/Hash.ts)** - Hashing utilities (e.g., SHA1 URN)
- **[src/IDGenerator.ts](src/IDGenerator.ts)** - 16-byte message/servent IDs
- **[src/const.ts](src/const.ts)** - Protocol constants and configuration

### GWebCache Server

Optional component for hosting your own peer discovery server:

```bash
bun cache-server.ts
```

Learn more about GWebCache in [these docs](./docs/gwebcache-spec.md).

## Testing

Run all tests:

```bash
bun test
```

Run specific test file:

```bash
bun test src/message_parser.test.ts
```

## Configuration

- **settings.json** - Stores peer and cache data with timestamps

## Limitations

- **Leaf node only** - No ultrapeer capabilities
- **Querying only, limited file serving** - Serves files from `gnutella-library/`; HTTP range/URN endpoints are basic.
- **Bootstrap work in progress** - Uses configured peers/caches in `settings.json`/`const.ts`.

## Protocol Specifications

The `/docs` directory contains the protocol specifications this implementation follows:

- [Gnutella 0.6 Specification](docs/Gnutella-0.6-spec.txt)
- [GWebCache Specification](docs/gwebcache-spec.md)
- [Query Routing Protocol Specification](docs/qrp-pseudospec.md)
- [Compression Specification](docs/compression-pseudospec.md)

## Development

### Architecture Notes

The implementation uses a class-based architecture with:

- `GnutellaNode` as the main coordinator
- `GnutellaServer` handling incoming connections
- `SocketHandler` managing individual peer connections
- `MessageRouter` for message distribution
- `QRPManager` for query routing optimization

## Resources

- [Gnutella Protocol on Wikipedia](https://en.wikipedia.org/wiki/Gnutella)
- [GTK-Gnutella](https://gtk-gnutella.sourceforge.io/) - Reference implementation for testing
- [Shareaza GWebCache Specs](https://shareaza.sourceforge.net/mediawiki/GWC_specs)
