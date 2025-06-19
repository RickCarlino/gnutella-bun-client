import net from "net";
import { GnutellaObject, parseGnutella } from "./parser";

type Sender = (message: Buffer) => void;

interface InboundConnectionHandler {
  onMessage: (clientId: string, send: Sender, message: GnutellaObject) => void;
  onError: (clientId: string, send: Sender, error: Error) => void;
  onClose: (clientId: string) => void;
  onConnect: (clientId: string, send: Sender) => void;
}

interface ServerConfig {
  port: number;
  host?: string;
  maxConnections?: number;
  headers?: Record<string, string>;
  handler: InboundConnectionHandler;
}

interface ClientInfo {
  socket: net.Socket;
  handshake: boolean;
  version?: string;
}

interface GnutellaServerState {
  server: net.Server;
  clients: Map<string, ClientInfo>;
  config: ServerConfig;
}

const handshakeSize = (buf: Buffer): number => {
  const s = buf.toString("ascii");
  const v06 = s.indexOf("\r\n\r\n");
  if (v06 !== -1) return v06 + 4;
  return 0;
};

const binarySize = (parsed: GnutellaObject): number => {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      throw new Error("Invalid message type for binary size calculation");
    default:
      return 23 + parsed.header.payloadLength;
  }
};

const messageSize = (m: GnutellaObject, buf: Buffer): number =>
  ["handshake_connect", "handshake_ok", "handshake_error"].includes(m.type)
    ? handshakeSize(buf)
    : binarySize(m);

const handleConnection = (state: GnutellaServerState, socket: net.Socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`New connection from ${clientId}`);

  const send: Sender = (data) => socket.write(data);
  let buf = Buffer.alloc(0);

  state.clients.set(clientId, { socket, handshake: false });
  state.config.handler.onConnect(clientId, send);

  const process = () => {
    while (buf.length) {
      const parsed = parseGnutella(buf);
      if (!parsed) return;

      const size = messageSize(parsed, buf);
      if (size === 0 || buf.length < size) return;

      state.config.handler.onMessage(clientId, send, parsed);
      buf = buf.subarray(size);
    }
  };

  socket.on("data", (chunk) => {
    console.log(`Received data from ${clientId}: ${chunk.length} bytes`);
    console.log(chunk.toString("ascii").slice(0, 8));
    buf = Buffer.concat([buf, chunk]);
    try {
      process();
    } catch (e) {
      state.config.handler.onError(clientId, send, e as Error);
    }
  });

  socket.on("error", (e) => {
    state.config.handler.onError(clientId, send, e);
    state.clients.delete(clientId);
  });

  socket.on("close", () => {
    state.config.handler.onClose(clientId);
    state.clients.delete(clientId);
  });
};

export function createGnutellaServer(config: ServerConfig) {
  const state: GnutellaServerState = {
    server: net.createServer(),
    clients: new Map(),
    config,
  };

  state.server.on("connection", (socket) => handleConnection(state, socket));
  state.server.on("error", (err) => console.error("Server error:", err));

  if (config.maxConnections) {
    state.server.maxConnections = config.maxConnections;
  }

  return {
    start: (): Promise<void> =>
      new Promise((resolve, reject) => {
        state.server.listen(config.port, config.host || "0.0.0.0", () => {
          const addr = state.server.address();
          if (addr && typeof addr === "object") {
            console.log(
              `Gnutella server listening on ${addr.address}:${addr.port}`
            );
          }
          resolve();
        });
        state.server.on("error", reject);
      }),

    stop: (): Promise<void> =>
      new Promise((resolve) => {
        state.clients.forEach((client) => client.socket.destroy());
        state.clients.clear();

        state.server.close(() => {
          console.log("Gnutella server stopped");
          resolve();
        });
      }),

    getClients: () =>
      Array.from(state.clients.entries()).map(([id, client]) => ({
        id,
        handshake: client.handshake,
        version: client.version,
      })),

    setClientHandshake: (clientId: string, version?: string) => {
      const client = state.clients.get(clientId);
      if (client) {
        client.handshake = true;
        client.version = version;
      }
    },
  };
}

// Export types for external use
export type { ServerConfig, InboundConnectionHandler, Sender };
