import * as net from "net";
import type { CompressionState } from "./utils/compressed-socket-handler";
import type { GnutellaObject } from "./parser";

export type Sender = (message: Buffer) => void;

export interface ConnectionInfo {
  socket: net.Socket;
  handshake: boolean;
  version?: string;
  connectTime: number;
  compressionState?: CompressionState;
  send?: Sender;
  completeHandshake?: () => void;
}

export interface ClientInfo {
  id: string;
  socket: net.Socket;
  handshake: boolean;
  version?: string;
}

export interface InboundConnectionHandler {
  onMessage: (clientId: string, send: Sender, message: GnutellaObject) => void;
  onError: (clientId: string, send: Sender, error: Error) => void;
  onClose: (clientId: string) => void;
  onConnect: (clientId: string, send: Sender) => void;
}

export interface ServerConfig {
  port: number;
  host?: string;
  maxConnections?: number;
  headers?: Record<string, string>;
  handler: InboundConnectionHandler;
}