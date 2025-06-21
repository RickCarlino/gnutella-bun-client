import { Connection, Message } from "./interfaces";
import { HANDSHAKE_TIMEOUT } from "./const";
import {
  log,
  connect,
  createSocketHandler,
  buildHandshake,
  buildBye,
  buildQrpReset,
  buildQrpPatch,
  buildPing,
} from "./util";
import { QrpTable } from "./qrp_table";

export class ConnectionPool {
  private connections: Map<string, Connection> = new Map();
  private targetCount: number;
  private onMessage: (conn: Connection, msg: Message) => void;
  private headers: Record<string, string>;
  private vendorHeaders: Record<string, string>;

  constructor(config: {
    targetCount: number;
    onMessage: (conn: Connection, msg: Message) => void;
    headers: Record<string, string>;
    localIp: string;
    localPort: number;
  }) {
    this.targetCount = config.targetCount;
    this.onMessage = config.onMessage;
    this.headers = config.headers;

    // Vendor headers for second handshake
    this.vendorHeaders = {
      "User-Agent": config.headers["User-Agent"],
      "X-Ultrapeer": config.headers["X-Ultrapeer"],
      "Bye-Packet": config.headers["Bye-Packet"],
    };
  }

  async connectToPeer(ip: string, port: number): Promise<void> {
    const id = `${ip}:${port}`;
    if (this.connections.has(id)) {
      log(`[POOL] Connection to ${id} already exists, skipping`);
      return;
    }

    try {
      const socket = await connect(ip, port);
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
        isServer: false,
        enableCompression: handler.enableCompression,
      };

      this.connections.set(id, connection);
      log(`[POOL] Added connection ${id} to pool, sending handshake`);
      handler.send(buildHandshake("GNUTELLA CONNECT/0.6", this.headers));

      setTimeout(() => {
        if (!connection.handshake) {
          log(`[POOL] Handshake timeout for ${id}, closing connection`);
          handler.close();
          this.connections.delete(id);
        }
      }, HANDSHAKE_TIMEOUT);
    } catch (error) {
      log(`[POOL] Failed to connect to ${id}:`, error);
    }
  }

  private handleMessage(id: string, msg: Message): void {
    const conn = this.connections.get(id);
    if (!conn) {
      log(`[POOL] Received message for unknown connection ${id}`);
      return;
    }

    log(`[POOL] Received ${msg.type} from ${id}`);

    if (msg.type === "handshake_ok" && !conn.handshake) {
      log(`[POOL] Handshake successful with ${id}, sending vendor headers`);
      conn.handshake = true;

      // Check compression negotiation
      const peerAcceptsDeflate =
        msg.headers["Accept-Encoding"]?.includes("deflate");
      const shouldCompress =
        peerAcceptsDeflate &&
        this.headers["Accept-Encoding"]?.includes("deflate");

      const responseHeaders = { ...this.vendorHeaders };
      if (shouldCompress) {
        responseHeaders["Content-Encoding"] = "deflate";
      }

      // Send only vendor headers as per spec
      conn.send(buildHandshake("GNUTELLA/0.6 200 OK", responseHeaders));

      // Enable compression if negotiated
      if (
        shouldCompress &&
        msg.headers["Content-Encoding"]?.includes("deflate")
      ) {
        conn.enableCompression?.();
      }

      this.sendInitialMessages(conn);
    }

    this.onMessage(conn, msg);
  }

  private handleError(id: string, error: Error): void {
    log(`[POOL] Connection error ${id}:`, error.message);
    this.sendByeIfPossible(id, 500, "Connection error");
    this.connections.delete(id);
    log(`[POOL] Removed connection ${id} from pool due to error`);
  }

  private handleClose(id: string): void {
    log(`[POOL] Connection ${id} closed`);
    this.connections.delete(id);
    log(`[POOL] Removed connection ${id} from pool`);
  }

  private sendByeIfPossible(id: string, code: number, message: string): void {
    const conn = this.connections.get(id);
    if (conn && conn.handshake) {
      try {
        conn.send(buildBye(code, message));
      } catch (e) {
        // Socket might already be closed
      }
    }
  }

  private sendInitialMessages(conn: Connection): void {
    log(`[POOL] Sending initial messages to ${conn.id}`);
    const qrp = new QrpTable();
    conn.send(buildQrpReset());
    log(`[POOL] Sent QRP RESET to ${conn.id}`);
    conn.send(buildQrpPatch(1, 1, 1, qrp.toBuffer()));
    log(`[POOL] Sent QRP PATCH to ${conn.id}`);
    conn.send(buildPing());
    log(`[POOL] Sent PING to ${conn.id}`);
  }

  getActiveCount(): number {
    return Array.from(this.connections.values()).filter((c) => c.handshake)
      .length;
  }

  needsConnections(): boolean {
    return this.getActiveCount() < this.targetCount;
  }

  close(): void {
    this.connections.forEach((conn) => {
      this.sendByeIfPossible(conn.id, 200, "Shutting down");
      conn.socket.destroy();
    });
    this.connections.clear();
  }
}
