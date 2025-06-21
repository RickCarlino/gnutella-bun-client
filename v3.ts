import { createDeflate, createInflate } from "node:zlib";
import { randomBytes } from "node:crypto";
import * as net from "net";

interface Message {
  type:
    | "bye"
    | "handshake_connect"
    | "handshake_error"
    | "handshake_ok"
    | "ping"
    | "pong"
    | "push"
    | "qrp_patch"
    | "qrp_reset"
    | "query"
    | "queryhits";
  header?: MessageHeader;
  [key: string]: any;
}

interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

interface Connection {
  id: string;
  socket: any;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  isServer: boolean;
  enableCompression?: () => void;
}

interface SocketHandler {
  send: (data: Buffer) => void;
  enableCompression: () => void;
  close: () => void;
}

const DEFAULT_PORT = 6346;
const MESSAGE_TYPES = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  QRP: 0x30,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HITS: 0x81,
};
const QRP_VARIANTS = {
  RESET: 0,
  PATCH: 1,
};

// Message ID tracking for duplicate detection
const seenMessages = new Map<string, number>();
const MESSAGE_CACHE_TIME = 600000; // 10 minutes

const log = (msg: string) => console.log(msg);

function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value, offset);
}

function generateId(): Buffer {
  const id = randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

function ipToBuffer(ip: string): Buffer {
  const buffer = Buffer.alloc(4);
  ip.split(".").forEach((part, i) => (buffer[i] = parseInt(part)));
  return buffer;
}

function bufferToIp(buffer: Buffer, offset: number): string {
  return Array.from(buffer.slice(offset, offset + 4)).join(".");
}

function buildHeader(
  type: number,
  payloadLength: number,
  ttl: number = 7,
  id?: Buffer
): Buffer {
  const header = Buffer.alloc(23);
  (id || generateId()).copy(header, 0);
  header[16] = type;
  header[17] = ttl;
  header[18] = 0;
  writeUInt32LE(header, payloadLength, 19);
  return header;
}

function buildHandshake(
  startLine: string,
  headers: Record<string, string>
): Buffer {
  const lines = [startLine];
  Object.entries(headers).forEach(([key, value]) =>
    lines.push(`${key}: ${value}`)
  );
  lines.push(""); // Single blank line
  return Buffer.from(lines.join("\r\n") + "\r\n", "ascii");
}

function buildPing(id?: Buffer, ttl: number = 7): Buffer {
  return buildHeader(MESSAGE_TYPES.PING, 0, ttl, id);
}

function buildPong(
  pingId: Buffer,
  port: number,
  ip: string,
  files: number = 0,
  kb: number = 0,
  ttl?: number
): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt16LE(port, 0);
  ipToBuffer(ip).copy(payload, 2);
  writeUInt32LE(payload, files, 6);
  writeUInt32LE(payload, kb, 10);

  const header = buildHeader(MESSAGE_TYPES.PONG, 14, ttl || 7, pingId);
  return Buffer.concat([header, payload]);
}

function buildBye(code: number, message: string = ""): Buffer {
  const messageBuffer = Buffer.from(message, "utf8");
  const payload = Buffer.alloc(2 + messageBuffer.length);
  payload.writeUInt16LE(code, 0);
  messageBuffer.copy(payload, 2);

  const header = buildHeader(MESSAGE_TYPES.BYE, payload.length, 1);
  return Buffer.concat([header, payload]);
}

function buildQrpReset(tableSize: number = 65536): Buffer {
  const payload = Buffer.alloc(6);
  payload[0] = QRP_VARIANTS.RESET;
  writeUInt32LE(payload, tableSize, 1);
  payload[5] = 1; // infinity flag must be 1 (0x01)

  const header = buildHeader(MESSAGE_TYPES.QRP, 6, 1);
  return Buffer.concat([header, payload]);
}

function buildQrpPatch(
  seq: number,
  total: number,
  bits: number,
  data: Buffer
): Buffer {
  const payload = Buffer.alloc(5 + data.length);
  payload[0] = QRP_VARIANTS.PATCH;
  payload[1] = seq;
  payload[2] = total;
  payload[3] = 0;
  payload[4] = bits;
  data.copy(payload, 5);

  const header = buildHeader(MESSAGE_TYPES.QRP, payload.length, 1);
  return Buffer.concat([header, payload]);
}

function parseMessage(buffer: Buffer): Message | null {
  const handshake = tryParseHandshake(buffer);
  if (handshake) return handshake;

  if (buffer.length < 23) return null;

  const header = parseHeader(buffer);
  if (!header) return null;

  if (buffer.length < 23 + header.payloadLength) return null;

  const payload = buffer.slice(23, 23 + header.payloadLength);
  return parsePayload(header, payload);
}

