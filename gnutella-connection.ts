import net from "net";
import { GnutellaObject, parseGnutella } from "./parser";

type Sender = (message: Buffer) => void;
interface GnutellaConnectionConfig {
  ip: string;
  port: number;
  onMessage: (send: Sender, message: GnutellaObject) => void;
  onError: (send: Sender, error: Error) => void;
  onClose: () => void;
}

function getHandshakeMessageSize(buf: Buffer): number {
  const str = buf.toString("ascii");
  const v04End = str.indexOf("\n\n");

  if (v04End !== -1) {
    return v04End + 2;
  }

  const v06End = str.indexOf("\r\n\r\n");
  if (v06End !== -1) {
    return v06End + 4;
  }

  return 0; // Incomplete handshake message
}

function getBinaryMessageSize(parsed: GnutellaObject): number {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      throw new Error("Invalid message type for binary size calculation");
    default:
      return 23 + parsed.header.payloadLength;
  }
}

function getMessageSize(parsed: GnutellaObject, buf: Buffer): number {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      return getHandshakeMessageSize(buf);
    case "ping":
    case "pong":
    case "query":
    case "queryhits":
    case "push":
    case "bye":
      return getBinaryMessageSize(parsed);
    default:
      return 0;
  }
}

export const startConnection = (
  params: GnutellaConnectionConfig
): Promise<net.Socket> => {
  const { ip, port, onMessage, onError, onClose } = params;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port }, () => {
      console.log(`Connected to ${ip}:${port}`);

      const send: Sender = (data: Buffer) => {
        socket.write(data);
      };

      let leftover: Buffer | null = null;
      socket.on("data", (chunk: Buffer) => {
        console.log(chunk.toString("ascii"));
        try {
          let buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;

          // Try to parse complete messages
          while (buf.length) {
            const parsed = parseGnutella(buf);

            if (!parsed) {
              console.debug("...assembling incomplete message...");
              break;
            }

            const messageSize = getMessageSize(parsed, buf);

            if (messageSize === 0 || buf.length < messageSize) {
              console.debug("...waiting for more data...");
              break;
            }

            // Handle the parsed message
            onMessage(send, parsed);

            // Remove processed message from buffer
            buf = buf.subarray(messageSize);
          }

          leftover = buf.length > 0 ? buf : null;
        } catch (error) {
          onError(send, error as Error);
        }
      });

      socket.on("error", (error) => {
        onError(send, error);
        reject(error);
      });

      socket.on("close", () => {
        console.log(`Connection to ${ip}:${port} closed`);
        onClose();
      });

      resolve(socket);
    });
  });
};
