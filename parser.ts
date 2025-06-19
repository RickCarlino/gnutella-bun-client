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
  | Bye;

export function parseXTryHeader(
  header: string
): Array<{ host: string; port: number }> {
  const hosts: Array<{ host: string; port: number }> = [];
  const items = header.split(",");

  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;

    const lastColon = trimmed.lastIndexOf(":");
    if (lastColon > 0) {
      const host = trimmed.substring(0, lastColon);
      const port = parseInt(trimmed.substring(lastColon + 1), 10);
      if (!isNaN(port)) {
        hosts.push({ host, port });
      }
    }
  }

  return hosts;
}

export function createHandshakeConnect(
  headers?: Record<string, string>
): Buffer {
  let message = `GNUTELLA CONNECT/0.6\r\n`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      message += `${key}: ${value}\r\n`;
    }
  }
  message += "\r\n";
  return Buffer.from(message, "ascii");
}

export function createHandshakeOk(
  headers?: Record<string, string>
): Buffer {
  let message = `GNUTELLA/0.6 200 OK\r\n`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      message += `${key}: ${value}\r\n`;
    }
  }
  message += "\r\n";
  return Buffer.from(message, "ascii");
}

export function createHandshakeError(
  code: number,
  statusText: string,
  headers?: Record<string, string>
): Buffer {
  let message = `GNUTELLA/0.6 ${code} ${statusText}\r\n`;
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      message += `${key}: ${value}\r\n`;
    }
  }
  message += "\r\n";
  return Buffer.from(message, "ascii");
}