function tryParseHandshake(buffer: Buffer): Message | null {
  const text = buffer.toString("ascii");
  const endIndex = text.indexOf("\r\n\r\n");
  if (endIndex === -1) return null;

  const lines = text.substring(0, endIndex).split("\r\n");
  const startLine = lines[0];
  const headers = parseHeaders(lines.slice(1));

  if (startLine.startsWith("GNUTELLA CONNECT/")) {
    return {
      type: "handshake_connect",
      version: startLine.split("/")[1],
      headers,
    };
  }

  if (startLine.startsWith("GNUTELLA/")) {
    const match = startLine.match(/GNUTELLA\/(\S+) (\d+) (.+)/);
    if (!match) return null;

    const [, version, code, message] = match;
    const statusCode = parseInt(code);

    if (statusCode === 200) {
      return { type: "handshake_ok", version, statusCode, message, headers };
    }

    return { type: "handshake_error", code: statusCode, message, headers };
  }

  return null;
}

function parseHeaders(lines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  lines.forEach((line) => {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      headers[line.substring(0, colonIndex).trim()] = line
        .substring(colonIndex + 1)
        .trim();
    }
  });
  return headers;
}

function parseHeader(buffer: Buffer): MessageHeader | null {
  return {
    descriptorId: buffer.slice(0, 16),
    payloadDescriptor: buffer[16],
    ttl: buffer[17],
    hops: buffer[18],
    payloadLength: readUInt32LE(buffer, 19),
  };
}

function parsePayload(header: MessageHeader, payload: Buffer): Message | null {
  switch (header.payloadDescriptor) {
    case MESSAGE_TYPES.PING:
      return { type: "ping", header };

    case MESSAGE_TYPES.PONG:
      if (payload.length < 14) return null;
      return {
        type: "pong",
        header,
        port: payload.readUInt16LE(0),
        ipAddress: bufferToIp(payload, 2),
        filesShared: readUInt32LE(payload, 6),
        kilobytesShared: readUInt32LE(payload, 10),
      };

    case MESSAGE_TYPES.BYE:
      if (payload.length < 2) return null;
      const code = payload.readUInt16LE(0);
      const message =
        payload.length > 2 ? payload.slice(2).toString("utf8") : "";
      return {
        type: "bye",
        header,
        code,
        message,
      };

    case MESSAGE_TYPES.QUERY:
      if (payload.length < 3) return null;
      const nullIndex = payload.indexOf(0, 2);
      if (nullIndex === -1) return null;

      // Parse full query including GGEP/HUGE extensions
      const searchCriteria = payload.slice(2, nullIndex).toString("utf8");
      const extensions =
        nullIndex < payload.length - 1 ? payload.slice(nullIndex + 1) : null;

      return {
        type: "query",
        header,
        minimumSpeed: payload.readUInt16LE(0),
        searchCriteria,
        extensions,
      };

    case MESSAGE_TYPES.QRP:
      if (payload.length < 6) return null;
      const variant = payload[0];
      if (variant === QRP_VARIANTS.RESET) {
        return {
          type: "qrp_reset",
          header,
          variant,
          tableLength: readUInt32LE(payload, 1),
          infinity: payload[5],
        };
      }
      if (variant === QRP_VARIANTS.PATCH) {
        return {
          type: "qrp_patch",
          header,
          variant,
          seqNo: payload[1],
          seqCount: payload[2],
          compression: payload[3],
          entryBits: payload[4],
          data: payload.slice(5),
        };
      }
      return null;

    default:
      return null;
  }
}

// Duplicate detection helpers
function getMessageId(header: MessageHeader): string {
  return header.descriptorId.toString("hex");
}

function isDuplicate(header: MessageHeader): boolean {
  const id = getMessageId(header);
  const now = Date.now();

  // Clean old entries
  for (const [msgId, timestamp] of seenMessages.entries()) {
    if (now - timestamp > MESSAGE_CACHE_TIME) {
      seenMessages.delete(msgId);
    }
  }

  if (seenMessages.has(id)) {
    return true;
  }

  seenMessages.set(id, now);
  return false;
}

function adjustHopsAndTtl(header: MessageHeader): boolean {
  if (header.ttl === 0) return false;
  header.ttl--;
  header.hops++;
  return header.ttl > 0;
}

class QrpTable {
  private bits: Uint8Array;
  private size: number = 65536;

  constructor() {
    this.bits = new Uint8Array(this.size / 8);
  }

  addFile(filename: string): void {
    const words = this.tokenize(filename);
    words.forEach((word) => this.addWord(word));
  }

  private tokenize(filename: string): string[] {
    return filename
      .toLowerCase()
      .split(/[\s\-_\.]+/)
      .filter((word) => word.length > 0);
  }

  private addWord(word: string): void {
    const normalized = word.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const hash = this.hash(normalized);
    const index = hash % this.size;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    this.bits[byteIndex] |= 1 << bitIndex;
  }

