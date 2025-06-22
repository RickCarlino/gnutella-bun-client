import { Protocol, MessageType, QRPVariant } from "./constants";
import { Binary } from "./binary";
import {
  Message,
  HandshakeConnectMessage,
  HandshakeOkMessage,
  HandshakeErrorMessage,
  PingMessage,
  PongMessage,
  ByeMessage,
  QueryMessage,
  QueryHitsMessage,
  RouteTableUpdateMessage,
  MessageHeader,
} from "./core_types";

export class MessageParser {
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
    payload: Buffer,
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
    payload: Buffer,
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
