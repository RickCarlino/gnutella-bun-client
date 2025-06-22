// Protocol Constants
const Protocol = {
  PORT: 6346,
  VERSION: "0.6",
  TTL: 7,
  HEADER_SIZE: 23,
  PONG_SIZE: 14,
  QUERY_HITS_FOOTER: 23,
  QRP_TABLE_SIZE: 8192,
  QRP_INFINITY: 7,
  HANDSHAKE_END: "\r\n\r\n",
};

const MessageType = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HITS: 0x81,
  ROUTE_TABLE_UPDATE: 0x30,
};

const QRPVariant = {
  RESET: 0,
  PATCH: 1,
};

// Core Types
interface MessageHeader {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
}

interface BaseMessage {
  type: string;
  header?: MessageHeader;
}

interface HandshakeConnectMessage extends BaseMessage {
  type: "handshake_connect";
  version: string;
  headers: Record<string, string>;
}

interface HandshakeOkMessage extends BaseMessage {
  type: "handshake_ok";
  version: string;
  statusCode: number;
  message: string;
  headers: Record<string, string>;
}

interface HandshakeErrorMessage extends BaseMessage {
  type: "handshake_error";
  code: number;
  message: string;
  headers: Record<string, string>;
}

interface PingMessage extends BaseMessage {
  type: "ping";
  header: MessageHeader;
}

interface PongMessage extends BaseMessage {
  type: "pong";
  header: MessageHeader;
  port: number;
  ipAddress: string;
  filesShared: number;
  kilobytesShared: number;
}

interface ByeMessage extends BaseMessage {
  type: "bye";
  header: MessageHeader;
  code: number;
  message: string;
}

interface QueryMessage extends BaseMessage {
  type: "query";
  header: MessageHeader;
  minimumSpeed: number;
  searchCriteria: string;
  extensions: Buffer | null;
}

interface QueryHitsMessage extends BaseMessage {
  type: "query_hits";
  header: MessageHeader;
  numberOfHits: number;
  port: number;
  ipAddress: string;
  speed: number;
  results: any[];
  vendorCode: Buffer;
  serventId: Buffer;
}

interface RouteTableUpdateMessage extends BaseMessage {
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

type Message =
  | HandshakeConnectMessage
  | HandshakeOkMessage
  | HandshakeErrorMessage
  | PingMessage
  | PongMessage
  | ByeMessage
  | QueryMessage
  | QueryHitsMessage
  | RouteTableUpdateMessage;

interface Connection {
  id: string;
  socket: any;
  send: (data: Buffer) => void;
  handshake: boolean;
  compressed: boolean;
  enableCompression?: () => void;
}

interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
}

interface FakeFile {
  filename: string;
  size: number;
  index: number;
  keywords: string[];
  sha1: Buffer;
}

// Binary Operations
class Binary {
  static readUInt32LE(buffer: Buffer, offset: number): number {
    return buffer.readUInt32LE(offset);
  }

  static writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
    buffer.writeUInt32LE(value, offset);
  }

  static ipToBuffer(ip: string): Buffer {
    const parts = ip.split(".");
    return Buffer.from(parts.map((p) => parseInt(p)));
  }

  static bufferToIp(buffer: Buffer, offset: number): string {
    return Array.from(buffer.slice(offset, offset + 4)).join(".");
  }
}

// ID Generation
class IDGenerator {
  static generate(): Buffer {
    const crypto = require("crypto");
    const id = crypto.randomBytes(16);
    id[8] = 0xff;
    id[15] = 0x00;
    return id;
  }

  static servent(): Buffer {
    return Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  }
}

// Hash Functions
class Hash {
  static qrp(str: string, bits: number): number {
    const A_INT = 1327217884;
    const bytes = new TextEncoder().encode(str.toLowerCase());

    let xor = 0;
    for (let i = 0; i < bytes.length; i++) {
      xor ^= bytes[i] << ((i & 3) * 8);
    }

    const prod = BigInt(xor >>> 0) * BigInt(A_INT);
    const mask = (1n << BigInt(bits)) - 1n;
    return Number((prod >> BigInt(32 - bits)) & mask) >>> 0;
  }