  private hash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Pre-rotate for better distribution
    return (h >>> 16) ^ (h & 0xffff);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }
}

function createSocketHandler(
  socket: any,
  onMessage: (msg: Message) => void,
  onError: (err: Error) => void,
  onClose: () => void
): SocketHandler {
  let buffer = Buffer.alloc(0);
  let inflater: any = null;
  let deflater: any = null;
  let compressionEnabled = false;

  const processBuffer = () => {
    while (buffer.length > 0) {
      const message = parseMessage(buffer);
      if (!message) break;

      const size = getMessageSize(message, buffer);
      if (size === 0 || buffer.length < size) break;

      log(`[SOCKET] Parsed message: ${message.type}, size: ${size}`);
      onMessage(message);
      buffer = buffer.slice(size);
    }
  };

  const handleData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processBuffer();
  };

  socket.on("data", (chunk: Buffer) => {
    if (!compressionEnabled || !inflater) {
      handleData(chunk);
    } else {
      inflater.write(chunk);
    }
  });

  socket.on("error", onError);
  socket.on("close", onClose);

  const send = (data: Buffer) => {
    if (!compressionEnabled || !deflater) {
      socket.write(data);
    } else {
      deflater.write(data);
      // Don't flush after every write - let the stream decide
    }
  };

  const enableCompression = () => {
    if (compressionEnabled) {
      log("[SOCKET] Compression already enabled");
      return;
    }
    log("[SOCKET] Enabling compression");
    compressionEnabled = true;

    inflater = createInflate();
    inflater.on("data", handleData);
    inflater.on("error", (err: Error) => {
      log("[SOCKET] Inflater error:", err);
      onError(err);
    });

    deflater = createDeflate({ flush: 2 }); // Z_SYNC_FLUSH
    deflater.on("data", (chunk: Buffer) => socket.write(chunk));
    deflater.on("error", (err: Error) => {
      log("[SOCKET] Deflater error:", err);
      onError(err);
    });
  };

  const close = () => {
    inflater?.end();
    deflater?.end();
    socket.destroy();
  };

  return { send, enableCompression, close };
}

function getMessageSize(message: Message, buffer: Buffer): number {
  if (message.type.startsWith("handshake_")) {
    const text = buffer.toString("ascii");
    const index = text.indexOf("\r\n\r\n");
    return index !== -1 ? index + 4 : 0;
  }

  return 23 + (message.header?.payloadLength || 0);
}

class GnutellaTestServer {
  private server: any;
  private connections: Map<string, Connection> = new Map();
  private headers: Record<string, string>;
  private localIp: string;
  private localPort: number;

  constructor(config: {
    headers: Record<string, string>;
    localIp: string;
    localPort: number;
  }) {
    this.headers = config.headers;
    this.localIp = config.localIp;
    this.localPort = config.localPort;
  }

