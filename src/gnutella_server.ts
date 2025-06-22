import { Connection, Message } from "./core_types";
import { SocketHandler } from "./socket_handler";
import { MessageRouter } from "./message_router";
import type { Server as NetServer, Socket } from "net";
import { NodeContext } from "./context";

export class GnutellaServer {
  private server: NetServer | null = null;
  private connections: Map<string, Connection>;
  private router: MessageRouter;
  private context: NodeContext;

  constructor(context: NodeContext) {
    this.connections = new Map();
    this.router = new MessageRouter();
    this.context = context;
  }

  async start(port: number): Promise<void> {
    const net = await import("net");

    this.server = net.createServer((socket) => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server!.listen(port, "0.0.0.0", resolve);
      this.server!.once("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connections.forEach((conn) => conn.socket.destroy());
      this.connections.clear();
      this.server!.close(() => resolve());
    });
  }

  private handleConnection(socket: Socket): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;

    const handler = new SocketHandler(
      socket,
      (msg) => this.handleMessage(id, msg),
      (err) => this.handleError(id, err),
      () => this.handleClose(id),
    );

    const connection: Connection = {
      id,
      socket,
      send: (data) => handler.send(data),
      handshake: false,
      compressed: false,
      enableCompression: () => handler.enableCompression(),
    };

    this.connections.set(id, connection);
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) return;

    this.router.route(conn, msg, this.context);
  }

  private handleError(id: string, error: Error): void {
    this.connections.delete(id);
    console.error(`Error on connection ${id}:`, error);
  }

  private handleClose(id: string): void {
    this.connections.delete(id);
  }
}