  static sha1(data: string): Buffer {
    const crypto = require("crypto");
    return crypto.createHash("sha1").update(data).digest();
  }

  static sha1ToBase32(sha1: Buffer): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    let bits = 0;
    let value = 0;

    for (const byte of sha1) {
      value = (value << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        result += chars[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      result += chars[(value << (5 - bits)) & 31];
    }

    return result.padEnd(32, "=");
  }

  static sha1ToUrn(sha1: Buffer): string {
    return `urn:sha1:${this.sha1ToBase32(sha1)}`;
  }
}

// Message Builders
class MessageBuilder {
  static header(
    type: number,
    payloadLength: number,
    ttl: number = Protocol.TTL,
    id?: Buffer
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
    return Buffer.from(lines.join("\r\n"), "ascii");
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
    ttl: number = Protocol.TTL
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
    files: FakeFile[],
    serventId: Buffer
  ): Buffer {
    const fileEntries = files.map((file) => this.fileEntry(file));
    const totalFileSize = fileEntries.reduce(
      (sum, entry) => sum + entry.length,
      0
    );
    const payloadSize = 11 + totalFileSize + Protocol.QUERY_HITS_FOOTER;

    const header = this.header(
      MessageType.QUERY_HITS,
      payloadSize,
      Protocol.TTL,
      queryId
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

  private static fileEntry(file: FakeFile): Buffer {
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

  private static queryHitHeader(
    fileCount: number,
    port: number,
    ip: string
  ): Buffer {
    const header = Buffer.alloc(11);

    header[0] = fileCount;
    header.writeUInt16LE(port, 1);
    Binary.ipToBuffer(ip).copy(header, 3);
    Binary.writeUInt32LE(header, 1000, 7);

    return header;
  }

  private static vendorCode(): Buffer {
    const code = Buffer.alloc(7);
    code.write("GBUN", 0, 4, "ascii");
    code[4] = 2;
    code[5] = 0;
    code[6] = 1;
    return code;
  }
}

// Message Parsers
class MessageParser {
  static parse(buffer: Buffer): Message | null {
    const handshake = this.parseHandshake(buffer);
    if (handshake) return handshake;

    if (buffer.length < Protocol.HEADER_SIZE) return null;

    const header = this.parseHeader(buffer);
    if (!header) return null;

    const totalSize = Protocol.HEADER_SIZE + header.payloadLength;
    if (buffer.length < totalSize) return null;

    const payload = buffer.slice(Protocol.HEADER_SIZE, totalSize);
    return this.parsePayload(header, payload);
  }

  static getMessageSize(message: Message, buffer: Buffer): number {
    if (message.type.startsWith("handshake_")) {
      const text = buffer.toString("ascii");
      const index = text.indexOf(Protocol.HANDSHAKE_END);
      return index !== -1 ? index + 4 : 0;
    }

    return Protocol.HEADER_SIZE + (message.header?.payloadLength || 0);
  }

  private static parseHandshake(buffer: Buffer): Message | null {
    const text = buffer.toString("ascii");
    const endIndex = text.indexOf(Protocol.HANDSHAKE_END);
    if (endIndex === -1) return null;

    const lines = text.substring(0, endIndex).split("\r\n");
    const startLine = lines[0];
    const headers = this.parseHeaders(lines.slice(1));

    if (startLine.startsWith("GNUTELLA CONNECT/")) {
      return {
        type: "handshake_connect",
        version: startLine.split("/")[1],
        headers,
      } as HandshakeConnectMessage;
    }

    if (startLine.startsWith("GNUTELLA/")) {
      const match = startLine.match(/GNUTELLA\/(\S+) (\d+) (.+)/);
      if (!match) return null;

      const [, version, code, message] = match;
      const statusCode = parseInt(code);

      if (statusCode === 200) {
        return {
          type: "handshake_ok",
          version,
          statusCode,
          message,
          headers,
        } as HandshakeOkMessage;
      }

      return {
        type: "handshake_error",
        code: statusCode,
        message,
        headers,
      } as HandshakeErrorMessage;
    }

    return null;
  }

  private static parseHeaders(lines: string[]): Record<string, string> {
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

  private static parseHeader(buffer: Buffer): MessageHeader {
    return {
      descriptorId: buffer.slice(0, 16),
      payloadDescriptor: buffer[16],
      ttl: buffer[17],
      hops: buffer[18],
      payloadLength: Binary.readUInt32LE(buffer, 19),
    };
  }

  private static parsePayload(
    header: MessageHeader,
    payload: Buffer
  ): Message | null {
    const parsers: Record<number, () => Message | null> = {
      [MessageType.PING]: () => ({ type: "ping", header } as PingMessage),

      [MessageType.PONG]: () => {
        if (payload.length < Protocol.PONG_SIZE) return null;
        return {
          type: "pong",
          header,
          port: payload.readUInt16LE(0),
          ipAddress: Binary.bufferToIp(payload, 2),
          filesShared: Binary.readUInt32LE(payload, 6),
          kilobytesShared: Binary.readUInt32LE(payload, 10),
        } as PongMessage;
      },

      [MessageType.BYE]: () => {
        if (payload.length < 2) return null;
        return {
          type: "bye",
          header,
          code: payload.readUInt16LE(0),
          message: payload.length > 2 ? payload.slice(2).toString("utf8") : "",
        } as ByeMessage;
      },

      [MessageType.QUERY]: () => {
        if (payload.length < 3) return null;
        const nullIndex = payload.indexOf(0, 2);
        if (nullIndex === -1) return null;

        return {
          type: "query",
          header,
          minimumSpeed: payload.readUInt16LE(0),
          searchCriteria: payload.slice(2, nullIndex).toString("utf8"),
          extensions:
            nullIndex < payload.length - 1
              ? payload.slice(nullIndex + 1)
              : null,
        } as QueryMessage;
      },

      [MessageType.QUERY_HITS]: () => {
        if (payload.length < 11) return null;
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
        } as QueryHitsMessage;
      },

      [MessageType.ROUTE_TABLE_UPDATE]: () => {
        const qrp = this.parseQRP(payload);
        return qrp ? ({ ...qrp, header } as RouteTableUpdateMessage) : null;
      },
    };

    const parser = parsers[header.payloadDescriptor];
    return parser ? parser() : null;
  }

  private static parseQRP(
    payload: Buffer
  ): Partial<RouteTableUpdateMessage> | null {
    if (payload.length < 1) return null;

    const variant = payload[0];

    if (variant === QRPVariant.RESET) {
      if (payload.length < 6) return null;
      return {
        type: "route_table_update",
        variant: "reset",
        tableLength: payload.readUInt32LE(1),
        infinity: payload[5],
      };
    }

    if (variant === QRPVariant.PATCH) {
      if (payload.length < 6) return null;
      return {
        type: "route_table_update",
        variant: "patch",
        seqNo: payload[1],
        seqSize: payload[2],
        compressor: payload[3],
        entryBits: payload[4],
        data: Buffer.from(payload.subarray(5)),
      };
    }

    return null;
  }
}

// QRP Manager
class QRPManager {
  private table: number[];
  private tableSize: number;
  private infinity: number;
  private fakeFiles: Map<number, FakeFile>;
  private fileCounter: number;

  constructor(
    tableSize: number = Protocol.QRP_TABLE_SIZE,
    infinity: number = Protocol.QRP_INFINITY
  ) {
    this.tableSize = tableSize;
    this.infinity = infinity;
    this.table = new Array(tableSize).fill(infinity);
    this.fakeFiles = new Map();
    this.fileCounter = 1;
  }

  addFile(filename: string, size: number, keywords: string[]): number {
    const index = this.fileCounter++;
    const sha1 = Hash.sha1(filename);

    this.fakeFiles.set(index, { filename, size, index, keywords, sha1 });
    this.updateTableForKeywords(keywords);

    return index;
  }

  removeFile(index: number): boolean {
    if (!this.fakeFiles.has(index)) return false;

    this.fakeFiles.delete(index);
    this.rebuildTable();

    return true;
  }

  getFiles(): FakeFile[] {
    return Array.from(this.fakeFiles.values());
  }

  getFile(index: number): FakeFile | undefined {
    return this.fakeFiles.get(index);
  }

  matchesQuery(searchCriteria: string): boolean {
    const keywords = this.extractKeywords(searchCriteria);
    return keywords.every((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      return this.table[hash] < this.infinity;
    });
  }

  getMatchingFiles(searchCriteria: string): FakeFile[] {
    const queryKeywords = this.extractKeywords(searchCriteria);

    return this.getFiles().filter((file) =>
      queryKeywords.every((queryKeyword) =>
        file.keywords.some((fileKeyword) =>
          fileKeyword.toLowerCase().includes(queryKeyword)
        )
      )
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
      1
    );
    return Buffer.concat([header, payload]);
  }

  async buildPatchMessage(): Promise<Buffer[]> {
    const zlib = await import("zlib");
    const { promisify } = await import("util");
    const deflate = promisify(zlib.deflate);

    const patchData = this.createPatchData();
    const compressed = await deflate(patchData);

    return this.createPatchChunks(compressed);
  }

  private updateTableForKeywords(keywords: string[]): void {
    keywords.forEach((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      this.table[hash] = 1;
    });
  }

  private rebuildTable(): void {
    this.table.fill(this.infinity);

    this.fakeFiles.forEach((file) => {
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
      const unsignedValue = value & 0xf;
      const byteIndex = Math.floor(i / 2);

      if (i % 2 === 0) {
        patchData[byteIndex] =
          (patchData[byteIndex] & 0x0f) | (unsignedValue << 4);
      } else {
        patchData[byteIndex] = (patchData[byteIndex] & 0xf0) | unsignedValue;
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
        1
      );
      return Buffer.concat([header, payload]);
    });
  }
}

// Peer Store
class PeerStore {
  private peers: Map<string, Peer>;
  private filename: string;

  constructor(filename: string = "settings.json") {
    this.peers = new Map();
    this.filename = filename;
  }

  async load(): Promise<void> {
    try {
      const { readFile } = await import("fs/promises");
      const data = await readFile(this.filename, "utf8");
      const parsed = JSON.parse(data);

      if (parsed.peers) {
        parsed.peers.forEach((p: Peer) => this.add(p.ip, p.port, p.lastSeen));
      }
    } catch {}
  }

  async save(): Promise<void> {
    try {
      const { readFile, writeFile } = await import("fs/promises");

      let existingData: any = {};
      try {
        const content = await readFile(this.filename, "utf8");
        existingData = JSON.parse(content);
      } catch {}

      existingData.peers = Array.from(this.peers.values());
      await writeFile(this.filename, JSON.stringify(existingData, null, 2));
    } catch {}
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

// Socket Handler
class SocketHandler {
  private socket: any;
  private buffer: Buffer;
  private inflater: any;
  private deflater: any;
  private compressionEnabled: boolean;
  private onMessage: (msg: Message) => void;
  private onError: (err: Error) => void;
  private onClose: () => void;

  constructor(
    socket: any,
    onMessage: (msg: Message) => void,
    onError: (err: Error) => void,
    onClose: () => void
  ) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.compressionEnabled = false;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onClose = onClose;

    this.setupEventHandlers();
  }

  send(data: Buffer): void {
    if (!this.compressionEnabled || !this.deflater) {
      this.socket.write(data);
    } else {
      this.deflater.write(data);
    }
  }

  enableCompression(): void {
    if (this.compressionEnabled) return;

    this.compressionEnabled = true;
    this.setupCompression();
  }

  close(): void {
    this.inflater?.end();
    this.deflater?.end();
    this.socket.destroy();
  }

  private setupEventHandlers(): void {
    this.socket.on("data", (chunk: Buffer) => {
      if (!this.compressionEnabled || !this.inflater) {
        this.handleData(chunk);
      } else {
        this.inflater.write(chunk);
      }
    });

    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  private setupCompression(): void {
    const zlib = require("zlib");

    this.inflater = zlib.createInflate();
    this.inflater.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.inflater.on("error", this.onError);

    this.deflater = zlib.createDeflate({ flush: zlib.Z_SYNC_FLUSH });
    this.deflater.on("data", (chunk: Buffer) => this.socket.write(chunk));
    this.deflater.on("error", this.onError);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.processBuffer();
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const message = MessageParser.parse(this.buffer);
      if (!message) break;

      const size = MessageParser.getMessageSize(message, this.buffer);
      if (size === 0 || this.buffer.length < size) break;

      this.onMessage(message);
      this.buffer = this.buffer.slice(size);
    }
  }
}

// Message Router
class MessageRouter {
  private ttlCheck(header?: MessageHeader): boolean {
    if (!header || header.ttl === 0) return false;

    header.ttl--;
    header.hops++;

    return header.ttl >= 0;
  }

  route(
    conn: Connection,
    msg: Message,
    context: {
      localIp: string;
      localPort: number;
      qrpManager: QRPManager;
      peerStore: PeerStore;
      serventId: Buffer;
    }
  ): void {
    const handlers: Record<string, () => void> = {
      handshake_connect: () =>
        this.handleHandshakeConnect(
          conn,
          msg as HandshakeConnectMessage,
          context
        ),
      handshake_ok: () =>
        this.handleHandshakeOk(conn, msg as HandshakeOkMessage, context),
      ping: () => this.handlePing(conn, msg as PingMessage, context),
      pong: () => this.handlePong(conn, msg as PongMessage, context),
      query: () => this.handleQuery(conn, msg as QueryMessage, context),
      bye: () => {},
      handshake_error: () => {},
      route_table_update: () => {},
    };

    const handler = handlers[msg.type];
    if (handler) handler();
  }

  private handleHandshakeConnect(
    conn: Connection,
    msg: HandshakeConnectMessage,
    context: any
  ): void {
    const clientAcceptsDeflate =
      msg.headers["Accept-Encoding"]?.includes("deflate");
    const responseHeaders = this.buildResponseHeaders(
      context,
      clientAcceptsDeflate
    );

    conn.send(
      MessageBuilder.handshake(
        `GNUTELLA/${Protocol.VERSION} 200 OK`,
        responseHeaders
      )
    );
  }

  private handleHandshakeOk(
    conn: Connection,
    msg: HandshakeOkMessage,
    context: any
  ): void {
    if (!conn.handshake) {
      conn.handshake = true;

      const shouldCompress =
        msg.headers["Content-Encoding"]?.includes("deflate") &&
        this.buildResponseHeaders(context, false)["Accept-Encoding"]?.includes(
          "deflate"
        );

      if (shouldCompress && conn.enableCompression) {
        conn.enableCompression();
      }

      conn.send(MessageBuilder.ping());

      setTimeout(async () => {
        await this.sendQRPTable(conn, context.qrpManager);
      }, 1000);
    }
  }

  private handlePing(conn: Connection, msg: PingMessage, context: any): void {
    if (!conn.handshake) return;

    const pongTtl = Math.max(msg.header.hops + 1, Protocol.TTL);
    conn.send(
      MessageBuilder.pong(
        msg.header.descriptorId,
        context.localPort,
        context.localIp,
        0,
        0,
        pongTtl
      )
    );
  }

  private handlePong(_conn: Connection, msg: PongMessage, context: any): void {
    context.peerStore.add(msg.ipAddress, msg.port);
  }

  private handleQuery(conn: Connection, msg: QueryMessage, context: any): void {
    if (!this.ttlCheck(msg.header)) return;

    if (context.qrpManager.matchesQuery(msg.searchCriteria)) {
      const matchingFiles = context.qrpManager.getMatchingFiles(
        msg.searchCriteria
      );

      if (matchingFiles.length > 0) {
        const queryHit = MessageBuilder.queryHit(
          msg.header.descriptorId,
          context.localPort,
          context.localIp,
          matchingFiles,
          context.serventId
        );

        conn.send(queryHit);
      }
    }
  }

  private buildResponseHeaders(
    context: any,
    clientAcceptsDeflate: boolean
  ): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": "GnutellaBun/0.1",
      "X-Ultrapeer": "False",
      "X-Query-Routing": "0.2",
      "Accept-Encoding": "deflate",
      "Listen-IP": `${context.localIp}:${context.localPort}`,
      "Bye-Packet": "0.1",
    };

    if (clientAcceptsDeflate) {
      headers["Content-Encoding"] = "deflate";
    }

    return headers;
  }

  private async sendQRPTable(
    conn: Connection,
    qrpManager: QRPManager
  ): Promise<void> {
    try {
      conn.send(qrpManager.buildResetMessage());

      const patchMessages = await qrpManager.buildPatchMessage();
      patchMessages.forEach((msg) => conn.send(msg));
    } catch {}
  }
}

// Server
class GnutellaServer {
  private server: any;
  private connections: Map<string, Connection>;
  private router: MessageRouter;
  private context: any;

  constructor(context: any) {
    this.connections = new Map();
    this.router = new MessageRouter();
    this.context = context;
  }

  async start(port: number): Promise<void> {
    const net = await import("net");

    this.server = net.createServer((socket) => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server.listen(port, "0.0.0.0", resolve);
      this.server.once("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connections.forEach((conn) => conn.socket.destroy());
      this.connections.clear();
      this.server.close(resolve);
    });
  }

  private handleConnection(socket: any): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;

    const handler = new SocketHandler(
      socket,
      (msg) => this.handleMessage(id, msg),
      (err) => this.handleError(id, err),
      () => this.handleClose(id)
    );

    const connection: Connection = {
      id,
      socket,
      send: (data) => handler.send(data),
      handshake: false,
      compressed: false,
      enableCompression: () => handler.enableCompression(),
    };

    this.connections.set(id, connection);
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    this.router.route(conn, msg, this.context);
  }

  private handleError(id: string, error: Error): void {
    this.connections.delete(id);
    console.error(`Error on connection ${id}:`, error);
  }

  private handleClose(id: string): void {
    this.connections.delete(id);
  }
}

// Main Application
class GnutellaNode {
  private server: GnutellaServer | null = null;
  private peerStore: PeerStore;
  private qrpManager: QRPManager;
  private context: any;

