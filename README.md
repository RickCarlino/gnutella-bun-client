# Gnutella Client for Bun Runtime

A TypeScript implementation of the Gnutella 0.6 P2P protocol using the Bun runtime. This project provides a Gnutella leaf node supporting compression, query routing protocol and other modern features (goal: full GTK-Gnutella interop).

## Remaining Work

- [x] CONNECT
- [x] PING / PONG
- [x] QUERY / QUERY HIT
- [x] GZip Compression
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

- **[main.ts](main.ts)** - Entry point that starts a GnutellaNode
- **[src/gnutella_node.ts](src/gnutella_node.ts)** - Main Gnutella node implementation
- **[src/gnutella_server.ts](src/gnutella_server.ts)** - Server for accepting incoming connections
- **[src/socket_handler.ts](src/socket_handler.ts)** - Handles individual socket connections
- **[src/message_router.ts](src/message_router.ts)** - Routes messages between connections
- **[src/peer_store.ts](src/peer_store.ts)** - Manages persistent peer storage

### Protocol Implementation

- **[src/message_parser.ts](src/message_parser.ts)** - Parses Gnutella protocol messages
- **[src/message_builder.ts](src/message_builder.ts)** - Constructs Gnutella protocol messages
- **[src/qrp_manager.ts](src/qrp_manager.ts)** - Query Routing Protocol implementation
- **[src/constants.ts](src/constants.ts)** - Protocol constants and configuration
- **[src/core_types.ts](src/core_types.ts)** - TypeScript type definitions

### Utilities

- **[src/binary.ts](src/binary.ts)** - Binary data handling utilities
- **[src/hash.ts](src/hash.ts)** - Hashing utilities for QRP
- **[src/id_generator.ts](src/id_generator.ts)** - Generates unique message IDs

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
- **Querying only, No file sharing (yet!)** - Will serve the contents of `gnutella-library/` but does not yet offer downloads to peers.
- **No outbound connections** - Currently only accepts incoming connections
- **No automatic bootstrapping** - Relies on existing peer list

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
