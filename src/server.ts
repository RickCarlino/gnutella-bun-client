import net from "net";
import { GnutellaObject } from "./parser";
import { createSocketHandler, sendMessage } from "./utils/socket-handler";
import type { Sender, ClientInfo } from "./types";

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


interface GnutellaServerState {
  server: net.Server;
  clients: Map<string, ClientInfo>;
  config: ServerConfig;
}


const handleConnection = (state: GnutellaServerState, socket: net.Socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`New connection from ${clientId}`);

  const send: Sender = (data) => sendMessage(socket, data);

  state.clients.set(clientId, { 
    id: clientId,
    socket, 
    handshake: false 
  });
  state.config.handler.onConnect(clientId, send);

  createSocketHandler({
    socket,
    onMessage: (message) => {
      console.log(`Received data from ${clientId}`);
      state.config.handler.onMessage(clientId, send, message);
    },
    onError: (error) => {
      state.config.handler.onError(clientId, send, error);
      state.clients.delete(clientId);
    },
    onClose: () => {
      state.config.handler.onClose(clientId);
      state.clients.delete(clientId);
    },
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
