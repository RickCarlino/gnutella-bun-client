import { promises as fs } from "fs";
import net from "net";
import path from "path";
import { buildBaseHeaders } from "./buildBaseHeaders";
import { CONFIG, Protocol } from "./const";
import { IDGenerator } from "./IDGenerator";
import { MessageBuilder } from "./MessageBuilder";
import { QRPManager } from "./QRPManager";
import {
  ByeMessage,
  Connection,
  Context,
  GnutellaMessage,
  HandshakeConnectMessage,
  HandshakeOkMessage,
  MessageHeader,
  PingMessage,
  PongMessage,
  PushMessage,
  QueryMessage,
} from "./types";

export class MessageRouter {
  private messageCache: Map<string, number> = new Map();
  private readonly CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

  ttlCheck(header: MessageHeader): boolean {
    // Check if TTL is 0 BEFORE decrementing
    if (!header || header.ttl === 0) {
      return false;
    }

    // Decrement TTL and increment hops
    header.ttl--;
    header.hops++;

    // After decrement, TTL should still be >= 0 to forward
    return header.ttl >= 0;
  }

  private isMessageSeen(messageId: Buffer): boolean {
    const idString = messageId.toString("hex");
    const now = Date.now();

    // Clean expired entries
    for (const [id, timestamp] of this.messageCache.entries()) {
      if (now - timestamp > this.CACHE_EXPIRY) {
        this.messageCache.delete(id);
      }
    }

    // Check if message was seen
    if (this.messageCache.has(idString)) {
      return true;
    }

    // Mark as seen
    this.messageCache.set(idString, now);
    return false;
  }

  route(conn: Connection, msg: GnutellaMessage, context: Context): void {
    // Check for duplicate messages (only for messages with headers)
    if ("header" in msg && msg.header) {
      if (this.isMessageSeen(msg.header.descriptorId)) {
        // Drop duplicate message
        return;
      }
    }

    const handlers: Record<string, () => void> = {
      handshake_connect: () =>
        this.handleHandshakeConnect(
          conn,
          msg as HandshakeConnectMessage,
          context,
        ),
      handshake_ok: () =>
        this.handleHandshakeOk(conn, msg as HandshakeOkMessage, context),
      ping: () => this.handlePing(conn, msg as PingMessage, context),
      pong: () => this.handlePong(conn, msg as PongMessage, context),
      push: () => this.handlePush(conn, msg as PushMessage, context),
      query: () => this.handleQuery(conn, msg as QueryMessage, context),
      bye: () => this.handleBye(conn, msg as ByeMessage),
      handshake_error: () => {},
      route_table_update: () => {},
    };

    const handler = handlers[msg.type];
    if (handler) {
      handler();
    }
  }

  private handleHandshakeConnect(
    conn: Connection,
    msg: HandshakeConnectMessage,
    context: Context,
  ): void {
    const clientAcceptsDeflate =
      msg.headers["Accept-Encoding"]?.includes("deflate");
    const responseHeaders = this.buildResponseHeaders(
      context,
      clientAcceptsDeflate,
    );
    conn.send(MessageBuilder.handshakeOk(responseHeaders));
  }

  private handleHandshakeOk(
    conn: Connection,
    msg: HandshakeOkMessage,
    context: Context,
  ): void {
    if (conn.handshake) {
      return;
    }

    if (conn.isOutbound) {
      const clientAcceptsDeflate =
        msg.headers["Accept-Encoding"]?.includes("deflate");
      const responseHeaders = this.buildResponseHeaders(
        context,
        clientAcceptsDeflate,
      );
      conn.send(MessageBuilder.handshakeOk(responseHeaders));
    }

    conn.handshake = true;

    const shouldCompress =
      msg.headers["Content-Encoding"]?.includes("deflate") &&
      this.buildResponseHeaders(context, false)["Accept-Encoding"]?.includes(
        "deflate",
      );

    if (shouldCompress && conn.enableCompression) {
      conn.enableCompression();
    }

    conn.send(MessageBuilder.ping(IDGenerator.generate(), Protocol.TTL));
    setTimeout(async () => {
      await this.sendQRPTable(conn, context.qrpManager);
    }, 1);
  }

  private handlePing(
    conn: Connection,
    msg: PingMessage,
    context: Context,
  ): void {
    if (!conn.handshake) {
      return;
    }

    const pongTtl = Math.max(msg.header.hops, 1);
    const sharedFiles = context.qrpManager.getFiles();
    const fileCount = sharedFiles.length;
    const totalSizeKb = Math.floor(
      sharedFiles.reduce((sum, file) => sum + file.size, 0) / 1024,
    );

    conn.send(
      MessageBuilder.pong(
        msg.header.descriptorId,
        context.localPort,
        context.localIp,
        fileCount,
        totalSizeKb,
        pongTtl,
      ),
    );
  }

  private handlePong(
    _conn: Connection,
    msg: PongMessage,
    context: Context,
  ): void {
    context.peerStore.addPeer(msg.ipAddress, msg.port);
  }

  private handleQuery(
    conn: Connection,
    msg: QueryMessage,
    context: Context,
  ): void {
    if (!this.ttlCheck(msg.header)) {
      return;
    }

    if (!context.qrpManager.matchesQuery(msg.searchCriteria)) {
      return;
    }

    const matchingFiles = context.qrpManager.getMatchingFiles(
      msg.searchCriteria,
    );
    if (matchingFiles.length === 0) {
      return;
    }

    const queryHit = MessageBuilder.queryHit(
      msg.header.descriptorId,
      CONFIG.httpPort,
      context.localIp,
      matchingFiles,
      context.serventId,
    );
    conn.send(queryHit);
  }

