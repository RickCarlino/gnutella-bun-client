import { promises as fs } from "fs";
import { readFile, writeFile } from "fs/promises";
import net from "net";
import path from "path";
import { promisify } from "util";
import zlib from "zlib";
import { Binary } from "./binary";
import { Hash } from "./Hash";
import { IDGenerator } from "./IDGenerator";
import { CONFIG } from "./const";
import { GnutellaConfig } from "./types";
import { log } from "./log";

enum MessageType {
  PING = 0,
  PONG = 1,
  BYE = 2,
  PUSH = 64,
  QUERY = 128,
  QUERY_HITS = 129,
  ROUTE_TABLE_UPDATE = 48,
}

enum QRPVariant {
  RESET = 0,
  PATCH = 1,
}

interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

interface HandshakeConnectMessage {
  type: "handshake_connect";
  version: string;
  headers: Record<string, string>;
}

interface HandshakeOkMessage {
  type: "handshake_ok";
  version: string;
  statusCode: number;
  message: string;
  headers: Record<string, string>;
}

interface HandshakeErrorMessage {
  type: "handshake_error";
  code: number;
  message: string;
  headers: Record<string, string>;
}

interface PingMessage {
  type: "ping";
  header: MessageHeader;
}

interface PongMessage {
  type: "pong";
  header: MessageHeader;
  port: number;
  ipAddress: string;
  filesShared: number;
  kilobytesShared: number;
}

interface ByeMessage {
  type: "bye";
  header: MessageHeader;
  code: number;
  message: string;
}

interface PushMessage {
  type: "push";
  header: MessageHeader;
  serventId: Buffer;
  fileIndex: number;
  ipAddress: string;
  port: number;
}

interface QueryMessage {
  type: "query";
  header: MessageHeader;
  minimumSpeed: number;
  searchCriteria: string;
  extensions: Buffer | null;
}

interface QueryHitResult {
  fileIndex: number;
  fileSize: number;
  filename: string;
  extensions?: string;
}

interface QueryHitsMessage {
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

interface RouteTableUpdateMessage {
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

type GnutellaMessage =
  | HandshakeConnectMessage
  | HandshakeOkMessage
  | HandshakeErrorMessage
  | PingMessage
  | PongMessage
  | ByeMessage
  | PushMessage
  | QueryMessage
  | QueryHitsMessage
  | RouteTableUpdateMessage;

const HOUR = 60 * 60 * 1000; // 1 hour

const Protocol = {
  PORT: 6346,
  VERSION: "0.6",
  TTL: 7,
  HEADER_SIZE: 23,
  PONG_SIZE: 14,
  QUERY_HITS_FOOTER: 23,
  QRP_TABLE_SIZE: 8192,
  QRP_INFINITY: 7,
  HANDSHAKE_END: `\r\n\r\n`,
};

class MessageParser {
  static parse(buffer: Buffer): GnutellaMessage | null {
    const handshake = this.parseHandshake(buffer);
    if (handshake) {
      log.debug("Parser", "Parsed handshake", { type: handshake.type });
      return handshake;
    }

    if (buffer.length < Protocol.HEADER_SIZE) {
      log.debug("Parser", "Insufficient data for header", {
        have: buffer.length,
        need: Protocol.HEADER_SIZE,
      });
      return null;
    }

    const header = this.parseHeader(buffer);
    if (!header) {
      log.warn("Parser", "Failed to parse header");
      return null;
    }

    const totalSize = Protocol.HEADER_SIZE + header.payloadLength;
    if (buffer.length < totalSize) {
      log.debug("Parser", "Partial message in buffer", {
        have: buffer.length,
        need: totalSize,
      });
      return null;
    }

    const payload = buffer.slice(Protocol.HEADER_SIZE, totalSize);
    const parsed = this.parsePayload(header, payload);
    if (!parsed) {
      log.warn("Parser", "Unknown/invalid payload", {
        descriptor: header.payloadDescriptor,
        length: header.payloadLength,
      });
    } else {
      log.debug("Parser", "Parsed payload", { type: parsed.type });
    }
    return parsed;
  }

  static getMessageSize(message: GnutellaMessage, buffer: Buffer): number {
    if (message.type.startsWith("handshake_")) {
      const text = buffer.toString("ascii");
      const index = text.indexOf(Protocol.HANDSHAKE_END);
      return index !== -1 ? index + 4 : 0;
    }
    // Type guard to check if message has header
    if ("header" in message && message.header) {
      return Protocol.HEADER_SIZE + message.header.payloadLength;
    }
    return Protocol.HEADER_SIZE;
  }

  static parseHandshake(
    buffer: Buffer,
  ):
    | HandshakeConnectMessage
    | HandshakeOkMessage
    | HandshakeErrorMessage
    | null {
    const text = buffer.toString("ascii");
    const endIndex = text.indexOf(Protocol.HANDSHAKE_END);
    if (endIndex === -1) {
      return null;
    }

    const lines = text.substring(0, endIndex).split(`\r\n`);
    const startLine = lines[0];
    const headers = this.parseHeaders(lines.slice(1));

    if (startLine.startsWith("GNUTELLA CONNECT/")) {
      const msg = {
        type: "handshake_connect",
        version: startLine.split("/")[1],
        headers,
      } as HandshakeConnectMessage;
      log.debug("Parser", "Handshake CONNECT", { headers });
      return msg;
    }

    if (startLine.startsWith("GNUTELLA/")) {
      const match = startLine.match(/GNUTELLA\/(\S+) (\d+) (.+)/);
      if (!match) {
        return null;
      }

      const [, version, code, message] = match;
      const statusCode = parseInt(code);

      if (statusCode === 200) {
        const ok: HandshakeOkMessage = {
          type: "handshake_ok",
          version,
          statusCode,
          message,
          headers,
        };
        log.debug("Parser", "Handshake OK", { headers });
        return ok;
      }
      const err: HandshakeErrorMessage = {
        type: "handshake_error",
        code: statusCode,
        message,
        headers,
      };
      log.warn("Parser", "Handshake error", { code: statusCode, message });
      return err;
    }

    return null;
  }

