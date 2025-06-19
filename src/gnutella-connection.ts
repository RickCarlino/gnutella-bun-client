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

const getHandshakeSize = (buffer: Buffer): number => {
  const handshakeEnd = "\r\n\r\n";
  const index = buffer.toString("ascii").indexOf(handshakeEnd);
  return index !== -1 ? index + handshakeEnd.length : 0;
};

const getBinarySize = (parsed: GnutellaObject): number => {
  if ("header" in parsed) {
    return 23 + parsed.header.payloadLength;
  }
  throw new Error("Invalid message type for binary size calculation");
};

const getMessageSize = (message: GnutellaObject, buffer: Buffer): number => {
  const isHandshake = ["handshake_connect", "handshake_ok", "handshake_error"].includes(message.type);
  return isHandshake ? getHandshakeSize(buffer) : getBinarySize(message);
};

const connectSocket = (ip: string, port: number): Promise<net.Socket> => {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: ip, port, timeout: 5000 });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => reject(err));
    socket.once("timeout", () => reject(new Error(`Connection timeout to ${ip}:${port}`)));
  });
};

export const startConnection = async (conf: ConnectionConf): Promise<net.Socket> => {
  const { ip, port, onMessage, onError, onClose } = conf;
  const socket = await connectSocket(ip, port);

  const send: Sender = (data) => socket.write(data);
  let buffer = Buffer.alloc(0);

  const processBuffer = () => {
    while (buffer.length > 0) {
      const parsed = parseGnutella(buffer);
      if (!parsed) break;

      const size = getMessageSize(parsed, buffer);
      if (size === 0 || buffer.length < size) break;

      onMessage(send, parsed);
      buffer = buffer.subarray(size);
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      processBuffer();
    } catch (e) {
      onError(send, e as Error);
    }
  });

  socket.on("error", (err) => onError(send, err));
  socket.on("close", onClose);

  return socket;
};
