import { Server, Socket, createConnection, createServer } from "net";
import { buildBaseHeaders } from "./buildBaseHeaders";
import { Protocol } from "./const";
import { IDGenerator } from "./IDGenerator";
import { MessageBuilder } from "./MessageBuilder";
import { MessageRouter } from "./MessageRouter";
import { SocketHandler } from "./SocketHandler";
import { Connection, Context, GnutellaMessage } from "./types";

export class GnutellaServer {
  private server: Server | null;
  private connections: Map<string, Connection>;
  private router: MessageRouter;
  private context: Context;

  constructor(context: Context) {
    this.server = null;
    this.connections = new Map();
    this.router = new MessageRouter();
    this.context = context;
  }
  async pingPeers(ttl: number = Protocol.TTL): Promise<void> {
    this.connections.forEach((conn) => {
      if (conn.handshake) {
        conn.send(MessageBuilder.ping(IDGenerator.generate(), ttl));
      }
    });
  }
  async start(port: number): Promise<void> {
    this.server = createServer((socket) => this.handleConnection(socket));
    return new Promise((resolve, reject) => {
      if (!this.server) {
        reject(new Error("Server not initialized"));
        return;
      }
      this.server.listen(port, "0.0.0.0", () => resolve());
      this.server.once("error", reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // Send Bye messages to all connections that support it
      this.connections.forEach((conn) => {
        if (conn.handshake) {
          try {
            conn.send(MessageBuilder.bye(200, "Server shutting down"));
            // Give a brief moment for the Bye message to be sent
            setTimeout(() => conn.socket.destroy(), 100);
          } catch {
            conn.socket.destroy();
          }
        } else {
          conn.socket.destroy();
        }
      });
      this.connections.clear();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  connectPeer(host: string, port: number): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });

      socket.once("connect", () => {
        this.handleConnection(socket, true);
        const id = `${socket.remoteAddress}:${socket.remotePort}`;
        const conn = this.connections.get(id);
        if (!conn) {
          reject(new Error("Connection not found after establishment"));
          return;
        }
        const headers = buildBaseHeaders(this.context);
        conn.send(
          MessageBuilder.handshake(
            `GNUTELLA CONNECT/${Protocol.VERSION}`,
            headers,
          ),
        );
        resolve(conn);
      });

      socket.once("error", (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private handleConnection(socket: Socket, isOutbound: boolean = false): void {
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
      isOutbound,
    };

    this.connections.set(id, connection);
  }

  private handleMessage(id: string, msg: GnutellaMessage): void {
    const conn = this.connections.get(id);
    if (!conn) {
      return;
    }
    this.router.route(conn, msg, this.context);
  }

  private handleError(id: string, _error: Error): void {
    this.connections.delete(id);
  }

  private handleClose(id: string): void {
    this.connections.delete(id);
  }

  closeConnection(
    id: string,
    code: number = 200,
    reason: string = "Closing connection",
  ): void {
    const conn = this.connections.get(id);
    if (!conn) {
      return;
    }

    if (conn.handshake) {
      try {
        conn.send(MessageBuilder.bye(code, reason));
        // Wait briefly for Bye to send, then close
        setTimeout(() => {
          conn.socket.destroy();
          this.connections.delete(id);
        }, 100);
      } catch {
        conn.socket.destroy();
        this.connections.delete(id);
      }
    } else {
      conn.socket.destroy();
      this.connections.delete(id);
    }
  }

  sendPush(
    targetServentId: Buffer,
    fileIndex: number,
    requesterIp: string,
    requesterPort: number,
  ): void {
    // Send PUSH message to all connected nodes
    // The PUSH will be routed based on servent ID
    const pushMessage = MessageBuilder.push(
      targetServentId,
      fileIndex,
      requesterIp,
      requesterPort,
    );

    this.connections.forEach((conn) => {
      if (conn.handshake) {
        try {
          conn.send(pushMessage);
        } catch (err) {
          console.error(`Failed to send PUSH to ${conn.id}:`, err);
        }
      }
    });
  }
}
