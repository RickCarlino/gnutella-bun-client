export type HandshakeConnect = {
  type: "handshake_connect";
  version: string;
  headers?: Record<string, string>;
};

export type HandshakeOk = {
  type: "handshake_ok";
  version?: string;
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string>;
};

export type HandshakeError = {
  type: "handshake_error";
  code?: number;
  message: string;
  headers?: Record<string, string>;
};

export type DescriptorHeader = {
  descriptorId: Buffer;
  payloadDescriptor: number;
  ttl: number;
  hops: number;
  payloadLength: number;
};

export type Ping = {
  type: "ping";
  header: DescriptorHeader;
  data?: Buffer;
};

export type Pong = {
  type: "pong";
  header: DescriptorHeader;
  port: number;
  ipAddress: string;
  filesShared: number;
  kilobytesShared: number;
  data?: Buffer;
};

export type Query = {
  type: "query";
  header: DescriptorHeader;
  minimumSpeed: number;
  searchCriteria: string;
  data?: Buffer;
};

export type Result = {
  fileIndex: number;
  fileSize: number;
  fileName: string;
  data?: string;
};

export type QueryHits = {
  type: "queryhits";
  header: DescriptorHeader;
  numberOfHits: number;
  port: number;
  ipAddress: string;
  speed: number;
  results: Result[];
  qhdData?: Buffer;
  serventIdentifier: Buffer;
};

export type Push = {
  type: "push";
  header: DescriptorHeader;
  serventIdentifier: Buffer;
  fileIndex: number;
  ipAddress: string;
  port: number;
  data?: Buffer;
};

export type Bye = {
  type: "bye";
  header: DescriptorHeader;
  code: number;
  message: string;
  headers?: Record<string, string>;
};

export type QrpReset = {
  type: "qrp_reset";
  header: DescriptorHeader;
  variant: number;
  tableLength: number;
  infinity: number;
};

export type QrpPatch = {
  type: "qrp_patch";
  header: DescriptorHeader;
  variant: number;
  seqNo: number;
  seqCount: number;
  compression: number;
  entryBits: number;
  data: Buffer;
};

export type GGEPExtension = {
  id: string;
  data: Buffer;
  compressed: boolean;
  encoded: boolean;
};

export type GGEPBlock = {
  extensions: GGEPExtension[];
};

export type GnutellaObject =
  | HandshakeConnect
  | HandshakeOk
  | HandshakeError
  | Ping
  | Pong
  | Query
  | QueryHits
  | Push
  | Bye
  | QrpReset
  | QrpPatch;

export const QRP_DESCRIPTOR = 0x30;
export const QRP_VARIANT_RESET = 0x00;
export const QRP_VARIANT_PATCH = 0x01;

const generateDescriptorId = (): Buffer => {
  const id = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    id[i] = Math.floor(Math.random() * 256);
  }
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
};

const createDescriptorHeader = (
  payloadDescriptor: number,
  payloadLength: number,
  ttl: number,
  descriptorId?: Buffer
): Buffer => {
  const header = Buffer.alloc(23);
  (descriptorId && descriptorId.length === 16 ? descriptorId : generateDescriptorId()).copy(header, 0);
  header.writeUInt8(payloadDescriptor, 16);
  header.writeUInt8(ttl, 17);
  header.writeUInt8(0, 18);
  header.writeUInt32LE(payloadLength, 19);
  return header;
};

const createHandshakeMessage = (
  startLine: string,
  headers?: Record<string, string>
): Buffer => {
  let message = `${startLine}\r\n`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      message += `${key}: ${value}\r\n`;
    }
  }
  message += "\r\n";
  return Buffer.from(message, "ascii");
};

export const createHandshakeConnect = (headers?: Record<string, string>): Buffer => {
  return createHandshakeMessage("GNUTELLA CONNECT/0.6", headers);
};

export const createHandshakeOk = (headers?: Record<string, string>): Buffer => {
  return createHandshakeMessage("GNUTELLA/0.6 200 OK", headers);
};

export const createHandshakeError = (
  code: number,
  statusText: string,
  headers?: Record<string, string>
): Buffer => {
  return createHandshakeMessage(`GNUTELLA/0.6 ${code} ${statusText}`, headers);
};

export const createPing = (descriptorId?: Buffer, ttl: number = 7): Buffer => {
  return createDescriptorHeader(0x00, 0, ttl, descriptorId);
};

const writeIpAddress = (buffer: Buffer, ipAddress: string, offset: number) => {
  const ipParts = ipAddress.split(".").map(Number);
  if (ipParts.length === 4) {
    ipParts.forEach((part, i) => buffer.writeUInt8(part, offset + i));
  }
};

export const createPong = (
  descriptorId: Buffer,
  port: number,
  ipAddress: string,
  filesShared: number = 0,
  kilobytesShared: number = 0,
  ttl: number = 7
): Buffer => {
  const payload = Buffer.alloc(14);
  payload.writeUInt16LE(port, 0);
  writeIpAddress(payload, ipAddress, 2);
  payload.writeUInt32LE(filesShared, 6);
  payload.writeUInt32LE(kilobytesShared, 10);
  const header = createDescriptorHeader(0x01, 14, ttl, descriptorId);
  return Buffer.concat([header, payload]);
};

