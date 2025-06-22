import { type QRPManager } from "./qrp_manager";
import { type PeerStore } from "./peer_store";

export interface NodeContext {
  localIp: string;
  localPort: number;
  qrpManager: QRPManager;
  peerStore: PeerStore;
  serventId: Buffer;
}

export interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

export interface BaseMessage {
  type: string;
  header?: MessageHeader;
}

export interface HandshakeConnectMessage extends BaseMessage {
  type: "handshake_connect";
  version: string;
  headers: Record<string, string>;
}

export interface HandshakeOkMessage extends BaseMessage {
  type: "handshake_ok";
  version: string;
  statusCode: number;
  message: string;
  headers: Record<string, string>;
}

export interface HandshakeErrorMessage extends BaseMessage {
  type: "handshake_error";
  code: number;
  message: string;
  headers: Record<string, string>;
}

export interface PingMessage extends BaseMessage {
  type: "ping";
  header: MessageHeader;
}

export interface PongMessage extends BaseMessage {
  type: "pong";
  header: MessageHeader;
  port: number;
  ipAddress: string;
  filesShared: number;
  kilobytesShared: number;
}

export interface ByeMessage extends BaseMessage {
  type: "bye";
  header: MessageHeader;
  code: number;
  message: string;
}

export interface QueryMessage extends BaseMessage {
  type: "query";
  header: MessageHeader;
  minimumSpeed: number;
  searchCriteria: string;
  extensions: Buffer | null;
}

export interface QueryHitsMessage extends BaseMessage {
  type: "query_hits";
  header: MessageHeader;
  numberOfHits: number;
  port: number;
  ipAddress: string;
  speed: number;
  results: SharedFile[];
  vendorCode: Buffer;
  serventId: Buffer;
}

export interface RouteTableUpdateMessage extends BaseMessage {
  type: "route_table_update";
  header: MessageHeader;
  variant: "reset" | "patch";
  tableLength?: number;
  infinity?: number;
  seqNo?: number;
  seqSize?: number;
  compressor?: number;
  entryBits?: number;
  data?: Buffer;
}

export type Message =
  | HandshakeConnectMessage
  | HandshakeOkMessage
  | HandshakeErrorMessage
  | PingMessage
  | PongMessage
  | ByeMessage
  | QueryMessage
  | QueryHitsMessage
  | RouteTableUpdateMessage;

export interface Connection {
  id: string;
  socket: import("net").Socket;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  enableCompression?: () => void;
}

export interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

export interface SharedFile {
  filename: string;
  size: number;
  index: number;
  keywords: string[];
  sha1: Buffer;
}
