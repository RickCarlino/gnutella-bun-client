import { createDeflate, createInflate } from "node:zlib";
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

interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

interface Connection {
  id: string;
  socket: any;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
}

interface SocketHandler {
  send: (data: Buffer) => void;
  enableCompression: () => void;
  close: () => void;
}

const DEFAULT_PORT = 6346;
const TARGET_CONNECTIONS = 8;
const HANDSHAKE_TIMEOUT = 5000;
const CONNECTION_CHECK_INTERVAL = 10000;
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

function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value, offset);
}

function generateId(): Buffer {
  const id = Buffer.alloc(16);
  crypto.getRandomValues(id);
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
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "ascii");
}

function buildPing(id?: Buffer, ttl: number = 7): Buffer {
  return buildHeader(MESSAGE_TYPES.PING, 0, ttl, id);
}

function buildPong(
  pingId: Buffer,
  port: number,
  ip: string,
  files: number = 0,
  kb: number = 0
): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt16LE(port, 0);
  ipToBuffer(ip).copy(payload, 2);
  writeUInt32LE(payload, files, 6);
  writeUInt32LE(payload, kb, 10);

  const header = buildHeader(MESSAGE_TYPES.PONG, 14, 7, pingId);
  return Buffer.concat([header, payload]);
}

function buildQrpReset(tableSize: number = 65536): Buffer {
  const payload = Buffer.alloc(6);
  payload[0] = QRP_VARIANTS.RESET;
  writeUInt32LE(payload, tableSize, 1);
  payload[5] = 1;

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

    case MESSAGE_TYPES.QUERY:
      if (payload.length < 3) return null;
      const nullIndex = payload.indexOf(0, 2);
      if (nullIndex === -1) return null;
      return {
        type: "query",
        header,
        minimumSpeed: payload.readUInt16LE(0),
        searchCriteria: payload.slice(2, nullIndex).toString("utf8"),
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
    return h & 0xffff;
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

      console.log(`[SOCKET] Parsed message: ${message.type}, size: ${size}`);
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
      deflater.flush();
    }
  };

  const enableCompression = () => {
    if (compressionEnabled) {
      console.log("[SOCKET] Compression already enabled");
      return;
    }
    console.log("[SOCKET] Enabling compression");
    compressionEnabled = true;

    inflater = createInflate();
    inflater.on("data", handleData);
    inflater.on("error", (err: Error) => {
      console.error("[SOCKET] Inflater error:", err);
      onError(err);
    });

    deflater = createDeflate();
    deflater.on("data", (chunk: Buffer) => socket.write(chunk));
    deflater.on("error", (err: Error) => {
      console.error("[SOCKET] Deflater error:", err);
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

class PeerStore {
  private peers: Map<string, Peer> = new Map();
  private filename: string = "peers.json";

  async load(): Promise<void> {
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(this.filename, "utf8");
      const parsed = JSON.parse(data);
      parsed.peers?.forEach((p: Peer) => this.add(p.ip, p.port, p.lastSeen));
    } catch {}
  }

  async save(): Promise<void> {
    const { writeFile } = await import("node:fs/promises");
    const data = { peers: Array.from(this.peers.values()) };
    await writeFile(this.filename, JSON.stringify(data, null, 2));
  }

  add(ip: string, port: number, lastSeen: number = Date.now()): void {
    this.peers.set(`${ip}:${port}`, { ip, port, lastSeen });
  }

  remove(ip: string, port: number): void {
    this.peers.delete(`${ip}:${port}`);
  }

  get(count: number): Peer[] {
    return Array.from(this.peers.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, count);
  }

  prune(maxAge: number = 3600000): void {
    const cutoff = Date.now() - maxAge;
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(key);
      }
    });
  }
}

