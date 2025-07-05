import { promises as fs } from "fs";
import net from "net";
import path from "path";
import { buildBaseHeaders } from "./buildBaseHeaders";
import { CONFIG, Protocol } from "./const";
import { IDGenerator } from "./IDGenerator";
import { MessageBuilder } from "./MessageBuilder";
import {
  ByeMessage,
  Connection,
  Context,
  GnutellaMessage,
  HandshakeConnectMessage,
  HandshakeErrorMessage,
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
      handshake_ok: () => {
        this.handleHandshakeOk(conn, msg as HandshakeOkMessage, context);
      },
      ping: () => this.handlePing(conn, msg as PingMessage, context),
      pong: () => this.handlePong(conn, msg as PongMessage, context),
      push: () => this.handlePush(conn, msg as PushMessage, context),
      query: () => this.handleQuery(conn, msg as QueryMessage, context),
      bye: () => this.handleBye(conn, msg as ByeMessage),
      handshake_error: () =>
        this.handleHandshakeError(conn, msg as HandshakeErrorMessage, context),
    };

    const handler = handlers[msg.type];
    console.log(`=== ROUTING ${msg.type} ===`);
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
    const TADA_EMOJI = String.fromCodePoint(0x1f389);
    console.warn(
      `${TADA_EMOJI} Handshake OK received again from ${conn.socket.remoteAddress}`,
    );

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
    const sharedFiles = context.fileManager.getFiles();
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
    console.log(`=== GOT PONG ${_conn.socket.remoteAddress}===`);
    context.peerStore.addPeer(msg.ipAddress, msg.port, "pong");
  }

  private handleQuery(
    conn: Connection,
    msg: QueryMessage,
    context: Context,
  ): void {
    console.log(`=== GOT QUERY ${conn.socket.remoteAddress}===`);
    if (!this.ttlCheck(msg.header)) {
      return;
    }

    if (!context.fileManager.matchesQuery(msg.searchCriteria)) {
      return;
    }

    const matchingFiles = context.fileManager.getMatchingFiles(
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

  private handleBye(conn: Connection, msg: ByeMessage): void {
    // According to spec: "A servent receiving a Bye message MUST close the connection immediately"
    console.log(`Received Bye message (code: ${msg.code}): ${msg.message}`);
    conn.socket.destroy();
  }

  private handleHandshakeError(
    conn: Connection,
    msg: HandshakeErrorMessage,
    context: Context,
  ): void {
    console.error(
      `Handshake error from ${conn.socket.remoteAddress} (${msg.code}): ${msg.message}`,
    );

    // Extract X-Try and X-Try-Ultrapeers headers if present
    const xTry = msg.headers["X-Try"];
    const xTryUltrapeers = msg.headers["X-Try-Ultrapeers"];

    // Parse and store alternative hosts from X-Try header
    if (xTry) {
      const hosts = this.parseXTryHeader(xTry);
      console.log(`Received ${hosts.length} alternative hosts from X-Try`);
      hosts.forEach((host) => {
        context.peerStore.addPeer(host.ip, host.port, "pong");
      });
    }

    // Parse and store ultrapeer hosts from X-Try-Ultrapeers header
    if (xTryUltrapeers) {
      const ultrapeers = this.parseXTryHeader(xTryUltrapeers);
      console.log(
        `Received ${ultrapeers.length} ultrapeer hosts from X-Try-Ultrapeers`,
      );
      // For now, treat ultrapeers the same as regular peers
      // In the future, these could be marked with a special flag
      ultrapeers.forEach((host) => {
        context.peerStore.addPeer(host.ip, host.port, "pong");
      });
    }

    // Save any newly discovered peers
    if (xTry || xTryUltrapeers) {
      context.peerStore.save().catch((err) => {
        console.error("Failed to save discovered peers:", err);
      });
    }

    // Close the connection
    conn.socket.destroy();
  }

  /**
   * Parse X-Try header value into host:port pairs
   */
  private parseXTryHeader(header: string): Array<{ ip: string; port: number }> {
    const hosts: Array<{ ip: string; port: number }> = [];

    // Split by comma and parse each host:port pair
    const entries = header.split(",");
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }

      const colonIndex = trimmed.lastIndexOf(":");
      if (colonIndex === -1) {
        continue;
      }

      const ip = trimmed.substring(0, colonIndex);
      const portStr = trimmed.substring(colonIndex + 1);
      const port = parseInt(portStr, 10);

      // Validate IP and port
      if (port > 0 && port <= 65535 && this.isValidIP(ip)) {
        hosts.push({ ip, port });
      }
    }

    return hosts;
  }

  /**
   * Basic IP validation
   */
  private isValidIP(ip: string): boolean {
    // Simple IPv4 validation
    const parts = ip.split(".");
    if (parts.length !== 4) {
      return false;
    }

    return parts.every((part) => {
      const num = parseInt(part, 10);
      return num >= 0 && num <= 255 && part === num.toString();
    });
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
        context.fileManager.getFile(msg.fileIndex)?.filename || "",
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

          const file = context.fileManager.getFile(fileIndex);
          if (!file) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.end();
            return;
          }

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
