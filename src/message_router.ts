import { Protocol } from "./constants";
import { MessageBuilder } from "./message_builder";
import { QRPManager } from "./qrp_manager";
import { buildBaseHeaders } from "./handshake";
import {
  Connection,
  Message,
  MessageHeader,
  HandshakeConnectMessage,
  HandshakeOkMessage,
  PingMessage,
  PongMessage,
  QueryMessage,
  NodeContext,
} from "./core_types";

export class MessageRouter {
  private ttlCheck(header?: MessageHeader): boolean {
    if (!header || header.ttl === 0) return false;

    header.ttl--;
    header.hops++;

    return header.ttl >= 0;
  }

  route(conn: Connection, msg: Message, context: NodeContext): void {
    const handlers: Record<string, () => void> = {
      handshake_connect: () =>
        this.handleHandshakeConnect(
          conn,
          msg as HandshakeConnectMessage,
          context
        ),
      handshake_ok: () =>
        this.handleHandshakeOk(conn, msg as HandshakeOkMessage, context),
      ping: () => this.handlePing(conn, msg as PingMessage, context),
      pong: () => this.handlePong(conn, msg as PongMessage, context),
      query: () => this.handleQuery(conn, msg as QueryMessage, context),
      bye: () => {},
      handshake_error: () => {},
      route_table_update: () => {},
    };

    switch (msg.type) {
      case "ping":
        console.log(`PING <- ${conn.socket.remoteAddress}`);
        break;
      case "pong":
        console.log(`PONG -> ${conn.socket.remoteAddress}`);
        break;
      default:
        console.log(msg);
        break;
    }

    const handler = handlers[msg.type];
    if (handler) {
      handler();
    } else {
      console.warn(`No handler for message type: ${msg.type}`);
    }
  }

  private handleHandshakeConnect(
    conn: Connection,
    msg: HandshakeConnectMessage,
    context: NodeContext
  ): void {
    const clientAcceptsDeflate =
      msg.headers["Accept-Encoding"]?.includes("deflate");
    const responseHeaders = this.buildResponseHeaders(
      context,
      clientAcceptsDeflate
    );

    conn.send(MessageBuilder.handshakeOk(responseHeaders));
  }

  private handleHandshakeOk(
    conn: Connection,
    msg: HandshakeOkMessage,
    context: NodeContext
  ): void {
    if (!conn.handshake) {
      // For outbound connections, we need to send our final OK response
      if (conn.isOutbound) {
        const clientAcceptsDeflate =
          msg.headers["Accept-Encoding"]?.includes("deflate");
        const responseHeaders = this.buildResponseHeaders(
          context,
          clientAcceptsDeflate
        );
        conn.send(MessageBuilder.handshakeOk(responseHeaders));
      }

      conn.handshake = true;

      const shouldCompress =
        msg.headers["Content-Encoding"]?.includes("deflate") &&
        this.buildResponseHeaders(context, false)["Accept-Encoding"]?.includes(
          "deflate"
        );

      if (shouldCompress && conn.enableCompression) {
        conn.enableCompression();
      }

      conn.send(MessageBuilder.ping());

      setTimeout(async () => {
        await this.sendQRPTable(conn, context.qrpManager);
      }, 1);
    }
  }

  private handlePing(
    conn: Connection,
    msg: PingMessage,
    context: NodeContext
  ): void {
    if (!conn.handshake) return;

    const pongTtl = Math.max(msg.header.hops + 1, Protocol.TTL);
    conn.send(
      MessageBuilder.pong(
        msg.header.descriptorId,
        context.localPort,
        context.localIp,
        0,
        0,
        pongTtl
      )
    );
  }

  private handlePong(
    _conn: Connection,
    msg: PongMessage,
    context: NodeContext
  ): void {
    context.peerStore.add(msg.ipAddress, msg.port);
  }

  private handleQuery(
    conn: Connection,
    msg: QueryMessage,
    context: NodeContext
  ): void {
    if (!this.ttlCheck(msg.header)) return;

    if (context.qrpManager.matchesQuery(msg.searchCriteria)) {
      const matchingFiles = context.qrpManager.getMatchingFiles(
        msg.searchCriteria
      );

      if (matchingFiles.length > 0) {
        const queryHit = MessageBuilder.queryHit(
          msg.header.descriptorId,
          context.localPort,
          context.localIp,
          matchingFiles,
          context.serventId
        );

        conn.send(queryHit);
      }
    }
  }

  private buildResponseHeaders(
    context: NodeContext,
    clientAcceptsDeflate: boolean
  ): Record<string, string> {
    const headers = buildBaseHeaders(context);

    if (clientAcceptsDeflate) {
      headers["Content-Encoding"] = "deflate";
    }

    return headers;
  }

  private async sendQRPTable(
    conn: Connection,
    qrpManager: QRPManager
  ): Promise<void> {
    try {
      conn.send(qrpManager.buildResetMessage());

      const patchMessages = await qrpManager.buildPatchMessage();
      patchMessages.forEach((msg) => conn.send(msg));
    } catch {}
  }
}