  async start(port: number): Promise<void> {
    const net = await import("net");
    this.server = net.createServer((socket) => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server.listen(port, "0.0.0.0", resolve);
      this.server.once("error", reject);
    });
  }

  private handleConnection(socket: any): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`[SERVER] New incoming connection from ${id}`);

    const handler = createSocketHandler(
      socket,
      (msg) => this.handleMessage(id, msg),
      (err) => this.handleError(id, err),
      () => this.handleClose(id)
    );

    const connection: Connection = {
      id,
      socket,
      send: handler.send,
      handshake: false,
      compressed: false,
      isServer: true,
      enableCompression: handler.enableCompression,
    };

    this.connections.set(id, connection);
    log(`[SERVER] Added connection ${id} to server connections`);
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) {
      log(`[SERVER] Received message for unknown connection ${id}`);
      return;
    }

    log(`[SERVER] Received ${msg.type} from ${id}`);

    // Handle duplicate detection and hop accounting for routable messages
    if (
      msg.header &&
      ["ping", "pong", "query", "queryhits", "push"].includes(msg.type)
    ) {
      if (isDuplicate(msg.header)) {
        log(`[SERVER] Dropping duplicate ${msg.type} from ${id}`);
        return;
      }

      // Don't forward if TTL exhausted
      if (!adjustHopsAndTtl(msg.header)) {
        log(`[SERVER] Dropping ${msg.type} from ${id} - TTL exhausted`);
        return;
      }
    }

    switch (msg.type) {
      case "handshake_connect":
        log(`[SERVER] Received handshake connect from ${id}, sending OK`);

        // Check compression support
        const clientAcceptsDeflate =
          msg.headers["Accept-Encoding"]?.includes("deflate");
        const responseHeaders = { ...this.headers };

        if (clientAcceptsDeflate) {
          responseHeaders["Content-Encoding"] = "deflate";
        }

        conn.send(buildHandshake("GNUTELLA/0.6 200 OK", responseHeaders));
        break;

      case "handshake_ok":
        if (!conn.handshake) {
          log(`[SERVER] Handshake completed with ${id}`);
          conn.handshake = true;

          // Check if we should enable compression
          const shouldCompress =
            msg.headers["Content-Encoding"]?.includes("deflate") &&
            this.headers["Accept-Encoding"]?.includes("deflate");

          if (shouldCompress) {
            conn.enableCompression?.();
          }

          // Send QRP table after server handshake
          this.sendServerInitialMessages(conn);
        }
        break;

      case "ping":
        if (conn.handshake) {
          log(`[SERVER] Responding to PING from ${id} with PONG`);
          // Use ping.hops + 1 as TTL for the pong
          const pongTtl = Math.max(msg.header!.hops + 1, 7);
          conn.send(
            buildPong(
              msg.header!.descriptorId,
              this.localPort,
              this.localIp,
              0,
              0,
              pongTtl
            )
          );
        } else {
          log(`[SERVER] Ignoring PING from ${id} - handshake not complete`);
        }
        break;

      case "pong":
        log(
          `[SERVER] Received PONG from ${id}: ${msg.ipAddress}:${msg.port}`
        );
        break;

      case "query":
        log(
          `[SERVER] Query from ${id}: "${msg.searchCriteria}"`
        );
        if (msg.extensions) {
          log(`[SERVER] Query has extensions (GGEP/HUGE)`);
        }
        break;

      case "qrp_reset":
        log(
          `[SERVER] Received QRP RESET from ${id}, table size: ${msg.tableLength}`
        );
        break;

      case "qrp_patch":
        log(
          `[SERVER] Received QRP PATCH from ${id}, seq ${msg.seqNo}/${msg.seqCount}`
        );
        break;

      case "bye":
        log(
          `[SERVER] Received BYE from ${id}: ${msg.code} - ${msg.message}`
        );
        break;

      case "handshake_error":
        log(
          `[SERVER] Handshake error from ${id}: ${msg.code} - ${msg.message}`
        );
        break;

      default:
        log(`[SERVER] Unhandled message type: ${msg.type} from ${id}`);
    }
  }

  private handleError(id: string, error: Error): void {
    log(`[SERVER] Connection error ${id}:`, error.message);
    this.connections.delete(id);
    log(`[SERVER] Removed connection ${id} due to error`);
  }

  private handleClose(id: string): void {
    log(`[SERVER] Connection ${id} closed`);
    this.connections.delete(id);
    log(`[SERVER] Removed connection ${id}`);
  }

  private sendServerInitialMessages(conn: Connection): void {
    log(`[SERVER] Sending initial messages to ${conn.id}`);
    const qrp = new QrpTable();
    conn.send(buildQrpReset());
    log(`[SERVER] Sent QRP RESET to ${conn.id}`);
    conn.send(buildQrpPatch(1, 1, 1, qrp.toBuffer()));
    log(`[SERVER] Sent QRP PATCH to ${conn.id}`);
    conn.send(buildPing());
    log(`[SERVER] Sent PING to ${conn.id}`);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connections.forEach((conn) => {
        try {
          conn.send(buildBye(200, "Shutting down"));
        } catch (e) {
          // Socket might already be closed
        }
        conn.socket.destroy();
      });
      this.connections.clear();
      this.server.close(resolve);
    });
  }

  getActiveConnections(): number {
    return Array.from(this.connections.values()).filter((c) => c.handshake)
      .length;
  }
}

async function getPublicIp(): Promise<string> {
  try {
    const response = await fetch("https://wtfismyip.com/text");
    return (await response.text()).trim();
  } catch (error) {
    log("[MAIN] Failed to get public IP, using localhost");
    return "127.0.0.1";
  }
}

async function main() {
  log("[MAIN] Starting Gnutella v2 Test Rig Server...");
  const localIp = await getPublicIp();
  const localPort = DEFAULT_PORT;
  log(`[MAIN] Local IP: ${localIp}, Port: ${localPort}`);

  const headers = {
    "User-Agent": "GnutellaTestRig/0.1",
    "X-Ultrapeer": "False",
    "X-Query-Routing": "0.2",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${localIp}:${localPort}`,
    "Bye-Packet": "0.1",
  };

  const server = new GnutellaTestServer({ headers, localIp, localPort });
  await server.start(localPort);
  log(`[MAIN] Test server listening on ${localIp}:${localPort}`);
  log(`[MAIN] Waiting for client connections...`);

  // Status logging
  setInterval(() => {
    const activeConnections = server.getActiveConnections();
    log(`[STATUS] Active connections: ${activeConnections}`);
  }, 30000);

  process.on("SIGINT", async () => {
    log("\n[MAIN] Shutting down test server...");
    await server.stop();
    log("[MAIN] Shutdown complete");
    process.exit(0);
  });
}

main().catch(log);