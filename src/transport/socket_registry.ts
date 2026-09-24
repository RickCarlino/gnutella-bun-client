import type net from "node:net";

/** Tracks sockets for ownership transfer and shutdown. */
export class SocketRegistry {
  private closed = false;
  private readonly sockets = new Map<net.Socket, () => void>();

  /** Track a socket or reject it after shutdown. */
  add(socket: net.Socket): net.Socket {
    if (this.closed) {
      socket.destroy();
      throw new Error("socket owner stopped");
    }
    if (this.sockets.has(socket)) return socket;
    const closed = () => this.release(socket);
    this.sockets.set(socket, closed);
    socket.once("close", closed);
    return socket;
  }

  /** Release ownership without closing the socket. */
  release(socket: net.Socket): void {
    const closed = this.sockets.get(socket);
    if (closed) socket.off("close", closed);
    this.sockets.delete(socket);
  }

  /** Destroy owned sockets and reject future additions. */
  close(): void {
    this.closed = true;
    for (const socket of this.sockets.keys()) {
      this.release(socket);
      socket.destroy();
    }
  }
}
