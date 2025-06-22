export interface Message {
  type:
    | "bye"
    | "handshake_connect"
    | "handshake_error"
    | "handshake_ok"
    | "ping"
    | "pong"
    | "push"
    | "query"
    | "query_hits"
    | "route_table_update";
  header?: MessageHeader;
  [key: string]: any;
}

export interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

export interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

export interface Connection {
  id: string;
  socket: any;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  isServer: boolean;
  enableCompression?: () => void;
}

export interface SocketHandler {
  send: (data: Buffer) => void;
  enableCompression: () => void;
  close: () => void;
}

export interface SharedFile {
  index: number;
  filename: string;
  size: number;
  keywords: string[];
}
