# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Gnutella 0.6 P2P protocol implementation in TypeScript using the Bun runtime. The project implements both client and server functionality for the Gnutella network, along with a GWebCache server and client for peer discovery.

## Commands

### Running Components

- `bun cache-server.ts` - Run the GWebCache server (for peer discovery)
- `bun main.ts` - Run Gnutella client (connects to other peers)

### Testing

- `bun test` - Run all tests (uses Bun's built-in test framework)
- `bun test cache-server.test.ts` - Run specific test file

### Development

There are no lint or typecheck commands configured. TypeScript is set to noEmit mode, with Bun handling execution directly.

## Architecture

### Core Protocol Implementation

- **gnutella-connection.ts**: Handles the Gnutella protocol handshake and message exchange
- **parser.ts**: Parses various Gnutella protocol messages (PING, PONG, QUERY, etc.)
- **client.ts**: Outbound connection client - connects to other Gnutella nodes
- **server.ts**: Inbound connection server - accepts connections from other nodes

### Peer Discovery

- **cache-server.ts**: GWebCache server implementation (tested)
- **cache-client.ts**: GWebCache client for discovering initial peers
- **settings.json**: Stores peer information persistently

### Protocol Specifications

The `/docs` directory contains the Gnutella protocol specifications that this implementation follows:

- Gnutella 0.6 is the primary target (docs/Gnutella-0.6-spec.txt)
- GWebCache protocol for peer discovery (docs/gwebcache-spec.md)

## Development Guidelines

### Code Style Requirements

- **NO else if statements** - Use switch statements instead
- Use Unix timestamps for all time tracking
- TypeScript strict mode is enabled
- Prefer non-dynamic imports.

### Testing Approach

- Tests use Bun's built-in test framework with describe/test/expect syntax
- Test files are named `*.test.ts`
- See cache-server.test.ts for testing patterns

## Known Limitations

The implementation is not yet suitable for real-world Gnutella usage. Missing features include:

- Automatic bootstrapping and peer caching

For local testing with GTK-Gnutella:

1. Disable compressed connections in GTK-Gnutella
2. Enable LAN connections
3. Run `bun server.ts`
4. Manually add `127.0.0.1::6346` in GTK-Gnutella