async function connect(ip: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    console.log(`[CONNECT] Attempting connection to ${ip}:${port}`);
    const socket = net.createConnection({ host: ip, port, timeout: 5000 });
    socket.once("connect", () => {
      console.log(`[CONNECT] Successfully connected to ${ip}:${port}`);
      resolve(socket);
    });
    socket.once("error", (err) => {
      console.error(
        `[CONNECT] Error connecting to ${ip}:${port}:`,
        err.message
      );
      reject(err);
    });
    socket.once("timeout", () => {
      console.error(`[CONNECT] Connection timeout to ${ip}:${port}`);
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

class ConnectionPool {
  private connections: Map<string, Connection> = new Map();
  private targetCount: number;
  private onMessage: (conn: Connection, msg: Message) => void;
  private headers: Record<string, string>;

  constructor(config: {
    targetCount: number;
    onMessage: (conn: Connection, msg: Message) => void;
    headers: Record<string, string>;
    localIp: string;
    localPort: number;
  }) {
    this.targetCount = config.targetCount;
    this.onMessage = config.onMessage;
    this.headers = config.headers;
  }

  async connectToPeer(ip: string, port: number): Promise<void> {
    const id = `${ip}:${port}`;
    if (this.connections.has(id)) {
      console.log(`[POOL] Connection to ${id} already exists, skipping`);
      return;
    }

    try {
      const socket = await connect(ip, port);
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
      };

      this.connections.set(id, connection);
      console.log(`[POOL] Added connection ${id} to pool, sending handshake`);
      handler.send(buildHandshake("GNUTELLA CONNECT/0.6", this.headers));

      setTimeout(() => {
        if (!connection.handshake) {
          console.warn(
            `[POOL] Handshake timeout for ${id}, closing connection`
          );
          handler.close();
          this.connections.delete(id);
        }
      }, HANDSHAKE_TIMEOUT);
    } catch (error) {
      console.error(`[POOL] Failed to connect to ${id}:`, error);
    }
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) {
      console.warn(`[POOL] Received message for unknown connection ${id}`);
      return;
    }

    console.log(`[POOL] Received ${msg.type} from ${id}`);

    if (msg.type === "handshake_ok" && !conn.handshake) {
      console.log(
        `[POOL] Handshake successful with ${id}, sending OK response`
      );
      conn.handshake = true;
      conn.send(buildHandshake("GNUTELLA/0.6 200 OK", this.headers));
      this.sendInitialMessages(conn);
    }

    this.onMessage(conn, msg);
  }

  private handleError(id: string, error: Error): void {
    console.error(`[POOL] Connection error ${id}:`, error.message);
    this.connections.delete(id);
    console.log(`[POOL] Removed connection ${id} from pool due to error`);
  }

  private handleClose(id: string): void {
    console.log(`[POOL] Connection ${id} closed`);
    this.connections.delete(id);
    console.log(`[POOL] Removed connection ${id} from pool`);
  }

  private sendInitialMessages(conn: Connection): void {
    console.log(`[POOL] Sending initial messages to ${conn.id}`);
    const qrp = new QrpTable();
    conn.send(buildQrpReset());
    console.log(`[POOL] Sent QRP RESET to ${conn.id}`);
    conn.send(buildQrpPatch(1, 1, 1, qrp.toBuffer()));
    console.log(`[POOL] Sent QRP PATCH to ${conn.id}`);
    conn.send(buildPing());
    console.log(`[POOL] Sent PING to ${conn.id}`);
  }

  getActiveCount(): number {
    return Array.from(this.connections.values()).filter((c) => c.handshake)
      .length;
  }

  needsConnections(): boolean {
    return this.getActiveCount() < this.targetCount;
  }

  close(): void {
    this.connections.forEach((conn) => conn.socket.destroy());
    this.connections.clear();
  }
}

class GnutellaServer {
  private server: any;
  private connections: Map<string, Connection> = new Map();
  private onMessage: (conn: Connection, msg: Message) => void;
  private headers: Record<string, string>;

  constructor(config: {
    onMessage: (conn: Connection, msg: Message) => void;
    headers: Record<string, string>;
  }) {
    this.onMessage = config.onMessage;
    this.headers = config.headers;
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
    console.log(`[SERVER] New incoming connection from ${id}`);

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
    };

    this.connections.set(id, connection);
    console.log(`[SERVER] Added connection ${id} to server connections`);
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) {
      console.warn(`[SERVER] Received message for unknown connection ${id}`);
      return;
    }

    console.log(`[SERVER] Received ${msg.type} from ${id}`);

    if (msg.type === "handshake_connect") {
      console.log(`[SERVER] Received handshake connect from ${id}, sending OK`);
      conn.send(buildHandshake("GNUTELLA/0.6 200 OK", this.headers));
    }

    if (msg.type === "handshake_ok" && !conn.handshake) {
      console.log(`[SERVER] Handshake completed with ${id}`);
      conn.handshake = true;
    }

    this.onMessage(conn, msg);
  }

  private handleError(id: string, error: Error): void {
    console.error(`[SERVER] Connection error ${id}:`, error.message);
    this.connections.delete(id);
    console.log(`[SERVER] Removed connection ${id} due to error`);
  }

  private handleClose(id: string): void {
    console.log(`[SERVER] Connection ${id} closed`);
    this.connections.delete(id);
    console.log(`[SERVER] Removed connection ${id}`);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connections.forEach((conn) => conn.socket.destroy());
      this.connections.clear();
      this.server.close(resolve);
    });
  }
}