export const createQrpReset = (
  tableLength: number = 0,
  ttl: number = 1,
  descriptorId?: Buffer
): Buffer => {
  const payload = Buffer.alloc(6);
  payload.writeUInt8(QRP_VARIANT_RESET, 0);
  payload.writeUInt32LE(tableLength, 1);
  payload.writeUInt8(1, 5); // infinity flag
  const header = createDescriptorHeader(QRP_DESCRIPTOR, payload.length, ttl, descriptorId);
  return Buffer.concat([header, payload]);
};

export const createQrpPatch = (
  seqNo: number,
  seqCount: number,
  entryBits: number,
  data: Buffer,
  compression: number = 0,
  ttl: number = 1,
  descriptorId?: Buffer
): Buffer => {
  const payload = Buffer.alloc(5 + data.length);
  payload.writeUInt8(QRP_VARIANT_PATCH, 0);
  payload.writeUInt8(seqNo, 1);
  payload.writeUInt8(seqCount, 2);
  payload.writeUInt8(compression, 3);
  payload.writeUInt8(entryBits, 4);
  data.copy(payload, 5);
  const header = createDescriptorHeader(QRP_DESCRIPTOR, payload.length, ttl, descriptorId);
  return Buffer.concat([header, payload]);
};

export const createQuery = (
  searchCriteria: string,
  minimumSpeed: number = 0,
  descriptorId?: Buffer,
  ttl: number = 7
): Buffer => {
  const searchBytes = Buffer.from(searchCriteria, "utf8");
  const payloadLength = 2 + searchBytes.length + 1;
  const payload = Buffer.alloc(payloadLength);
  payload.writeUInt16LE(minimumSpeed, 0);
  searchBytes.copy(payload, 2);
  payload.writeUInt8(0, 2 + searchBytes.length);
  const header = createDescriptorHeader(0x80, payloadLength, ttl, descriptorId);
  return Buffer.concat([header, payload]);
};

const parseHeaders = (headerString: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  const lines = headerString.split("\r\n");
  for (const line of lines) {
    const parts = line.split(":");
    if (parts.length > 1) {
      const key = parts.shift()!.trim();
      const value = parts.join(":").trim();
      headers[key] = value;
    }
  }
  return headers;
};

const parseHandshake = (buffer: Buffer): HandshakeConnect | HandshakeOk | HandshakeError | null => {
  const message = buffer.toString("ascii");
  const headerEndIndex = message.indexOf("\r\n\r\n");
  if (headerEndIndex === -1) return null;

  const requestLineEndIndex = message.indexOf("\r\n");
  if (requestLineEndIndex === -1) return null;

  const requestLine = message.substring(0, requestLineEndIndex);
  const headerString = message.substring(requestLineEndIndex + 2, headerEndIndex);
  const headers = parseHeaders(headerString);

  const connectMatch = requestLine.match(/^GNUTELLA CONNECT\/(\d+\.\d+)$/);
  if (connectMatch) {
    return { type: "handshake_connect", version: connectMatch[1], headers };
  }

  const responseMatch = requestLine.match(/^GNUTELLA\/(\d+\.\d+) (\d{3}) (.*)$/);
  if (responseMatch) {
    const [, version, codeStr, statusMessage] = responseMatch;
    const statusCode = parseInt(codeStr, 10);
    if (statusCode === 200) {
      return { type: "handshake_ok", version, statusCode, statusMessage, headers };
    } else {
      return { type: "handshake_error", code: statusCode, message: statusMessage, headers };
    }
  }

  return null;
};

const parseDescriptorHeader = (buffer: Buffer, offset: number = 0): DescriptorHeader | null => {
  if (buffer.length < offset + 23) return null;
  return {
    descriptorId: buffer.subarray(offset, offset + 16),
    payloadDescriptor: buffer.readUInt8(offset + 16),
    ttl: buffer.readUInt8(offset + 17),
    hops: buffer.readUInt8(offset + 18),
    payloadLength: buffer.readUInt32LE(offset + 19),
  };
};

const readIpAddress = (payload: Buffer, offset: number): string => {
  return `${payload.readUInt8(offset)}.${payload.readUInt8(offset + 1)}.${payload.readUInt8(offset + 2)}.${payload.readUInt8(offset + 3)}`;
};

const parsePing = (header: DescriptorHeader, payload: Buffer): Ping => ({
  type: "ping",
  header,
  data: payload.length > 0 ? payload : undefined,
});

const parsePong = (header: DescriptorHeader, payload: Buffer): Pong | null => {
  if (payload.length < 14) return null;
  return {
    type: "pong",
    header,
    port: payload.readUInt16LE(0),
    ipAddress: readIpAddress(payload, 2),
    filesShared: payload.readUInt32LE(6),
    kilobytesShared: payload.readUInt32LE(10),
    data: payload.length > 14 ? payload.subarray(14) : undefined,
  };
};

