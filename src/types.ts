import * as net from "net";

export type Sender = (message: Buffer) => void;

export interface ConnectionInfo {
  socket: net.Socket;
  handshake: boolean;
  version?: string;
  connectTime: number;
}

export interface ClientInfo {
  id: string;
  socket: net.Socket;
  handshake: boolean;
  version?: string;
}