  constructor() {
    this.peerStore = new PeerStore();
    this.qrpManager = new QRPManager();
  }

  async start(): Promise<void> {
    const localIp = await this.getPublicIp();
    const localPort = Protocol.PORT;
    const serventId = IDGenerator.servent();

    this.context = {
      localIp,
      localPort,
      peerStore: this.peerStore,
      qrpManager: this.qrpManager,
      serventId,
    };

    await this.peerStore.load();
    this.setupFakeFiles();

    this.server = new GnutellaServer(this.context);
    await this.server.start(localPort);

    this.setupPeriodicTasks();
    this.setupShutdownHandler();
  }

  private async getPublicIp(): Promise<string> {
    const response = await fetch("https://wtfismyip.com/text");
    return (await response.text()).trim();
  }

  private setupFakeFiles(): void {
    this.qrpManager.addFile("01jyasqdtf0rq0q6wh2ns90ems.mp3", 5000000, [
      "01jyasqdtf0rq0q6wh2ns90ems",
      "mp3",
    ]);

    this.qrpManager.addFile("music.mp3", 3000000, ["music", "song", "mp3"]);

    this.qrpManager.addFile("movie.avi", 700000000, [
      "movie",
      "film",
      "video",
      "avi",
    ]);
  }

  private setupPeriodicTasks(): void {
    setInterval(() => this.peerStore.save(), 60000);
    setInterval(() => this.peerStore.prune(), 3600000);
  }

  private setupShutdownHandler(): void {
    process.on("SIGINT", async () => {
      await this.server?.stop();
      await this.peerStore.save();
      process.exit(0);
    });
  }
}

// Entry Point
async function main() {
  const node = new GnutellaNode();
  await node.start();
}

main().catch(console.error);

// Exports
export const KNOWN_CACHE_LIST = [
  "http://cache.jayl.de/g2/gwc.php",
  "http://cache.jayl.de/g2/gwc.php/",
  "http://gweb.4octets.co.uk/skulls.php",
  "http://gweb3.4octets.co.uk/gwc.php",
  "http://gweb4.4octets.co.uk/",
  "http://midian.jayl.de/g2/bazooka.php",
  "http://midian.jayl.de/g2/gwc.php",
  "http://p2p.findclan.net/skulls.php",
  "http://paper.gwc.dyslexicfish.net:3709/",
  "http://rock.gwc.dyslexicfish.net:3709/",
  "http://scissors.gwc.dyslexicfish.net:3709/",
  "http://skulls.gwc.dyslexicfish.net/skulls.php",
];
