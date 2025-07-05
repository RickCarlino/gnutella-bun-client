import type { Socket } from "net";
import type { SimpleFileManager } from "./SimpleFileManager";
import type { SettingStore } from "./SettingStore";

export interface Cache {
  url: string;
  network: string;
  addedAt: number;
}

export interface FileEntry {
  filename: string;
  size: number;
  index: number;
  sha1?: Buffer;
}

export interface Host {
  ip: string;
  port: number;
  network: string;
  addedAt: number;
  cluster?: string;
}

export interface RateLimit {
  lastAccess: number;
  count: number;
}

export interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
  firstSeen?: number;
  source?: "manual" | "gwc" | "pong";
  failureCount?: number;
}

export interface GnutellaConfig {
  httpPort: number;
  peers: Record<string, Peer>;
  caches: Record<string, { lastPush: number; lastPull: number }>;
}

export enum MessageType {
  PING = 0,
  PONG = 1,
  BYE = 2,
  PUSH = 64,
  QUERY = 128,
  QUERY_HITS = 129,
}

export interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

export interface HandshakeConnectMessage {
  type: "handshake_connect";
  version: string;
  headers: Record<string, string>;
}

export interface HandshakeOkMessage {
  type: "handshake_ok";
  version: string;
  statusCode: number;
  message: string;
  headers: Record<string, string>;
}

export interface HandshakeErrorMessage {
  type: "handshake_error";
  code: number;
  message: string;
  headers: Record<string, string>;
}

export interface PingMessage {
  type: "ping";
  header: MessageHeader;
}

export interface PongMessage {
  type: "pong";
  header: MessageHeader;
  port: number;
  ipAddress: string;
  filesShared: number;
  kilobytesShared: number;
}

export interface ByeMessage {
  type: "bye";
  header: MessageHeader;
  code: number;
  message: string;
}

export interface PushMessage {
  type: "push";
  header: MessageHeader;
  serventId: Buffer;
  fileIndex: number;
  ipAddress: string;
  port: number;
}

export interface QueryMessage {
  type: "query";
  header: MessageHeader;
  minimumSpeed: number;
  searchCriteria: string;
  extensions: Buffer | null;
}

export interface QueryHitResult {
  fileIndex: number;
  fileSize: number;
  filename: string;
  extensions?: string;
}

export interface QueryHitsMessage {
  type: "query_hits";
  header: MessageHeader;
  numberOfHits: number;
  port: number;
  ipAddress: string;
  speed: number;
  results: QueryHitResult[];
  vendorCode: Buffer;
  serventId: Buffer;
}

export interface Context {
  localIp: string;
  localPort: number;
  peerStore: SettingStore;
  fileManager: SimpleFileManager;
  serventId: Buffer;
}

export interface Connection {
  id: string;
  socket: Socket;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  enableCompression: () => void;
  isOutbound: boolean;
}

export interface SharedFile {
  filename: string;
  size: number;
  index: number;
  keywords: string[];
  sha1: Buffer;
}

export type GnutellaMessage =
  | HandshakeConnectMessage
  | HandshakeOkMessage
  | HandshakeErrorMessage
  | PingMessage
  | PongMessage
  | ByeMessage
  | PushMessage
  | QueryMessage
  | QueryHitsMessage;
