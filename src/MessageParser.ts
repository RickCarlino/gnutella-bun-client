import { Binary } from "./binary";
import { Protocol } from "./const";
import {
  ByeMessage,
  GnutellaMessage,
  HandshakeConnectMessage,
  HandshakeErrorMessage,
  HandshakeOkMessage,
  MessageHeader,
  MessageType,
  PongMessage,
  PushMessage,
  QueryHitsMessage,
  QueryMessage,
} from "./types";

export class MessageParser {
  static parse(buffer: Buffer): GnutellaMessage | null {
    const handshake = this.parseHandshake(buffer);
    if (handshake) {
      return handshake;
    }

    if (buffer.length < Protocol.HEADER_SIZE) {
      return null;
    }

    const header = this.parseHeader(buffer);
    if (!header) {
      return null;
    }

    const totalSize = Protocol.HEADER_SIZE + header.payloadLength;
    if (buffer.length < totalSize) {
      return null;
    }

    const payload = buffer.slice(Protocol.HEADER_SIZE, totalSize);
    return this.parsePayload(header, payload);
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
      return {
        type: "handshake_connect",
        version: startLine.split("/")[1],
        headers,
      };
    }

    if (startLine.startsWith("GNUTELLA/")) {
      const match = startLine.match(/GNUTELLA\/(\S+) (\d+) (.+)/);
      if (!match) {
        return null;
      }

      const [, version, code, message] = match;
      const statusCode = parseInt(code);

      return statusCode === 200
        ? { type: "handshake_ok", version, statusCode, message, headers }
        : { type: "handshake_error", code: statusCode, message, headers };
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
}