  private buildResponseHeaders(
    context: Context,
    clientAcceptsDeflate: boolean,
  ): Record<string, string> {
    const headers = buildBaseHeaders(context);
    if (clientAcceptsDeflate) {
      headers["Content-Encoding"] = "deflate";
    }
    return headers;
  }

  private async sendQRPTable(
    conn: Connection,
    qrpManager: QRPManager,
  ): Promise<void> {
    try {
      conn.send(qrpManager.buildResetMessage());
      const patchMessages = await qrpManager.buildPatchMessage();
      patchMessages.forEach((msg) => conn.send(msg));
    } catch {}
  }

  private handleBye(conn: Connection, msg: ByeMessage): void {
    // According to spec: "A servent receiving a Bye message MUST close the connection immediately"
    console.log(`Received Bye message (code: ${msg.code}): ${msg.message}`);
    conn.socket.destroy();
  }

  private handlePush(
    _conn: Connection,
    msg: PushMessage,
    context: Context,
  ): void {
    // Check if the push request is for us
    if (!msg.serventId.equals(context.serventId)) {
      // Forward the PUSH message if it's not for us and TTL allows
      if (this.ttlCheck(msg.header)) {
        // TODO: Implement forwarding logic based on servent ID routing
      }
      return;
    }

    // This PUSH is for us - initiate a push connection
    console.log(
      `Received PUSH request for file ${msg.fileIndex} to ${msg.ipAddress}:${msg.port}`,
    );

    // Create a new connection to the requester
    const pushSocket = net.createConnection({
      host: msg.ipAddress,
      port: msg.port,
    });

    pushSocket.once("connect", () => {
      // Send GIV message according to spec
      const givMessage = this.buildGivMessage(
        msg.fileIndex,
        context.serventId,
        context.qrpManager.getFile(msg.fileIndex)?.filename || "",
      );
      pushSocket.write(givMessage);

      // The socket is now ready for the requester to send HTTP GET
      // Hand off to HTTP handling logic
      this.handlePushConnection(pushSocket, msg.fileIndex, context).catch(
        (err) => {
          console.error("Error in push connection handler:", err);
          pushSocket.destroy();
        },
      );
    });

    pushSocket.once("error", (err) => {
      console.error(
        `Failed to establish push connection to ${msg.ipAddress}:${msg.port}:`,
        err,
      );
      pushSocket.destroy();
    });
  }

  private buildGivMessage(
    fileIndex: number,
    serventId: Buffer,
    filename: string,
  ): Buffer {
    // Format: GIV <file_index>:<servent_id>/<file_name>\n\n
    const serventIdHex = serventId.toString("hex").toUpperCase();
    const givString = `GIV ${fileIndex}:${serventIdHex}/${filename}\n\n`;
    return Buffer.from(givString, "ascii");
  }

  private async handlePushConnection(
    socket: net.Socket,
    fileIndex: number,
    context: Context,
  ): Promise<void> {
    // After sending GIV, the socket will receive HTTP requests
    let buffer = Buffer.alloc(0);

    socket.on("data", async (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const requestStr = buffer.toString("ascii");

      // Check if we have a complete HTTP request
      if (requestStr.includes("\r\n\r\n")) {
        // Extract the request line
        const lines = requestStr.split("\r\n");
        const requestLine = lines[0];

        if (requestLine.startsWith("GET ")) {
          // Parse the GET request
          const urlMatch = requestLine.match(/^GET\s+(\S+)\s+HTTP/);
          if (!urlMatch) {
            socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            socket.end();
            return;
          }

          const file = context.qrpManager.getFile(fileIndex);
          if (!file) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.end();
            return;
          }

          try {
            // Construct file path
            const filePath = path.join(
              process.cwd(),
              "gnutella-library",
              file.filename,
            );
            const stat = await fs.stat(filePath);

            // Parse Range header if present
            const rangeHeader = lines.find((line) =>
              line.toLowerCase().startsWith("range:"),
            );
            let start = 0;
            let end = stat.size - 1;
            let status = 200;
            let statusText = "OK";

            if (rangeHeader) {
              const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
              if (rangeMatch) {
                start = parseInt(rangeMatch[1]);
                if (rangeMatch[2]) {
                  end = parseInt(rangeMatch[2]);
                }
                status = 206;
                statusText = "Partial Content";
              }
            }

            const contentLength = end - start + 1;

            // Send HTTP response headers
            const headers = [
              `HTTP/1.1 ${status} ${statusText}`,
              "Server: GnutellaBun/0.1",
              "Content-Type: application/octet-stream",
              `Content-Length: ${contentLength}`,
              "Accept-Ranges: bytes",
            ];

            if (status === 206) {
              headers.push(`Content-Range: bytes ${start}-${end}/${stat.size}`);
            }

            headers.push("", ""); // Empty line to end headers
            socket.write(headers.join("\r\n"));

            // Stream file content
            const readStream = require("fs").createReadStream(filePath, {
              start,
              end,
            });
            readStream.pipe(socket);

            readStream.on("end", () => {
              // Keep connection open for HTTP/1.1 keep-alive
              const connectionHeader = lines.find((line) =>
                line.toLowerCase().startsWith("connection:"),
              );
              if (
                connectionHeader &&
                connectionHeader.toLowerCase().includes("close")
              ) {
                socket.end();
              }
            });

            readStream.on("error", (err: Error) => {
              console.error("Error reading file for PUSH:", err);
              socket.destroy();
            });
          } catch (err) {
            console.error("Error handling PUSH file request:", err);
            socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
            socket.end();
          }
        } else {
          socket.write("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
          socket.end();
        }
      }
    });

    socket.on("error", () => socket.destroy());
    socket.setTimeout(30000, () => socket.destroy()); // 30 second timeout
  }
}