  static parseHeaders(lines: string[]): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of lines) {
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        headers[key] = value;
      }
    }
    return headers;
  }

  static parseHeader(buffer: Buffer): MessageHeader | null {
    return {
      descriptorId: buffer.slice(0, 16),
      payloadDescriptor: buffer[16],
      ttl: buffer[17],
      hops: buffer[18],
      payloadLength: Binary.readUInt32LE(buffer, 19),
    };
  }

  static parsePayload(
    header: MessageHeader,
    payload: Buffer,
  ): GnutellaMessage | null {
    const parsers: Record<number, () => GnutellaMessage | null> = {
      [MessageType.PING]: () => ({ type: "ping", header }),
      [MessageType.PONG]: () => this.parsePong(header, payload),
      [MessageType.BYE]: () => this.parseBye(header, payload),
      [MessageType.PUSH]: () => this.parsePush(header, payload),
      [MessageType.QUERY]: () => this.parseQuery(header, payload),
      [MessageType.QUERY_HITS]: () => this.parseQueryHits(header, payload),
      [MessageType.ROUTE_TABLE_UPDATE]: () =>
        this.parseRouteTableUpdate(header, payload),
    };

    const parser = parsers[header.payloadDescriptor];
    return parser ? parser() : null;
  }

  static parsePong(header: MessageHeader, payload: Buffer): PongMessage | null {
    if (payload.length < Protocol.PONG_SIZE) {
      return null;
    }
    return {
      type: "pong",
      header,
      port: payload.readUInt16LE(0),
      ipAddress: Binary.bufferToIp(payload, 2),
      filesShared: Binary.readUInt32LE(payload, 6),
      kilobytesShared: Binary.readUInt32LE(payload, 10),
    };
  }

  static parseBye(header: MessageHeader, payload: Buffer): ByeMessage | null {
    if (payload.length < 2) {
      return null;
    }
    return {
      type: "bye",
      header,
      code: payload.readUInt16LE(0),
      message: payload.length > 2 ? payload.slice(2).toString("utf8") : "",
    };
  }

  static parsePush(header: MessageHeader, payload: Buffer): PushMessage | null {
    if (payload.length < 26) {
      return null;
    } // 16 (servent ID) + 4 (file index) + 4 (IP) + 2 (port)
    return {
      type: "push",
      header,
      serventId: payload.slice(0, 16),
      fileIndex: Binary.readUInt32LE(payload, 16),
      ipAddress: Binary.bufferToIp(payload, 20),
      port: payload.readUInt16LE(24),
    };
  }

  static parseQuery(
    header: MessageHeader,
    payload: Buffer,
  ): QueryMessage | null {
    if (payload.length < 3) {
      return null;
    }
    const nullIndex = payload.indexOf(0, 2);
    if (nullIndex === -1) {
      return null;
    }
    return {
      type: "query",
      header,
      minimumSpeed: payload.readUInt16LE(0),
      searchCriteria: payload.slice(2, nullIndex).toString("utf8"),
      extensions:
        nullIndex < payload.length - 1 ? payload.slice(nullIndex + 1) : null,
    };
  }

  static parseQueryHits(
    header: MessageHeader,
    payload: Buffer,
  ): QueryHitsMessage | null {
    if (payload.length < 11) {
      return null;
    }
    return {
      type: "query_hits",
      header,
      numberOfHits: payload[0],
      port: payload.readUInt16LE(1),
      ipAddress: Binary.bufferToIp(payload, 3),
      speed: Binary.readUInt32LE(payload, 7),
      results: [],
      vendorCode: payload.slice(payload.length - 20, payload.length - 16),
      serventId: payload.slice(payload.length - 16),
    };
  }

  static parseRouteTableUpdate(
    header: MessageHeader,
    payload: Buffer,
  ): RouteTableUpdateMessage | null {
    const qrp = this.parseQRP(payload);
    return qrp ? { ...qrp, header } : null;
  }

  static parseQRP(
    payload: Buffer,
  ): Omit<RouteTableUpdateMessage, "header"> | null {
    if (payload.length < 1) {
      return null;
    }
    const variant = payload[0];

    const qrpParsers: Record<
      number,
      () => Omit<RouteTableUpdateMessage, "header"> | null
    > = {
      [QRPVariant.RESET]: () => {
        if (payload.length < 6) {
          return null;
        }
        return {
          type: "route_table_update",
          variant: "reset",
          tableLength: payload.readUInt32LE(1),
          infinity: payload[5],
        };
      },
      [QRPVariant.PATCH]: () => {
        if (payload.length < 6) {
          return null;
        }
        return {
          type: "route_table_update",
          variant: "patch",
          seqNo: payload[1],
          seqSize: payload[2],
          compressor: payload[3],
          entryBits: payload[4],
          data: Buffer.from(payload.subarray(5)),
        };
      },
    };

    const parser = qrpParsers[variant];
    return parser ? parser() : null;
  }
}

class SocketHandler {
  private socket: net.Socket;
  private buffer: Buffer;
  private compressionEnabled: boolean;
  private inflater?: zlib.Inflate;
  private deflater?: zlib.Deflate;
  private onMessage: (message: GnutellaMessage) => void;
  private onError: (error: Error) => void;
  private onClose: () => void;

