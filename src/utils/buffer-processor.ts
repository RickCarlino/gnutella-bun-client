import { parseGnutella } from "../parser";
import type { GnutellaObject } from "../parser";

export type BufferProcessor = {
  process: (chunk: Buffer) => void;
  getBuffer: () => Buffer;
};

export function createBufferProcessor(
  onMessage: (message: GnutellaObject) => void,
  onError: (error: Error) => void
): BufferProcessor {
  let buffer = Buffer.alloc(0);

  const processBuffer = () => {
    while (buffer.length > 0) {
      const parsed = parseGnutella(buffer);
      if (!parsed) break;

      const size = getMessageSize(parsed, buffer);
      if (size === 0 || buffer.length < size) break;

      onMessage(parsed);
      buffer = buffer.subarray(size);
    }
  };

  return {
    process: (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        processBuffer();
      } catch (e) {
        onError(e as Error);
      }
    },
    getBuffer: () => buffer,
  };
}

function getHandshakeSize(buffer: Buffer): number {
  const handshakeEnd = "\r\n\r\n";
  const index = buffer.toString("ascii").indexOf(handshakeEnd);
  return index !== -1 ? index + handshakeEnd.length : 0;
}

function getBinarySize(parsed: GnutellaObject): number {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      throw new Error("Invalid message type for binary size calculation");
    default:
      return 23 + parsed.header.payloadLength;
  }
}

function getMessageSize(message: GnutellaObject, buffer: Buffer): number {
  switch (message.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      return getHandshakeSize(buffer);
    default:
      return getBinarySize(message);
  }
}