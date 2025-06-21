import net from "net";
import { createCompressedSocketHandler, CompressionState } from "./utils/compressed-socket-handler";
import { createServerLifecycle } from "./utils/server-lifecycle";
import type { Sender, ServerConfig } from "./types";

interface CompressedClientInfo {
  id: string;
  socket: net.Socket;
  handshake: boolean;
  version?: string;
  compressionState?: CompressionState;
  send?: Sender;
  completeHandshake?: () => void;
}

interface GnutellaServerState {
  server: net.Server;
  clients: Map<string, CompressedClientInfo>;
  config: ServerConfig;
}

const handleConnection = (state: GnutellaServerState, socket: net.Socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`New connection from ${clientId}`);

  const { send, compressionState, completeHandshake } = createCompressedSocketHandler({
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
    isServer: true,
  });

  state.clients.set(clientId, { 
    id: clientId,
    socket, 
    handshake: false,
    compressionState,
    send,
    completeHandshake
  });
  
  state.config.handler.onConnect(clientId, send);
};

export function createCompressedGnutellaServer(config: ServerConfig) {
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
        compressed: client.compressionState?.isCompressed || false,
      })),

    setClientHandshake: (clientId: string, version?: string) => {
      const client = state.clients.get(clientId);
      if (client) {
        client.handshake = true;
        client.version = version;
        
        // Log compression status after handshake
        if (client.compressionState?.isCompressed) {
          console.log(
            `[Server] Compression enabled with ${clientId} (recv: ${client.compressionState.peerSendsCompressed}, send: ${client.compressionState.peerAcceptsCompression})`
          );
        }
      }
    },
    
    getCompressionState: (clientId: string): CompressionState | undefined => {
      return state.clients.get(clientId)?.compressionState;
    },
    
    enableCompression: (clientId: string, sendCompressed: boolean, receiveCompressed: boolean) => {
      const client = state.clients.get(clientId);
      if (client && client.compressionState) {
        // Find the handler and enable compression
        // This is a workaround - in production you'd store the enableCompression function with the client
        console.log(`[Server] Enabling compression for ${clientId}: send=${sendCompressed}, recv=${receiveCompressed}`);
        client.compressionState.peerAcceptsCompression = sendCompressed;
        client.compressionState.peerSendsCompressed = receiveCompressed;
      }
    },
    
    completeHandshake: (clientId: string) => {
      const client = state.clients.get(clientId);
      if (client && client.completeHandshake) {
        client.completeHandshake();
      }
    }
  };
}

// Export types for external use
export type { CompressedClientInfo };