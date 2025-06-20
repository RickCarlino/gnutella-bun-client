import net from "net";
import { GnutellaObject } from "./parser";
import { createCompressedSocketHandler, CompressionState } from "./utils/compressed-socket-handler";
import { connectSocket } from "./utils/socket-utils";
import type { Sender } from "./types";

interface ConnectionConf {
  ip: string;
  port: number;
  onMessage: (send: Sender, message: GnutellaObject) => void;
  onError: (send: Sender, error: Error) => void;
  onClose: () => void;
}


export interface CompressedConnection {
  socket: net.Socket;
  send: Sender;
  compressionState: CompressionState;
  completeHandshake: () => void;
}

export const startCompressedConnection = async (conf: ConnectionConf): Promise<CompressedConnection> => {
  const { ip, port, onMessage, onError, onClose } = conf;
  const socket = await connectSocket(ip, port);

  const { send, compressionState, completeHandshake } = createCompressedSocketHandler({
    socket,
    onMessage: (message) => onMessage(send, message),
    onError: (error) => onError(send, error),
    onClose,
    isServer: false,
  });

  return { socket, send, compressionState, completeHandshake };
};