const parseQuery = (header: DescriptorHeader, payload: Buffer): Query | null => {
  if (payload.length < 3) return null;
  const minimumSpeed = payload.readUInt16LE(0);
  const nullIndex = payload.indexOf(0, 2);
  if (nullIndex === -1) return null;
  const searchCriteria = payload.subarray(2, nullIndex).toString("utf8");
  const data = payload.length > nullIndex + 1 ? payload.subarray(nullIndex + 1) : undefined;
  return { type: "query", header, minimumSpeed, searchCriteria, data };
};

const parsePush = (header: DescriptorHeader, payload: Buffer): Push | null => {
  if (payload.length < 26) return null;
  return {
    type: "push",
    header,
    serventIdentifier: payload.subarray(0, 16),
    fileIndex: payload.readUInt32LE(16),
    ipAddress: readIpAddress(payload, 20),
    port: payload.readUInt16LE(24),
    data: payload.length > 26 ? payload.subarray(26) : undefined,
  };
};

const parseBye = (header: DescriptorHeader, payload: Buffer): Bye | null => {
  if (payload.length < 3) return null;
  const code = payload.readUInt16LE(0);
  const nullIndex = payload.indexOf(0, 2);
  if (nullIndex === -1) return null;
  const messageText = payload.subarray(2, nullIndex).toString("utf8");
  const [message, ...headerLines] = messageText.split("\r\n");
  const headers = parseHeaders(headerLines.join("\r\n"));
  return { type: "bye", header, code, message, headers };
};

const parseQrp = (header: DescriptorHeader, payload: Buffer): QrpReset | QrpPatch | null => {
  if (payload.length < 6) return null;
  const variant = payload.readUInt8(0);
  
  switch (variant) {
    case QRP_VARIANT_RESET:
      return {
        type: "qrp_reset",
        header,
        variant,
        tableLength: payload.readUInt32LE(1),
        infinity: payload.readUInt8(5)
      };
    case QRP_VARIANT_PATCH:
      if (payload.length < 5) return null;
      return {
        type: "qrp_patch",
        header,
        variant,
        seqNo: payload.readUInt8(1),
        seqCount: payload.readUInt8(2),
        compression: payload.readUInt8(3),
        entryBits: payload.readUInt8(4),
        data: payload.subarray(5)
      };
    default:
      return null;
  }
};

const parseQueryHits = (header: DescriptorHeader, payload: Buffer): QueryHits | null => {
  if (payload.length < 27) return null;
  const numberOfHits = payload.readUInt8(0);
  const port = payload.readUInt16LE(1);
  const ipAddress = readIpAddress(payload, 3);
  const speed = payload.readUInt32LE(7);
  const results: Result[] = [];
  let offset = 11;
  for (let i = 0; i < numberOfHits; i++) {
    if (offset + 8 >= payload.length - 16) return null;
    const fileIndex = payload.readUInt32LE(offset);
    const fileSize = payload.readUInt32LE(offset + 4);
    offset += 8;
    const nameEnd = payload.indexOf(0, offset);
    if (nameEnd === -1 || nameEnd >= payload.length - 16) return null;
    const fileName = payload.subarray(offset, nameEnd).toString("utf8");
    offset = nameEnd + 1;
    const dataEnd = payload.indexOf(0, offset);
    if (dataEnd === -1 || dataEnd >= payload.length - 16) return null;
    const resultData = offset < dataEnd ? payload.subarray(offset, dataEnd).toString("utf8") : undefined;
    offset = dataEnd + 1;
    results.push({ fileIndex, fileSize, fileName, data: resultData });
  }
  const serventIdStart = payload.length - 16;
  const qhdData = offset < serventIdStart ? payload.subarray(offset, serventIdStart) : undefined;
  const serventIdentifier = payload.subarray(serventIdStart);
  return { type: "queryhits", header, numberOfHits, port, ipAddress, speed, results, qhdData, serventIdentifier };
};

const parseDescriptor = (buffer: Buffer): GnutellaObject | null => {
  const header = parseDescriptorHeader(buffer);
  if (!header) return null;
  const payloadStart = 23;
  const payloadEnd = payloadStart + header.payloadLength;
  if (buffer.length < payloadEnd) return null;
  const payload = buffer.subarray(payloadStart, payloadEnd);
  switch (header.payloadDescriptor) {
    case 0x00: return parsePing(header, payload);
    case 0x01: return parsePong(header, payload);
    case 0x02: return parseBye(header, payload);
    case 0x30: return parseQrp(header, payload);
    case 0x40: return parsePush(header, payload);
    case 0x80: return parseQuery(header, payload);
    case 0x81: return parseQueryHits(header, payload);
    default: return null;
  }
};

export function parseGnutella(buffer: Buffer): GnutellaObject | null {
  return parseHandshake(buffer) || parseDescriptor(buffer);
}
