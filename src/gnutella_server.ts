import { Connection, Message } from "./interfaces";
import {
  log,
  createSocketHandler,
  buildHandshake,
  buildQrpReset,
  buildQrpPatch,
  buildPing,
} from "./util";
import { QrpTable } from "./qrp_table";

export class GnutellaServer {
  private server: any;
  private connections: Map<string, Connection> = new Map();
  private onMessage: (conn: Connection, msg: Message) => void;
  private headers: Record<string, string>;

  constructor(config: {
    onMessage: (conn: Connection, msg: Message) => void;
    headers: Record<string, string>;
  }) {
    this.onMessage = config.onMessage;
    this.headers = config.headers;
  }

  async start(port: number): Promise<void> {
    const net = await import("net");
    this.server = net.createServer((socket) => this.handleConnection(socket));

    return new Promise((resolve, reject) => {
      this.server.listen(port, "0.0.0.0", resolve);
      this.server.once("error", reject);
    });
  }

  private handleConnection(socket: any): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`[SERVER] New incoming connection from ${id}`);

    const handler = createSocketHandler(
      socket,
      (msg) => this.handleMessage(id, msg),
      (err) => this.handleError(id, err),
      () => this.handleClose(id),
    );

    const connection: Connection = {
      id,
      socket,
      send: handler.send,
      handshake: false,
      compressed: false,
      isServer: true,
      enableCompression: handler.enableCompression,
    };

    this.connections.set(id, connection);
    log(`[SERVER] Added connection ${id} to server connections`);
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) {
      log(`[SERVER] Received message for unknown connection ${id}`);
      return;
    }

    log(`[SERVER] Received ${msg.type} from ${id}`);

    if (msg.type === "handshake_connect") {
      log(`[SERVER] Received handshake connect from ${id}, sending OK`);

      // Check compression support
      const clientAcceptsDeflate =
        msg.headers["Accept-Encoding"]?.includes("deflate");
      const responseHeaders = { ...this.headers };

      if (clientAcceptsDeflate) {
        responseHeaders["Content-Encoding"] = "deflate";
      }

      conn.send(buildHandshake("GNUTELLA/0.6 200 OK", responseHeaders));
    }

    if (msg.type === "handshake_ok" && !conn.handshake) {
      log(`[SERVER] Handshake completed with ${id}`);
      conn.handshake = true;

      // Check if we should enable compression
      const shouldCompress =
        msg.headers["Content-Encoding"]?.includes("deflate") &&
        this.headers["Accept-Encoding"]?.includes("deflate");

      if (shouldCompress) {
        conn.enableCompression?.();
      }

      // Send QRP table after server handshake
      this.sendServerInitialMessages(conn);
    }

    this.onMessage(conn, msg);
  }

  private handleError(id: string, error: Error): void {
    log(`[SERVER] Connection error ${id}:`, error.message);
    this.connections.delete(id);
    log(`[SERVER] Removed connection ${id} due to error`);
  }

  private handleClose(id: string): void {
    log(`[SERVER] Connection ${id} closed`);
    this.connections.delete(id);
    log(`[SERVER] Removed connection ${id}`);
  }

  private sendServerInitialMessages(conn: Connection): void {
    log(`[SERVER] Sending initial messages to ${conn.id}`);
    const qrp = new QrpTable();
    conn.send(buildQrpReset());
    log(`[SERVER] Sent QRP RESET to ${conn.id}`);
    conn.send(buildQrpPatch(1, 1, 1, qrp.toBuffer()));
    log(`[SERVER] Sent QRP PATCH to ${conn.id}`);
    conn.send(buildPing());
    log(`[SERVER] Sent PING to ${conn.id}`);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.connections.forEach((conn) => conn.socket.destroy());
      this.connections.clear();
      this.server.close(resolve);
    });
  }
}
