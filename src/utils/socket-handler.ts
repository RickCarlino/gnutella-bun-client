import * as net from "net";
import { createBufferProcessor } from "./buffer-processor";
import type { GnutellaObject } from "../parser";

export type SocketHandlerOptions = {
  socket: net.Socket;
  onMessage: (message: GnutellaObject) => void;
  onError: (error: Error) => void;
  onClose: () => void;
};

export function createSocketHandler(options: SocketHandlerOptions): void {
  const { socket, onMessage, onError, onClose } = options;
  
  const processor = createBufferProcessor(onMessage, onError);

  socket.on("data", (chunk) => {
    processor.process(chunk);
  });

  socket.on("error", onError);
  socket.on("close", onClose);
}

export function sendMessage(socket: net.Socket, message: Buffer): void {
  socket.write(message);
}