export function createPing(descriptorId?: Buffer, ttl: number = 7): Buffer {
  const header = Buffer.alloc(23);

  if (descriptorId && descriptorId.length === 16) {
    descriptorId.copy(header, 0);
  } else {
    for (let i = 0; i < 16; i++) {
      header[i] = Math.floor(Math.random() * 256);
    }
    header[8] = 0xff;
    header[15] = 0x00;
  }

  header.writeUInt8(0x00, 16);

  header.writeUInt8(ttl, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(0, 19);

  return header;
}

export function createPong(
  descriptorId: Buffer,
  port: number,
  ipAddress: string,
  filesShared: number = 0,
  kilobytesShared: number = 0,
  ttl: number = 7
): Buffer {
  const header = Buffer.alloc(23);
  const payload = Buffer.alloc(14);

  descriptorId.copy(header, 0);

  header[8] = 0xff;
  header[15] = 0x00;

  header.writeUInt8(0x01, 16);

  header.writeUInt8(ttl, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(14, 19);

  payload.writeUInt16LE(port, 0);

  const ipParts = ipAddress.split(".").map(Number);
  if (ipParts.length === 4) {
    payload.writeUInt8(ipParts[0], 2);
    payload.writeUInt8(ipParts[1], 3);
    payload.writeUInt8(ipParts[2], 4);
    payload.writeUInt8(ipParts[3], 5);
  }

  payload.writeUInt32LE(filesShared, 6);

  payload.writeUInt32LE(kilobytesShared, 10);

  return Buffer.concat([header, payload]);
}

export function createQuery(
  searchCriteria: string,
  minimumSpeed: number = 0,
  descriptorId?: Buffer,
  ttl: number = 7
): Buffer {
  const searchBytes = Buffer.from(searchCriteria, "utf8");
  const payloadLength = 2 + searchBytes.length + 1;

  const header = Buffer.alloc(23);
  const payload = Buffer.alloc(payloadLength);

  if (descriptorId && descriptorId.length === 16) {
    descriptorId.copy(header, 0);
  } else {
    for (let i = 0; i < 16; i++) {
      header[i] = Math.floor(Math.random() * 256);
    }
    header[8] = 0xff;
    header[15] = 0x00;
  }

  header.writeUInt8(0x80, 16);

  header.writeUInt8(ttl, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(payloadLength, 19);

  payload.writeUInt16LE(minimumSpeed, 0);

  searchBytes.copy(payload, 2);

  payload.writeUInt8(0, 2 + searchBytes.length);

  return Buffer.concat([header, payload]);
}

export function createQueryHits(
  queryDescriptorId: Buffer,
  port: number,
  ipAddress: string,
  speed: number,
  results: Array<{ fileIndex: number; fileSize: number; fileName: string }>,
  serventIdentifier: Buffer,
  ttl: number = 7
): Buffer {
  const header = Buffer.alloc(23);
  const resultsBuffers: Buffer[] = [];

  let resultsSize = 0;
  for (const result of results) {
    const nameBytes = Buffer.from(result.fileName, "utf8");
    resultsSize += 8 + nameBytes.length + 2;

    const resultBuffer = Buffer.alloc(8 + nameBytes.length + 2);
    resultBuffer.writeUInt32LE(result.fileIndex, 0);
    resultBuffer.writeUInt32LE(result.fileSize, 4);
    nameBytes.copy(resultBuffer, 8);
    resultBuffer.writeUInt8(0, 8 + nameBytes.length);
    resultBuffer.writeUInt8(0, 8 + nameBytes.length + 1);

    resultsBuffers.push(resultBuffer);
  }

  const payloadLength = 11 + resultsSize + 16;
  const payload = Buffer.alloc(payloadLength);

  queryDescriptorId.copy(header, 0);

  header.writeUInt8(0x81, 16);

  header.writeUInt8(ttl, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(payloadLength, 19);

  payload.writeUInt8(results.length, 0);

  payload.writeUInt16LE(port, 1);

  const ipParts = ipAddress.split(".").map(Number);
  if (ipParts.length === 4) {
    payload.writeUInt8(ipParts[0], 3);
    payload.writeUInt8(ipParts[1], 4);
    payload.writeUInt8(ipParts[2], 5);
    payload.writeUInt8(ipParts[3], 6);
  }

  payload.writeUInt32LE(speed, 7);

  let offset = 11;
  for (const resultBuffer of resultsBuffers) {
    resultBuffer.copy(payload, offset);
    offset += resultBuffer.length;
  }

  serventIdentifier.copy(payload, payloadLength - 16);

  return Buffer.concat([header, payload]);
}

export function createPush(
  serventIdentifier: Buffer,
  fileIndex: number,
  ipAddress: string,
  port: number,
  descriptorId?: Buffer,
  ttl: number = 7
): Buffer {
  const header = Buffer.alloc(23);
  const payload = Buffer.alloc(26);

  if (descriptorId && descriptorId.length === 16) {
    descriptorId.copy(header, 0);
  } else {
    for (let i = 0; i < 16; i++) {
      header[i] = Math.floor(Math.random() * 256);
    }
    header[8] = 0xff;
    header[15] = 0x00;
  }

  header.writeUInt8(0x40, 16);

  header.writeUInt8(ttl, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(26, 19);

  serventIdentifier.copy(payload, 0);

  payload.writeUInt32LE(fileIndex, 16);

  const ipParts = ipAddress.split(".").map(Number);
  if (ipParts.length === 4) {
    payload.writeUInt8(ipParts[0], 20);
    payload.writeUInt8(ipParts[1], 21);
    payload.writeUInt8(ipParts[2], 22);
    payload.writeUInt8(ipParts[3], 23);
  }

  payload.writeUInt16LE(port, 24);

  return Buffer.concat([header, payload]);
}

export function createBye(
  code: number,
  message: string,
  descriptorId?: Buffer,
  headers?: Record<string, string>
): Buffer {
  const header = Buffer.alloc(23);

  let fullMessage = message;
  if (headers && Object.keys(headers).length > 0) {
    fullMessage += "\r\n";
    for (const [key, value] of Object.entries(headers)) {
      fullMessage += `${key}: ${value}\r\n`;
    }
    fullMessage += "\r\n";
  }

  const messageBytes = Buffer.from(fullMessage + "\0", "utf8");
  const payloadLength = 2 + messageBytes.length;
  const payload = Buffer.alloc(payloadLength);

  if (descriptorId && descriptorId.length === 16) {
    descriptorId.copy(header, 0);
  } else {
    for (let i = 0; i < 16; i++) {
      header[i] = Math.floor(Math.random() * 256);
    }
    header[8] = 0xff;
    header[15] = 0x00;
  }

  header.writeUInt8(0x02, 16);

  header.writeUInt8(1, 17);

  header.writeUInt8(0, 18);

  header.writeUInt32LE(payloadLength, 19);

  payload.writeUInt16LE(code, 0);

  messageBytes.copy(payload, 2);

  return Buffer.concat([header, payload]);
}

function parseGGEPLength(
  buffer: Buffer,
  offset: number
): { length: number; bytesUsed: number } | null {
  let length = 0;
  let bytesUsed = 0;
  let shift = 0;

  while (offset + bytesUsed < buffer.length) {
    const byte = buffer[offset + bytesUsed];
    bytesUsed++;

    const hasMore = (byte & 0x80) !== 0;
    const isLast = (byte & 0x40) !== 0;
    const value = byte & 0x3f;

    length |= value << shift;
    shift += 6;

    if (isLast) {
      return { length, bytesUsed };
    }

    if (!hasMore) {
      return null;
    }

    if (bytesUsed > 3) {
      return null;
    }
  }

  return null;
}

export function parseGGEP(buffer: Buffer, offset: number): GGEPBlock | null {
  if (offset >= buffer.length || buffer[offset] !== 0xc3) {
    return null;
  }

  const extensions: GGEPExtension[] = [];
  let pos = offset + 1;

  while (pos < buffer.length) {
    if (pos >= buffer.length) break;

    const flags = buffer[pos];
    pos++;

    const isLast = (flags & 0x80) !== 0;
    const encoded = (flags & 0x40) !== 0;
    const compressed = (flags & 0x20) !== 0;
    const idLength = flags & 0x0f;

    if (idLength === 0 || pos + idLength > buffer.length) {
      return null;
    }

    const id = buffer.subarray(pos, pos + idLength).toString("latin1");
    pos += idLength;

    const lengthInfo = parseGGEPLength(buffer, pos);
    if (
      !lengthInfo ||
      pos + lengthInfo.bytesUsed + lengthInfo.length > buffer.length
    ) {
      return null;
    }

    pos += lengthInfo.bytesUsed;

    const data = buffer.subarray(pos, pos + lengthInfo.length);
    pos += lengthInfo.length;

    extensions.push({ id, data, compressed, encoded });

    if (isLast) {
      break;
    }
  }

  return { extensions };
}

export function createGGEP(
  extensions: Array<{
    id: string;
    data: Buffer;
    compressed?: boolean;
    encoded?: boolean;
  }>
): Buffer {
  const chunks: Buffer[] = [Buffer.from([0xc3])];

  for (let i = 0; i < extensions.length; i++) {
    const ext = extensions[i];
    const isLast = i === extensions.length - 1;

    let flags = 0;
    if (isLast) flags |= 0x80;
    if (ext.encoded) flags |= 0x40;
    if (ext.compressed) flags |= 0x20;

    const idBytes = Buffer.from(ext.id, "latin1");
    if (idBytes.length === 0 || idBytes.length > 15) {
      throw new Error("Invalid GGEP extension ID length");
    }
    flags |= idBytes.length & 0x0f;

    chunks.push(Buffer.from([flags]));
    chunks.push(idBytes);

    const dataLength = ext.data.length;
    if (dataLength <= 63) {
      chunks.push(Buffer.from([0x40 | dataLength]));
    } else if (dataLength <= 4095) {
      chunks.push(
        Buffer.from([
          0x80 | ((dataLength >> 6) & 0x3f),
          0x40 | (dataLength & 0x3f),
        ])
      );
    } else if (dataLength <= 262143) {
      chunks.push(
        Buffer.from([
          0x80 | ((dataLength >> 12) & 0x3f),
          0x80 | ((dataLength >> 6) & 0x3f),
          0x40 | (dataLength & 0x3f),
        ])
      );
    } else {
      throw new Error("GGEP data too large");
    }

    chunks.push(ext.data);
  }

  return Buffer.concat(chunks);
}

export function parseGnutella(buffer: Buffer): GnutellaObject | null {
  const parseDescriptorHeader = (
    offset: number = 0
  ): DescriptorHeader | null => {
    if (buffer.length < offset + 23) {
      return null;
    }

    return {
      descriptorId: buffer.subarray(offset, offset + 16),
      payloadDescriptor: buffer.readUInt8(offset + 16),
      ttl: buffer.readUInt8(offset + 17),
      hops: buffer.readUInt8(offset + 18),
      payloadLength: buffer.readUInt32LE(offset + 19),
    };
  };

  const parseIPAddress = (payload: Buffer, offset: number): string => {
    return [
      payload.readUInt8(offset),
      payload.readUInt8(offset + 1),
      payload.readUInt8(offset + 2),
      payload.readUInt8(offset + 3),
    ].join(".");
  };

  const parsePing = (header: DescriptorHeader, payload: Buffer): Ping => ({
    type: "ping",
    header,
    data: payload.length > 0 ? payload : undefined,
  });

  const parsePong = (
    header: DescriptorHeader,
    payload: Buffer
  ): Pong | null => {
    if (payload.length < 14) {
      return null;
    }

    return {
      type: "pong",
      header,
      port: payload.readUInt16LE(0),
      ipAddress: parseIPAddress(payload, 2),
      filesShared: payload.readUInt32LE(6),
      kilobytesShared: payload.readUInt32LE(10),
      data: payload.length > 14 ? payload.subarray(14) : undefined,
    };
  };

  const parseQuery = (
    header: DescriptorHeader,
    payload: Buffer
  ): Query | null => {
    if (payload.length < 3) {
      return null;
    }

    const minimumSpeed = payload.readUInt16LE(0);
    const nullIndex = payload.indexOf(0, 2);
    if (nullIndex === -1) {
      return null;
    }

    const searchCriteria = payload.subarray(2, nullIndex).toString("utf8");
    let data: Buffer | undefined;

    if (payload.length > nullIndex + 1) {
      const extensionData = payload.subarray(nullIndex + 1);

      if (extensionData.length > 0 && extensionData[0] === 0xc3) {
        data = extensionData;
      } else {
        data = extensionData;
      }
    }

    return {
      type: "query",
      header,
      minimumSpeed,
      searchCriteria,
      data,
    };
  };

  const parseQueryHits = (
    header: DescriptorHeader,
    payload: Buffer
  ): QueryHits | null => {
    if (payload.length < 27) {
      return null;
    }

    const numberOfHits = payload.readUInt8(0);
    const port = payload.readUInt16LE(1);
    const ipAddress = parseIPAddress(payload, 3);
    const speed = payload.readUInt32LE(7);

    const results: Result[] = [];
    let offset = 11;

    for (let i = 0; i < numberOfHits; i++) {
      if (offset + 8 >= payload.length - 16) {
        return null;
      }

      const fileIndex = payload.readUInt32LE(offset);
      const fileSize = payload.readUInt32LE(offset + 4);
      offset += 8;

      const nameEnd = payload.indexOf(0, offset);
      if (nameEnd === -1 || nameEnd >= payload.length - 16) {
        return null;
      }

      const fileName = payload.subarray(offset, nameEnd).toString("utf8");
      offset = nameEnd + 1;

      const dataEnd = payload.indexOf(0, offset);
      if (dataEnd === -1 || dataEnd >= payload.length - 16) {
        return null;
      }

      const resultData =
        offset < dataEnd
          ? payload.subarray(offset, dataEnd).toString("utf8")
          : undefined;
      offset = dataEnd + 1;

      results.push({
        fileIndex,
        fileSize,
        fileName,
        data: resultData,
      });
    }

    const serventIdStart = payload.length - 16;
    const qhdData =
      offset < serventIdStart
        ? payload.subarray(offset, serventIdStart)
        : undefined;
    const serventIdentifier = payload.subarray(serventIdStart);

    return {
      type: "queryhits",
      header,
      numberOfHits,
      port,
      ipAddress,
      speed,
      results,
      qhdData,
      serventIdentifier,
    };
  };

  const parsePush = (
    header: DescriptorHeader,
    payload: Buffer
  ): Push | null => {
    if (payload.length < 26) {
      return null;
    }

    return {
      type: "push",
      header,
      serventIdentifier: payload.subarray(0, 16),
      fileIndex: payload.readUInt32LE(16),
      ipAddress: parseIPAddress(payload, 20),
      port: payload.readUInt16LE(24),
      data: payload.length > 26 ? payload.subarray(26) : undefined,
    };
  };

  const parseBye = (header: DescriptorHeader, payload: Buffer): Bye | null => {
    if (payload.length < 3) {
      return null;
    }

    const code = payload.readUInt16LE(0);
    const messageStart = 2;
    const nullIndex = payload.indexOf(0, messageStart);

    if (nullIndex === -1) {
      return null;
    }

    const messageText = payload
      .subarray(messageStart, nullIndex)
      .toString("utf8");

    let message = messageText;
    let headers: Record<string, string> | undefined;

    if (messageText.includes("\r\n")) {
      const lines = messageText.split("\r\n");
      message = lines[0];

      if (lines.length > 2) {
        headers = {};
        for (let i = 1; i < lines.length - 1; i++) {
          const colonIndex = lines[i].indexOf(":");
          if (colonIndex > 0) {
            const key = lines[i].substring(0, colonIndex).trim();
            const value = lines[i].substring(colonIndex + 1).trim();
            headers[key] = value;
          }
        }
      }
    }

    return {
      type: "bye",
      header,
      code,
      message,
      headers,
    };
  };

  const parseDescriptor = (
    offset: number = 0
  ): Ping | Pong | Query | QueryHits | Push | Bye | null => {
    const header = parseDescriptorHeader(offset);
    if (!header) {
      return null;
    }

    const payloadStart = offset + 23;
    const payloadEnd = payloadStart + header.payloadLength;

    if (buffer.length < payloadEnd) {
      return null;
    }

    const payload = buffer.subarray(payloadStart, payloadEnd);

    switch (header.payloadDescriptor) {
      case 0x00:
        return parsePing(header, payload);
      case 0x01:
        return parsePong(header, payload);
      case 0x02:
        return parseBye(header, payload);
      case 0x80:
        return parseQuery(header, payload);
      case 0x81:
        return parseQueryHits(header, payload);
      case 0x40:
        return parsePush(header, payload);
      default:
        return null;
    }
  };

  const parseHandshake = ():
    | HandshakeConnect
    | HandshakeOk
    | HandshakeError
    | null => {
    const message = buffer.toString("ascii");


    const v06ConnectMatch = message.match(/^GNUTELLA CONNECT\/(\d+\.\d+)\r\n/);
    if (v06ConnectMatch) {
      const version = v06ConnectMatch[1];
      const headers: Record<string, string> = {};

      const headerSection = message.substring(v06ConnectMatch[0].length);
      const headerEnd = headerSection.indexOf("\r\n\r\n");

      if (headerEnd !== -1) {
        const headerLines = headerSection.substring(0, headerEnd).split("\r\n");
        for (const line of headerLines) {
          const colonIndex = line.indexOf(":");
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            headers[key] = value;
          }
        }
      }

      return {
        type: "handshake_connect",
        version,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      };
    }

    const v06ResponseMatch = message.match(
      /^GNUTELLA\/(\d+\.\d+) (\d{3}) (.*)\r\n/
    );
    if (v06ResponseMatch) {
      const version = v06ResponseMatch[1];
      const code = parseInt(v06ResponseMatch[2], 10);
      const statusText = v06ResponseMatch[3];
      const headers: Record<string, string> = {};

      const headerSection = message.substring(v06ResponseMatch[0].length);
      const headerEnd = headerSection.indexOf("\r\n\r\n");

      if (headerEnd !== -1) {
        const headerLines = headerSection.substring(0, headerEnd).split("\r\n");
        for (const line of headerLines) {
          const colonIndex = line.indexOf(":");
          if (colonIndex > 0) {
            const key = line.substring(0, colonIndex).trim();
            const value = line.substring(colonIndex + 1).trim();
            headers[key] = value;
          }
        }
      }

      if (code === 200) {
        return {
          type: "handshake_ok",
          version,
          statusCode: code,
          statusMessage: statusText,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        };
      } else {
        return {
          type: "handshake_error",
          code,
          message: statusText,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        };
      }
    }


    return null;
  };

  return parseHandshake() || parseDescriptor();
}