  constructor(
    socket: net.Socket,
    onMessage: (message: GnutellaMessage) => void,
    onError: (error: Error) => void,
    onClose: () => void,
  ) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.compressionEnabled = false;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;
    this.setupEventHandlers();
    log.info("Socket", "New socket handler", {
      local: `${socket.localAddress}:${socket.localPort}`,
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
    });
  }

  send(data: Buffer): void {
    const target =
      this.compressionEnabled && this.deflater ? this.deflater : this.socket;
    target.write(data);
    log.debug(
      "Socket",
      this.compressionEnabled ? "Wrote compressed data" : "Wrote data",
      { bytes: data.length },
    );
  }

  enableCompression(): void {
    if (this.compressionEnabled) {
      return;
    }
    this.compressionEnabled = true;
    this.setupCompression();
    log.info("Socket", "Compression enabled");
  }

  close(): void {
    this.inflater?.end();
    this.deflater?.end();
    this.socket.destroy();
    log.info("Socket", "Closed socket");
  }

  private setupEventHandlers(): void {
    this.socket.on("data", (chunk) => {
      log.debug("Socket", "Received data", { bytes: chunk.length });
      if (this.compressionEnabled && this.inflater) {
        this.inflater.write(chunk);
      } else {
        this.handleData(chunk);
      }
    });
    this.socket.on("error", (e) => {
      log.error("Socket", "Socket error", e);
      this.onError(e as Error);
    });
    this.socket.on("close", () => {
      log.info("Socket", "Socket closed");
      this.onClose();
    });
  }

  private setupCompression(): void {
    this.inflater = zlib.createInflate();
    this.inflater.on("data", (chunk) => this.handleData(chunk));
    this.inflater.on("error", this.onError);

    this.deflater = zlib.createDeflate({ flush: zlib.Z_SYNC_FLUSH });
    this.deflater.on("data", (chunk) => this.socket.write(chunk));
    this.deflater.on("error", this.onError);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const message = MessageParser.parse(this.buffer);
      if (!message) {
        break;
      }

      const size = MessageParser.getMessageSize(message, this.buffer);
      if (size === 0 || this.buffer.length < size) {
        break;
      }

      this.onMessage(message);
      this.buffer = this.buffer.slice(size);
    }
  }
}

// Hash and IDGenerator are imported from ./Hash and ./IDGenerator

interface FileEntry {
  filename: string;
  size: number;
  index: number;
  sha1?: Buffer;
}

class MessageBuilder {
  static header(
    type: MessageType,
    payloadLength: number,
    ttl: number = Protocol.TTL,
    id?: Buffer,
  ): Buffer {
    const header = Buffer.alloc(Protocol.HEADER_SIZE);
    const messageId = id || IDGenerator.generate();
    messageId.copy(header, 0);
    header[16] = type;
    header[17] = ttl;
    header[18] = 0;
    Binary.writeUInt32LE(header, payloadLength, 19);
    return header;
  }

  static handshake(startLine: string, headers: Record<string, string>): Buffer {
    const lines = [startLine];
    for (const [key, value] of Object.entries(headers)) {
      lines.push(`${key}: ${value}`);
    }
    lines.push("", "");
    return Buffer.from(lines.join(`\r\n`), "ascii");
  }

  static handshakeOk(headers: Record<string, string>): Buffer {
    return this.handshake(`GNUTELLA/${Protocol.VERSION} 200 OK`, headers);
  }

  static ping(id?: Buffer, ttl: number = Protocol.TTL): Buffer {
    return this.header(MessageType.PING, 0, ttl, id);
  }

  static pong(
    pingId: Buffer,
    port: number,
    ip: string,
    files: number = 0,
    kb: number = 0,
    ttl: number = Protocol.TTL,
  ): Buffer {
    const payload = Buffer.alloc(Protocol.PONG_SIZE);
    payload.writeUInt16LE(port, 0);
    Binary.ipToBuffer(ip).copy(payload, 2);
    Binary.writeUInt32LE(payload, files, 6);
    Binary.writeUInt32LE(payload, kb, 10);
    return Buffer.concat([
      this.header(MessageType.PONG, Protocol.PONG_SIZE, ttl, pingId),
      payload,
    ]);
  }

  static queryHit(
    queryId: Buffer,
    port: number,
    ip: string,
    files: FileEntry[],
    serventId: Buffer,
  ): Buffer {
    const fileEntries = files.map((file) => this.fileEntry(file));
    const totalFileSize = fileEntries.reduce(
      (sum, entry) => sum + entry.length,
      0,
    );
    const payloadSize = 11 + totalFileSize + Protocol.QUERY_HITS_FOOTER;
    const header = this.header(
      MessageType.QUERY_HITS,
      payloadSize,
      Protocol.TTL,
      queryId,
    );
    const payloadHeader = this.queryHitHeader(files.length, port, ip);
    const vendorCode = this.vendorCode();

    return Buffer.concat([
      header,
      payloadHeader,
      ...fileEntries,
      vendorCode,
      serventId,
    ]);
  }

  static fileEntry(file: FileEntry): Buffer {
    const nameBuf = Buffer.from(file.filename, "utf8");
    const sha1Urn = file.sha1
      ? Buffer.from(Hash.sha1ToUrn(file.sha1), "utf8")
      : null;
    const entrySize =
      8 + nameBuf.length + 1 + (sha1Urn ? sha1Urn.length + 1 : 1);
    const entry = Buffer.alloc(entrySize);
    let offset = 0;

    Binary.writeUInt32LE(entry, file.index, offset);
    offset += 4;
    Binary.writeUInt32LE(entry, file.size, offset);
    offset += 4;
    nameBuf.copy(entry, offset);
    offset += nameBuf.length;
    entry[offset++] = 0;

    if (sha1Urn) {
      sha1Urn.copy(entry, offset);
      offset += sha1Urn.length;
    }
    entry[offset] = 0;

    return entry;
  }

  static queryHitHeader(fileCount: number, port: number, ip: string): Buffer {
    const header = Buffer.alloc(11);
    header[0] = fileCount;
    header.writeUInt16LE(port, 1);
    Binary.ipToBuffer(ip).copy(header, 3);
    Binary.writeUInt32LE(header, 1000, 7);
    return header;
  }

  static vendorCode(): Buffer {
    const code = Buffer.alloc(7);
    code.write("GBUN", 0, 4, "ascii");
    code[4] = 2;
    code[5] = 0;
    code[6] = 1;
    return code;
  }

