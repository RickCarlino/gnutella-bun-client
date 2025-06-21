import net from "net";
import { createSocketHandler, sendMessage } from "./utils/socket-handler";
import { createServerLifecycle } from "./utils/server-lifecycle";
import type { Sender, ClientInfo, ServerConfig } from "./types";


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

  const lifecycle = createServerLifecycle(state.server, config, () => {
    state.clients.forEach((client) => client.socket.destroy());
    state.clients.clear();
  });

  return {
    start: lifecycle.start,
    stop: lifecycle.stop,

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

