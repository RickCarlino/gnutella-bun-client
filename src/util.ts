import { randomBytes } from "crypto";
import { createInflate, createDeflate } from "zlib";
import * as net from "net";
import {
  MESSAGE_TYPES,
  QRP_VARIANTS,
  seenMessages,
  MESSAGE_CACHE_TIME,
} from "./const";
import { Message, MessageHeader } from "./interfaces";

export const log = (...msgs: any[]) => console.log(...msgs);

export function readUInt32LE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

export function writeUInt32LE(
  buffer: Buffer,
  value: number,
  offset: number,
): void {
  buffer.writeUInt32LE(value, offset);
}

export function generateId(): Buffer {
  const id = randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

export function ipToBuffer(ip: string): Buffer {
  const buffer = Buffer.alloc(4);
  ip.split(".").forEach((part, i) => (buffer[i] = parseInt(part)));
  return buffer;
}

export function bufferToIp(buffer: Buffer, offset: number): string {
  return Array.from(buffer.slice(offset, offset + 4)).join(".");
}

export function buildHeader(
  type: number,
  payloadLength: number,
  ttl: number = 7,
  id?: Buffer,
): Buffer {
  const header = Buffer.alloc(23);
  (id || generateId()).copy(header, 0);
  header[16] = type;
  header[17] = ttl;
  header[18] = 0;
  writeUInt32LE(header, payloadLength, 19);
  return header;
}

export function buildHandshake(
  startLine: string,
  headers: Record<string, string>,
): Buffer {
  const lines = [startLine];
  Object.entries(headers).forEach(([key, value]) =>
    lines.push(`${key}: ${value}`),
  );
  lines.push(""); // Single blank line
  return Buffer.from(lines.join("\r\n") + "\r\n", "ascii");
}

export function buildPing(id?: Buffer, ttl: number = 7): Buffer {
  return buildHeader(MESSAGE_TYPES.PING, 0, ttl, id);
}

export function buildPong(
  pingId: Buffer,
  port: number,
  ip: string,
  files: number = 0,
  kb: number = 0,
  ttl?: number,
): Buffer {
  const payload = Buffer.alloc(14);
  payload.writeUInt16LE(port, 0);
  ipToBuffer(ip).copy(payload, 2);
  writeUInt32LE(payload, files, 6);
  writeUInt32LE(payload, kb, 10);

  const header = buildHeader(MESSAGE_TYPES.PONG, 14, ttl || 7, pingId);
  return Buffer.concat([header, payload]);
}

export function buildBye(code: number, message: string = ""): Buffer {
  const messageBuffer = Buffer.from(message, "utf8");
  const payload = Buffer.alloc(2 + messageBuffer.length);
  payload.writeUInt16LE(code, 0);
  messageBuffer.copy(payload, 2);

  const header = buildHeader(MESSAGE_TYPES.BYE, payload.length, 1);
  return Buffer.concat([header, payload]);
}

export function buildQrpReset(tableSize: number = 65536): Buffer {
  const payload = Buffer.alloc(6);
  payload[0] = QRP_VARIANTS.RESET;
  writeUInt32LE(payload, tableSize, 1);
  payload[5] = 1; // infinity flag must be 1 (0x01)

  const header = buildHeader(MESSAGE_TYPES.QRP, 6, 1);
  return Buffer.concat([header, payload]);
}

export function buildQrpPatch(
  seq: number,
  total: number,
  bits: number,
  data: Buffer,
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

export function parseMessage(buffer: Buffer): Message | null {
  const handshake = tryParseHandshake(buffer);
  if (handshake) return handshake;

  if (buffer.length < 23) return null;

  const header = parseHeader(buffer);
  if (!header) return null;

  if (buffer.length < 23 + header.payloadLength) return null;

  const payload = buffer.slice(23, 23 + header.payloadLength);
  return parsePayload(header, payload);
}

export function tryParseHandshake(buffer: Buffer): Message | null {
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

export function parseHeaders(lines: string[]): Record<string, string> {
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

export function parseHeader(buffer: Buffer): MessageHeader | null {
  return {
    descriptorId: buffer.slice(0, 16),
    payloadDescriptor: buffer[16],
    ttl: buffer[17],
    hops: buffer[18],
    payloadLength: readUInt32LE(buffer, 19),
  };
}

export function parsePayload(
  header: MessageHeader,
  payload: Buffer,
): Message | null {
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

export function isDuplicate(header: MessageHeader): boolean {
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

export function adjustHopsAndTtl(header: MessageHeader): boolean {
  if (header.ttl === 0) return false;
  header.ttl--;
  header.hops++;
  return header.ttl > 0;
}

export interface SocketHandlerResult {
  send: (data: Buffer) => void;
  enableCompression: () => void;
  close: () => void;
}

export function createSocketHandler(
  socket: any,
  onMessage: (msg: Message) => void,
  onError: (err: Error) => void,
  onClose: () => void,
): SocketHandlerResult {
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

export function getMessageSize(message: Message, buffer: Buffer): number {
  if (message.type.startsWith("handshake_")) {
    const text = buffer.toString("ascii");
    const index = text.indexOf("\r\n\r\n");
    return index !== -1 ? index + 4 : 0;
  }

  return 23 + (message.header?.payloadLength || 0);
}

export async function connect(ip: string, port: number): Promise<any> {
  return new Promise((resolve, reject) => {
    log(`[CONNECT] Attempting connection to ${ip}:${port}`);
    const socket = net.createConnection({ host: ip, port, timeout: 5000 });
    socket.once("connect", () => {
      log(`[CONNECT] Successfully connected to ${ip}:${port}`);
      resolve(socket);
    });
    socket.once("error", (err) => {
      log(`[CONNECT] Error connecting to ${ip}:${port}:`, err.message);
      reject(err);
    });
    socket.once("timeout", () => {
      log(`[CONNECT] Connection timeout to ${ip}:${port}`);
      socket.destroy();
      reject(new Error("Connection timeout"));
    });
  });
}

export async function getPublicIp(): Promise<string> {
  const response = await fetch("https://wtfismyip.com/text");
  return (await response.text()).trim();
}