  static bye(
    code: number = 200,
    message: string = "Closing connection",
  ): Buffer {
    const messageBytes = Buffer.from(message + "\r\n", "utf8");
    const payloadSize = 2 + messageBytes.length;
    const header = this.header(MessageType.BYE, payloadSize, 1); // TTL=1 as per spec
    const payload = Buffer.alloc(payloadSize);

    payload.writeUInt16LE(code, 0);
    messageBytes.copy(payload, 2);

    return Buffer.concat([header, payload]);
  }

  static push(
    serventId: Buffer,
    fileIndex: number,
    ipAddress: string,
    port: number,
    ttl: number = Protocol.TTL,
  ): Buffer {
    const payloadSize = 26; // 16 (servent ID) + 4 (file index) + 4 (IP) + 2 (port)
    const header = this.header(MessageType.PUSH, payloadSize, ttl);
    const payload = Buffer.alloc(payloadSize);

    serventId.copy(payload, 0);
    Binary.writeUInt32LE(payload, fileIndex, 16);
    Binary.ipToBuffer(ipAddress).copy(payload, 20);
    payload.writeUInt16LE(port, 24);

    return Buffer.concat([header, payload]);
  }
}

interface Context {
  localIp: string;
  localPort: number;
  peerStore: PeerStore;
  qrpManager: QRPManager;
  serventId: Buffer;
}

