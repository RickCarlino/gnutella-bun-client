import net from "net";
import { GnutellaObject, parseGnutella } from "./parser";

type Sender = (message: Buffer) => void;

interface ConnectionConf {
  ip: string;
  port: number;
  onMessage: (send: Sender, message: GnutellaObject) => void;
  onError: (send: Sender, error: Error) => void;
  onClose: () => void;
}

const handshakeSize = (buf: Buffer): number => {
  const s = buf.toString("ascii");
  const v06 = s.indexOf("\r\n\r\n");
  if (v06 !== -1) return v06 + 4;
  return 0;
};

function binarySize(parsed: GnutellaObject): number {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      throw new Error("Invalid message type for binary size calculation");
    default:
      return 23 + parsed.header.payloadLength;
  }
}

const messageSize = (m: GnutellaObject, buf: Buffer): number =>
  ["handshake_connect", "handshake_ok", "handshake_error"].includes(m.type)
    ? handshakeSize(buf)
    : binarySize(m);

export const startConnection = (conf: ConnectionConf): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const { ip, port, onMessage, onError, onClose } = conf;
    const socket = net.createConnection({ host: ip, port }, () => {
      const send: Sender = (data) => socket.write(data);
      let buf = Buffer.alloc(0);

      const process = () => {
        while (buf.length) {
          const parsed = parseGnutella(buf);
          if (!parsed) return;
          const size = messageSize(parsed, buf);
          if (size === 0 || buf.length < size) return;
          onMessage(send, parsed);
          buf = buf.subarray(size);
        }
      };

      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          process();
        } catch (e) {
          onError(send, e as Error);
        }
      });

      socket.on("error", (e) => {
        onError(send, e);
        reject(e);
      });

      socket.on("close", onClose);

      resolve(socket);
    });
  });