async function getPublicIp(): Promise<string> {
  const response = await fetch("https://wtfismyip.com/text");
  return (await response.text()).trim();
}

async function main() {
  console.log("[MAIN] Starting Gnutella v2 protocol client...");
  const localIp = await getPublicIp();
  const localPort = DEFAULT_PORT;
  console.log(`[MAIN] Local IP: ${localIp}, Port: ${localPort}`);

  const headers = {
    "User-Agent": "GnutellaBun/0.1",
    "X-Ultrapeer": "True",
    "X-Query-Routing": "0.2",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${localIp}:${localPort}`,
  };

  const peerStore = new PeerStore();
  await peerStore.load();

  const handleMessage = (conn: Connection, msg: Message) => {
    console.log(`[MAIN] Processing ${msg.type} from ${conn.id}`);
    switch (msg.type) {
      case "ping":
        if (conn.handshake) {
          console.log(`[MAIN] Responding to PING from ${conn.id} with PONG`);
          conn.send(buildPong(msg.header!.descriptorId, localPort, localIp));
        } else {
          console.warn(
            `[MAIN] Ignoring PING from ${conn.id} - handshake not complete`
          );
        }
        break;

      case "pong":
        console.log(
          `[MAIN] Received PONG from ${conn.id}: ${msg.ipAddress}:${msg.port}`
        );
        peerStore.add(msg.ipAddress, msg.port);
        console.log(`[MAIN] Added peer ${msg.ipAddress}:${msg.port} to store`);
        break;

      case "query":
        console.log(`[MAIN] Query from ${conn.id}: "${msg.searchCriteria}"`);
        break;

      case "qrp_reset":
        console.log(
          `[MAIN] Received QRP RESET from ${conn.id}, table size: ${msg.tableLength}`
        );
        break;

      case "qrp_patch":
        console.log(
          `[MAIN] Received QRP PATCH from ${conn.id}, seq ${msg.seqNo}/${msg.seqCount}`
        );
        break;

      default:
        console.log(
          `[MAIN] Unhandled message type: ${msg.type} from ${conn.id}`
        );
    }
  };

  const server = new GnutellaServer({ onMessage: handleMessage, headers });
  await server.start(localPort);
  console.log(`[MAIN] Server listening on ${localIp}:${localPort}`);

  const pool = new ConnectionPool({
    targetCount: TARGET_CONNECTIONS,
    onMessage: handleMessage,
    headers,
    localIp,
    localPort,
  });

  const maintainConnections = async () => {
    const activeCount = pool.getActiveCount();
    console.log(
      `[MAINTAIN] Active connections: ${activeCount}/${TARGET_CONNECTIONS}`
    );

    if (!pool.needsConnections()) {
      console.log(`[MAINTAIN] Target connections reached, skipping`);
      return;
    }

    const peers = peerStore.get(10);
    console.log(`[MAINTAIN] Found ${peers.length} peers in store`);

    for (const peer of peers) {
      console.log(
        `[MAINTAIN] Attempting to connect to ${peer.ip}:${peer.port}`
      );
      await pool.connectToPeer(peer.ip, peer.port);
      if (!pool.needsConnections()) break;
    }
  };

  setInterval(maintainConnections, CONNECTION_CHECK_INTERVAL);
  setInterval(() => {
    console.log("[MAIN] Saving peer store...");
    peerStore.save();
  }, 60000);
  setInterval(() => {
    console.log("[MAIN] Pruning old peers...");
    peerStore.prune();
  }, 3600000);

  await maintainConnections();

  process.on("SIGINT", async () => {
    console.log("\n[MAIN] Shutting down...");
    console.log("[MAIN] Closing connection pool...");
    pool.close();
    console.log("[MAIN] Stopping server...");
    await server.stop();
    console.log("[MAIN] Saving peer store...");
    await peerStore.save();
    console.log("[MAIN] Shutdown complete");
    process.exit(0);
  });
}

main().catch(console.error);