function buildBaseHeaders(context: Context): Record<string, string> {
  return {
    "User-Agent": "GnutellaBun/0.1",
    "X-Ultrapeer": "False",
    "X-Ultrapeer-Needed": "False",
    "X-Query-Routing": "0.2",
    GGEP: "0.5",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${context.localIp}:${context.localPort}`,
    "Bye-Packet": "0.1",
  };
}

interface Connection {
  id: string;
  socket: net.Socket;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  enableCompression: () => void;
  isOutbound: boolean;
  remoteHeaders?: Record<string, string>;
}

class MessageRouter {
  private messageCache: Map<string, number> = new Map();
  private readonly CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

  ttlCheck(header: MessageHeader): boolean {
    // Check if TTL is 0 BEFORE decrementing
    if (!header || header.ttl === 0) {
      return false;
    }

    // Decrement TTL and increment hops
    header.ttl--;
    header.hops++;

    // After decrement, TTL should still be >= 0 to forward
    return header.ttl >= 0;
  }

  private isMessageSeen(messageId: Buffer): boolean {
    const idString = messageId.toString("hex");
    const now = Date.now();

    // Clean expired entries
    for (const [id, timestamp] of this.messageCache.entries()) {
      if (now - timestamp > this.CACHE_EXPIRY) {
        this.messageCache.delete(id);
      }
    }

    // Check if message was seen
    if (this.messageCache.has(idString)) {
      return true;
    }

    // Mark as seen
    this.messageCache.set(idString, now);
    return false;
  }

  route(conn: Connection, msg: GnutellaMessage, context: Context): void {
    log.debug("Router", "Routing message", { type: msg.type, conn: conn.id });
    // Check for duplicate messages (only for messages with headers)
    if ("header" in msg && msg.header) {
      if (this.isMessageSeen(msg.header.descriptorId)) {
        log.debug("Router", "Dropping duplicate message", {
          id: msg.header.descriptorId.toString("hex"),
        });
        return;
      }
    }

    const handlers: Record<string, () => void> = {
      handshake_connect: () =>
        this.handleHandshakeConnect(
          conn,
          msg as HandshakeConnectMessage,
          context,
        ),
      handshake_ok: () =>
        this.handleHandshakeOk(conn, msg as HandshakeOkMessage, context),
      ping: () => this.handlePing(conn, msg as PingMessage, context),
      pong: () => this.handlePong(conn, msg as PongMessage, context),
      push: () => this.handlePush(conn, msg as PushMessage, context),
      query: () => this.handleQuery(conn, msg as QueryMessage, context),
      bye: () => this.handleBye(conn, msg as ByeMessage),
      handshake_error: () => {},
      route_table_update: () => {},
    };

    const handler = handlers[msg.type];
    if (handler) {
      handler();
      return;
    }
    log.warn("Router", "No handler for message", { type: msg.type });
  }

  private handleHandshakeConnect(
    conn: Connection,
    msg: HandshakeConnectMessage,
    context: Context,
  ): void {
    // Record peer-advertised headers for later capability checks
    conn.remoteHeaders = { ...msg.headers };
    log.info("Router", "Handshake CONNECT received", {
      conn: conn.id,
      headers: msg.headers,
    });
    const clientAcceptsDeflate =
      msg.headers["Accept-Encoding"]?.includes("deflate");
    const responseHeaders = this.buildResponseHeaders(
      context,
      clientAcceptsDeflate,
    );
    conn.send(MessageBuilder.handshakeOk(responseHeaders));
  }

  private handleHandshakeOk(
    conn: Connection,
    msg: HandshakeOkMessage,
    context: Context,
  ): void {
    // Record peer-advertised headers for later capability checks
    conn.remoteHeaders = { ...msg.headers };
    if (conn.handshake) {
      return;
    }

    if (conn.isOutbound) {
      log.info("Router", "Outbound handshake OK", { conn: conn.id });
      const clientAcceptsDeflate =
        msg.headers["Accept-Encoding"]?.includes("deflate");
      const responseHeaders = this.buildResponseHeaders(
        context,
        clientAcceptsDeflate,
      );
      conn.send(MessageBuilder.handshakeOk(responseHeaders));
    }

    conn.handshake = true;
    log.info("Router", "Handshake complete", { conn: conn.id });

    const shouldCompress =
      msg.headers["Content-Encoding"]?.includes("deflate") &&
      this.buildResponseHeaders(context, false)["Accept-Encoding"]?.includes(
        "deflate",
      );

    if (shouldCompress && conn.enableCompression) {
      conn.enableCompression();
    }

    conn.send(MessageBuilder.ping(IDGenerator.generate(), Protocol.TTL));
    log.debug("Router", "Sent initial PING", { conn: conn.id });
    setTimeout(async () => {
      await this.sendQRPTable(conn, context.qrpManager);
    }, 1);
  }

  private handlePing(
    conn: Connection,
    msg: PingMessage,
    context: Context,
  ): void {
    if (!conn.handshake) {
      return;
    }

    const pongTtl = Math.max(msg.header.hops, 1);
    const sharedFiles = context.qrpManager.getFiles();
    const fileCount = sharedFiles.length;
    const totalSizeKb = Math.floor(
      sharedFiles.reduce((sum, file) => sum + file.size, 0) / 1024,
    );

    conn.send(
      MessageBuilder.pong(
        msg.header.descriptorId,
        context.localPort,
        context.localIp,
        fileCount,
        totalSizeKb,
        pongTtl,
      ),
    );
    log.debug("Router", "Responded with PONG", {
      conn: conn.id,
      files: fileCount,
      kb: totalSizeKb,
      ttl: pongTtl,
    });
  }

  private handlePong(
    _conn: Connection,
    msg: PongMessage,
    context: Context,
  ): void {
    context.peerStore.add(msg.ipAddress, msg.port);
    log.debug("Router", "Learned peer from PONG", {
      ip: msg.ipAddress,
      port: msg.port,
    });
  }

  private handleQuery(
    conn: Connection,
    msg: QueryMessage,
    context: Context,
  ): void {
    // Spec guidance: cap broadcast query life; if TTL + Hops > 7, reduce TTL so sum=7.
    // Drop queries with extremely high TTL (>15).
    const sum = msg.header.ttl + msg.header.hops;
    if (msg.header.ttl > 15) {
      return;
    }
    if (sum > 7) {
      msg.header.ttl = Math.max(0, 7 - msg.header.hops);
    }

    if (!this.ttlCheck(msg.header)) {
      return;
    }

    if (!context.qrpManager.matchesQuery(msg.searchCriteria)) {
      log.debug("Router", "Query filtered by QRP", {
        search: msg.searchCriteria,
      });
      return;
    }

    const matchingFiles = context.qrpManager.getMatchingFiles(
      msg.searchCriteria,
    );
    if (matchingFiles.length === 0) {
      return;
    }

    const queryHit = MessageBuilder.queryHit(
      msg.header.descriptorId,
      CONFIG.httpPort,
      context.localIp,
      matchingFiles,
      context.serventId,
    );
    conn.send(queryHit);
    log.info("Router", "Sent QUERY_HITS", {
      conn: conn.id,
      matches: matchingFiles.length,
      search: msg.searchCriteria,
    });
  }

  private buildResponseHeaders(
    context: Context,
    clientAcceptsDeflate: boolean,
  ): Record<string, string> {
    const headers = buildBaseHeaders(context);
    if (clientAcceptsDeflate) {
      headers["Content-Encoding"] = "deflate";
    }
    return headers;
  }

  private async sendQRPTable(
    conn: Connection,
    qrpManager: QRPManager,
  ): Promise<void> {
    log.debug("Router", "Sending QRP reset", { conn: conn.id });
    conn.send(qrpManager.buildResetMessage());
    const patchMessages = await qrpManager.buildPatchMessage();
    log.debug("Router", "Sending QRP patches", {
      conn: conn.id,
      chunks: patchMessages.length,
    });
    patchMessages.forEach((msg) => conn.send(msg));
  }

  private handleBye(conn: Connection, msg: ByeMessage): void {
    // According to spec: "A servent receiving a Bye message MUST close the connection immediately"
    log.info("Router", "Received BYE", {
      code: msg.code,
      message: msg.message,
    });
    conn.socket.destroy();
  }

  private handlePush(
    _conn: Connection,
    msg: PushMessage,
    context: Context,
  ): void {
    // Check if the push request is for us
    if (!msg.serventId.equals(context.serventId)) {
      // Forward the PUSH message if it's not for us and TTL allows
      if (this.ttlCheck(msg.header)) {
        // TODO: Implement forwarding logic based on servent ID routing
      }
      return;
    }

    // This PUSH is for us - initiate a push connection
    log.info("Router", "Received PUSH request", {
      fileIndex: msg.fileIndex,
      target: `${msg.ipAddress}:${msg.port}`,
    });

    // Create a new connection to the requester
    const pushSocket = net.createConnection({
      host: msg.ipAddress,
      port: msg.port,
    });

    pushSocket.once("connect", () => {
      // Send GIV message according to spec
      const givMessage = this.buildGivMessage(
        msg.fileIndex,
        context.serventId,
        context.qrpManager.getFile(msg.fileIndex)?.filename || "",
      );
      pushSocket.write(givMessage);

      // The socket is now ready for the requester to send HTTP GET
      // Hand off to HTTP handling logic
      this.handlePushConnection(pushSocket, msg.fileIndex, context).catch(
        (err) => {
          log.error("Router", "Error in push connection handler", err);
          pushSocket.destroy();
        },
      );
    });

    pushSocket.once("error", (err) => {
      log.error(
        "Router",
        `Failed to establish push connection to ${msg.ipAddress}:${msg.port}`,
        err,
      );
      pushSocket.destroy();
    });
  }

  private buildGivMessage(
    fileIndex: number,
    serventId: Buffer,
    filename: string,
  ): Buffer {
    // Format: GIV <file_index>:<servent_id>/<file_name>\n\n
    const serventIdHex = serventId.toString("hex").toUpperCase();
    const givString = `GIV ${fileIndex}:${serventIdHex}/${filename}\n\n`;
    return Buffer.from(givString, "ascii");
  }

  private async handlePushConnection(
    socket: net.Socket,
    fileIndex: number,
    context: Context,
  ): Promise<void> {
    // After sending GIV, the socket will receive HTTP requests
    let buffer = Buffer.alloc(0);

    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const requestStr = buffer.toString("ascii");

      // Check if we have a complete HTTP request
      if (requestStr.includes("\r\n\r\n")) {
        // Extract the request line
        const lines = requestStr.split("\r\n");
        const requestLine = lines[0];

        if (requestLine.startsWith("GET ")) {
          // Parse the GET request
          const urlMatch = requestLine.match(/^GET\s+(\S+)\s+HTTP/);
          if (!urlMatch) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.end();
            return;
          }

          const file = context.qrpManager.getFile(fileIndex);
          if (!file) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.end();
            return;
          }

          try {
            // Construct file path
            const filePath = path.join(
              process.cwd(),
              "gnutella-library",
              file.filename,
            );
            const stat = await fs.stat(filePath);

            // Parse Range header if present
            const rangeHeader = lines.find((line) =>
              line.toLowerCase().startsWith("range:"),
            );
            let start = 0;
            let end = stat.size - 1;
            let status = 200;
            let statusText = "OK";

            if (rangeHeader) {
              const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
              if (rangeMatch) {
                start = parseInt(rangeMatch[1]);
                if (rangeMatch[2]) {
                  end = parseInt(rangeMatch[2]);
                }
                status = 206;
                statusText = "Partial Content";
              }
            }

            const contentLength = end - start + 1;

            // Send HTTP response headers
            const headers = [
              `HTTP/1.1 ${status} ${statusText}`,
              "Server: GnutellaBun/0.1",
              "Content-Type: application/octet-stream",
              `Content-Length: ${contentLength}`,
              "Accept-Ranges: bytes",
            ];

            if (status === 206) {
              headers.push(`Content-Range: bytes ${start}-${end}/${stat.size}`);
            }

            headers.push("", ""); // Empty line to end headers
            socket.write(headers.join("\r\n"));

            // Stream file content
            const readStream = require("fs").createReadStream(filePath, {
              start,
              end,
            });
            readStream.pipe(socket);

            readStream.on("end", () => {
              // Keep connection open for HTTP/1.1 keep-alive
              const connectionHeader = lines.find((line) =>
                line.toLowerCase().startsWith("connection:"),
              );
              if (
                connectionHeader &&
                connectionHeader.toLowerCase().includes("close")
              ) {
                socket.end();
              }
            });

            readStream.on("error", (err: Error) => {
              log.error("Router", "Error reading file for PUSH", err);
              socket.destroy();
            });
          } catch (err) {
            log.error("Router", "Error handling PUSH file request", err);
            socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
            socket.end();
          }
        } else {
          socket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
          socket.end();
        }
      }
    });

    socket.on("error", (e) => {
      log.error("Router", "Push socket error", e);
      socket.destroy();
    });
    socket.setTimeout(30000, () => socket.destroy()); // 30 second timeout
  }
}

class GnutellaServer {
  private server: net.Server | null;
  private connections: Map<string, Connection>;
  private router: MessageRouter;
  private context: Context;

  constructor(context: Context) {
    this.server = null;
    this.connections = new Map();
    this.router = new MessageRouter();
    this.context = context;
  }
  async pingPeers(ttl: number = Protocol.TTL): Promise<void> {
    let count = 0;
    this.connections.forEach((conn) => {
      if (conn.handshake) {
        conn.send(MessageBuilder.ping(IDGenerator.generate(), ttl));
        count++;
      }
    });
    log.debug("Server", "Pinged peers", { ttl, count });
  }
  async start(port: number): Promise<void> {
    this.server = net.createServer((socket) => this.handleConnection(socket));
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not initialized"));
        return;
      }
      this.server.listen(port, "0.0.0.0", () => {
        log.info("Server", "Gnutella server listening", { port });
        resolve();
      });
      this.server.once("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Send Bye messages to all connections that support it
      this.connections.forEach((conn) => {
        if (conn.handshake) {
          try {
            const supportsBye = Boolean(
              conn.remoteHeaders && conn.remoteHeaders["Bye-Packet"],
            );
            if (supportsBye) {
              conn.send(MessageBuilder.bye(200, "Server shutting down"));
            }
            // Give a brief moment for the Bye message to be sent
            setTimeout(() => conn.socket.destroy(), 100);
          } catch {
            conn.socket.destroy();
          }
        } else {
          conn.socket.destroy();
        }
      });
      this.connections.clear();
      if (this.server) {
        this.server.close(() => {
          log.info("Server", "Server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  connectPeer(host: string, port: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });

      socket.once("connect", () => {
        log.info("Server", "Connected to peer", { host, port });
        this.handleConnection(socket, true);
        const id = `${socket.remoteAddress}:${socket.remotePort}`;
        const conn = this.connections.get(id);
        if (!conn) {
          reject(new Error("Connection not found after establishment"));
          return;
        }
        const headers = buildBaseHeaders(this.context);
        conn.send(
          MessageBuilder.handshake(
            `GNUTELLA CONNECT/${Protocol.VERSION}`,
            headers,
          ),
        );
        resolve(conn);
      });

      socket.once("error", (err) => {
        log.error("Server", "Failed to connect to peer", { host, port, err });
        socket.destroy();
        reject(err);
      });
    });
  }

  private handleConnection(
    socket: net.Socket,
    isOutbound: boolean = false,
  ): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    const handler = new SocketHandler(
      socket,
      (msg) => this.handleMessage(id, msg),
      (err) => this.handleError(id, err),
      () => this.handleClose(id),
    );

    const connection: Connection = {
      id,
      socket,
      send: (data) => handler.send(data),
      handshake: false,
      compressed: false,
      enableCompression: () => handler.enableCompression(),
      isOutbound,
    };

    this.connections.set(id, connection);
    log.info(
      "Server",
      isOutbound ? "Outbound connection" : "Inbound connection",
      {
        id,
      },
    );
  }

  private handleMessage(id: string, msg: GnutellaMessage): void {
    const conn = this.connections.get(id);
    if (!conn) {
      return;
    }
    log.debug("Server", "Message received", { id, type: msg.type });
    this.router.route(conn, msg, this.context);
  }

  private handleError(id: string, _error: Error): void {
    this.connections.delete(id);
    log.warn("Server", "Connection error/removed", { id });
  }

  private handleClose(id: string): void {
    this.connections.delete(id);
    log.info("Server", "Connection closed", { id });
  }

  closeConnection(
    id: string,
    code: number = 200,
    reason: string = "Closing connection",
  ): void {
    const conn = this.connections.get(id);
    if (!conn) {
      return;
    }

    if (conn.handshake) {
      try {
        const supportsBye = Boolean(
          conn.remoteHeaders && conn.remoteHeaders["Bye-Packet"],
        );
        if (supportsBye) {
          conn.send(MessageBuilder.bye(code, reason));
        }
        // Wait briefly for Bye to send, then close
        setTimeout(() => {
          conn.socket.destroy();
          this.connections.delete(id);
        }, 100);
      } catch {
        conn.socket.destroy();
        this.connections.delete(id);
      }
    } else {
      conn.socket.destroy();
      this.connections.delete(id);
    }
    log.info("Server", "Closed connection", { id, code, reason });
  }

  sendPush(
    targetServentId: Buffer,
    fileIndex: number,
    requesterIp: string,
    requesterPort: number,
  ): void {
    // Send PUSH message to all connected nodes
    // The PUSH will be routed based on servent ID
    const pushMessage = MessageBuilder.push(
      targetServentId,
      fileIndex,
      requesterIp,
      requesterPort,
    );

    this.connections.forEach((conn) => {
      if (conn.handshake) {
        try {
          conn.send(pushMessage);
        } catch (err) {
          log.error("Server", `Failed to send PUSH to ${conn.id}`, err);
        }
      }
    });
  }
}

interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

class PeerStore {
  private peers: Map<string, Peer>;
  private filename: string;

  constructor(filename: string = "settings.json") {
    this.peers = new Map();
    this.filename = filename;
  }

  async load(): Promise<void> {
    const data = await readFile(this.filename, "utf8");
    const parsed: GnutellaConfig = JSON.parse(data);
    if (parsed.peers) {
      Object.keys(parsed.peers).forEach((key) => {
        const p = parsed.peers[key];
        this.add(p.ip, p.port, p.lastSeen);
      });
    }
    log.info("PeerStore", "Loaded peers", {
      count: this.peers.size,
      file: this.filename,
    });
  }

  async save(): Promise<void> {
    const content = await readFile(this.filename, "utf8");
    const existingData: GnutellaConfig = JSON.parse(content);
    const peersData: Record<string, Peer> = {};
    this.peers.forEach((peer) => {
      peersData[`${peer.ip}:${peer.port}`] = peer;
    });
    existingData.peers = peersData;
    await writeFile(this.filename, JSON.stringify(existingData, null, 2));
    log.debug("PeerStore", "Saved peers", { count: this.peers.size });
  }

  add(ip: string, port: number, lastSeen: number = Date.now()): void {
    this.peers.set(`${ip}:${port}`, { ip, port, lastSeen });
    log.debug("PeerStore", "Added/updated peer", { ip, port });
  }

  remove(ip: string, port: number): void {
    this.peers.delete(`${ip}:${port}`);
    log.debug("PeerStore", "Removed peer", { ip, port });
  }

  get(count: number): Peer[] {
    return Array.from(this.peers.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, count);
  }

  prune(maxAge: number = HOUR): void {
    const cutoff = Date.now() - maxAge;
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(key);
      }
    });
    log.debug("PeerStore", "Pruned peers", { remaining: this.peers.size });
  }
}

interface SharedFile {
  filename: string;
  size: number;
  index: number;
  keywords: string[];
  sha1: Buffer;
}

class QRPManager {
  private tableSize: number;
  private infinity: number;
  private table: number[];
  private sharedFiles: Map<number, SharedFile>;
  private fileCounter: number;

  constructor(
    tableSize: number = Protocol.QRP_TABLE_SIZE,
    infinity: number = Protocol.QRP_INFINITY,
  ) {
    this.tableSize = tableSize;
    this.infinity = infinity;
    this.table = new Array(tableSize).fill(infinity);
    this.sharedFiles = new Map();
    this.fileCounter = 1;
  }

  addFile(filename: string, size: number, keywords: string[]): number {
    const index = this.fileCounter++;
    const sha1 = Hash.sha1(filename);
    this.sharedFiles.set(index, { filename, size, index, keywords, sha1 });
    this.updateTableForKeywords(keywords);
    log.debug("QRP", "Added file", { index, filename, size });
    return index;
  }

  removeFile(index: number): boolean {
    if (!this.sharedFiles.has(index)) {
      return false;
    }
    this.sharedFiles.delete(index);
    this.rebuildTable();
    return true;
  }

  getFiles(): SharedFile[] {
    return Array.from(this.sharedFiles.values());
  }

  getFile(index: number): SharedFile | undefined {
    return this.sharedFiles.get(index);
  }

  matchesQuery(searchCriteria: string): boolean {
    const keywords = this.extractKeywords(searchCriteria);
    const match = keywords.every((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      return this.table[hash] < this.infinity;
    });
    log.debug("QRP", "QRP table match", { search: searchCriteria, match });
    return match;
  }

  getMatchingFiles(searchCriteria: string): SharedFile[] {
    const queryKeywords = this.extractKeywords(searchCriteria);
    return this.getFiles().filter((file) =>
      queryKeywords.every((queryKeyword) =>
        file.keywords.some((fileKeyword) =>
          fileKeyword.toLowerCase().includes(queryKeyword),
        ),
      ),
    );
  }

  buildResetMessage(): Buffer {
    const payload = Buffer.alloc(6);
    payload[0] = QRPVariant.RESET;
    payload.writeUInt32LE(this.tableSize, 1);
    payload[5] = this.infinity;
    const header = MessageBuilder.header(
      MessageType.ROUTE_TABLE_UPDATE,
      payload.length,
      1,
    );
    log.debug("QRP", "Built QRP reset", {
      tableSize: this.tableSize,
      infinity: this.infinity,
    });
    return Buffer.concat([header, payload]);
  }

  async buildPatchMessage(): Promise<Buffer[]> {
    const deflate = promisify(zlib.deflate);
    const patchData = this.createPatchData();
    const compressed = await deflate(patchData);
    const chunks = this.createPatchChunks(compressed);
    log.debug("QRP", "Built QRP patch chunks", {
      compressedBytes: compressed.length,
      chunks: chunks.length,
    });
    return chunks;
  }

  private updateTableForKeywords(keywords: string[]): void {
    keywords.forEach((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      this.table[hash] = 1;
    });
  }

  private rebuildTable(): void {
    this.table.fill(this.infinity);
    this.sharedFiles.forEach((file) => {
      this.updateTableForKeywords(file.keywords);
    });
  }

  private extractKeywords(searchCriteria: string): string[] {
    return searchCriteria
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0);
  }

  private createPatchData(): Buffer {
    const entryBits = 4;
    const bytesNeeded = Math.ceil((this.tableSize * entryBits) / 8);
    const patchData = Buffer.alloc(bytesNeeded);

    for (let i = 0; i < this.tableSize; i++) {
      const value = Math.max(-8, Math.min(7, this.table[i] - this.infinity));
      const unsignedValue = value & 15;
      const byteIndex = Math.floor(i / 2);

      if (i % 2 === 0) {
        patchData[byteIndex] =
          (patchData[byteIndex] & 15) | (unsignedValue << 4);
      } else {
        patchData[byteIndex] = (patchData[byteIndex] & 240) | unsignedValue;
      }
    }

    return patchData;
  }

  private createPatchChunks(compressed: Buffer): Buffer[] {
    const maxChunkSize = 1024 - 6;
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < compressed.length; offset += maxChunkSize) {
      const chunk = compressed.subarray(offset, offset + maxChunkSize);
      chunks.push(chunk);
    }

    return chunks.map((chunk, index) => {
      const payload = Buffer.alloc(6 + chunk.length);
      payload[0] = QRPVariant.PATCH;
      payload[1] = index + 1;
      payload[2] = chunks.length;
      payload[3] = 1;
      payload[4] = 4;
      chunk.copy(payload, 5);

      const header = MessageBuilder.header(
        MessageType.ROUTE_TABLE_UPDATE,
        payload.length,
        1,
      );
      return Buffer.concat([header, payload]);
    });
  }
}

export class GnutellaNode {
  private server: GnutellaServer | null;
  private peerStore: PeerStore;
  private qrpManager: QRPManager;
  private context: Context | null;

  constructor() {
    this.server = null;
    this.peerStore = new PeerStore();
    this.qrpManager = new QRPManager();
    this.context = null;
  }

  async start(): Promise<void> {
    log.info("Node", "Starting node...");
    const localIp = await this.getPublicIp();
    const localPort = Protocol.PORT;
    const serventId = IDGenerator.servent();
    log.info("Node", "Local identity", {
      ip: localIp,
      port: localPort,
      servent: serventId.toString("hex").slice(0, 16) + "...",
    });

    this.context = {
      localIp,
      localPort,
      peerStore: this.peerStore,
      qrpManager: this.qrpManager,
      serventId,
    };

    await this.peerStore.load();
    await this.loadSharedFiles();
    log.info("Node", "Shared files loaded", {
      count: this.qrpManager.getFiles().length,
    });

    this.server = new GnutellaServer(this.context);
    await this.server.start(localPort);

    this.setupPeriodicTasks();
    this.setupShutdownHandler();
  }

  private async getPublicIp(): Promise<string> {
    const response = await fetch("https://wtfismyip.com/text");
    return (await response.text()).trim();
  }

  private async loadSharedFiles(): Promise<void> {
    const dir = path.join(process.cwd(), "gnutella-library");
    await fs.mkdir(dir, { recursive: true });

    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const filePath = path.join(dir, entry.name);
      const stat = await fs.stat(filePath);
      const parsed = path.parse(entry.name);

      const keywords = new Set<string>();
      keywords.add(entry.name.toLowerCase());

      if (parsed.name) {
        parsed.name
          .split(/[^a-zA-Z0-9]+/)
          .filter(Boolean)
          .forEach((k) => keywords.add(k.toLowerCase()));
      }

      if (parsed.ext) {
        keywords.add(parsed.ext.replace(/^\./, "").toLowerCase());
      }

      this.qrpManager.addFile(entry.name, stat.size, Array.from(keywords));
    }
  }

  getSharedFiles(): SharedFile[] {
    return this.qrpManager.getFiles();
  }

  sendPush(
    targetServentId: Buffer,
    fileIndex: number,
    requesterPort: number,
  ): void {
    if (!this.server || !this.context) {
      throw new Error("GnutellaNode not started");
    }

    this.server.sendPush(
      targetServentId,
      fileIndex,
      this.context.localIp,
      requesterPort,
    );
  }

  private setupPeriodicTasks(): void {
    setInterval(() => this.peerStore.save(), 60000);
    setInterval(() => this.peerStore.prune(), HOUR);
    // Send regular pings (TTL=7) every 3 seconds for fresh pong cache
    setInterval(() => this.server?.pingPeers(Protocol.TTL), 3 * 1000);
    // Send alive pings (TTL=1) every 30 seconds to keep connections alive
    setInterval(() => this.server?.pingPeers(1), 30 * 1000);
    log.info("Node", "Periodic tasks scheduled");
  }

  private setupShutdownHandler(): void {
    process.on("SIGINT", async () => {
      log.info("Node", "SIGINT received, shutting down...");
      await this.server?.stop();
      await this.peerStore.save();
      process.exit(0);
    });
  }
}
