import net from "net";
import { GnutellaObject } from "./parser";
import { createSocketHandler, sendMessage } from "./utils/socket-handler";
import type { Sender } from "./types";

interface ConnectionConf {
  ip: string;
  port: number;
  onMessage: (send: Sender, message: GnutellaObject) => void;
  onError: (send: Sender, error: Error) => void;
  onClose: () => void;
}

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

  const send: Sender = (data) => sendMessage(socket, data);

  createSocketHandler({
    socket,
    onMessage: (message) => onMessage(send, message),
    onError: (error) => onError(send, error),
    onClose,
  });

  return socket;
};
