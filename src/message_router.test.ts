import { describe, test, expect, beforeEach } from "bun:test";
import { MessageRouter } from "./message_router";
import { QRPManager } from "./qrp_manager";
import { PeerStore } from "./peer_store";
import { IDGenerator } from "./id_generator";
import type { Connection, NodeContext, HandshakeOkMessage } from "./core_types";

describe("MessageRouter", () => {
  let router: MessageRouter;
  let context: NodeContext;
  let sentMessages: Buffer[];
  let mockConnection: Connection;

  beforeEach(() => {
    router = new MessageRouter();
    sentMessages = [];

    context = {
      localIp: "127.0.0.1",
      localPort: 6346,
      qrpManager: new QRPManager(),
      peerStore: new PeerStore(),
      serventId: IDGenerator.servent(),
    };

    mockConnection = {
      id: "test-connection",
      socket: {} as any,
      send: (data: Buffer) => sentMessages.push(data),
      handshake: false,
      compressed: false,
      enableCompression: () => {},
    };
  });

  test("handles handshake OK for inbound connection", () => {
    const msg: HandshakeOkMessage = {
      type: "handshake_ok",
      version: "0.6",
      statusCode: 200,
      message: "OK",
      headers: {
        "User-Agent": "TestClient/1.0",
        "Accept-Encoding": "deflate",
      },
    };

    router.route(mockConnection, msg, context);

    // Should not send handshake OK response for inbound connections
    const handshakeMessages = sentMessages.filter((msg) =>
      msg.toString().includes("GNUTELLA/0.6 200 OK")
    );
    expect(handshakeMessages.length).toBe(0);

    // Should send ping
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(mockConnection.handshake).toBe(true);
  });

  test("handles handshake OK for outbound connection", () => {
    mockConnection.isOutbound = true;

    const msg: HandshakeOkMessage = {
      type: "handshake_ok",
      version: "0.6",
      statusCode: 200,
      message: "OK",
      headers: {
        "User-Agent": "TestClient/1.0",
        "Accept-Encoding": "deflate",
        "Content-Encoding": "deflate",
      },
    };

    router.route(mockConnection, msg, context);

    // Should send handshake OK response for outbound connections
    const handshakeMessages = sentMessages.filter((msg) =>
      msg.toString().includes("GNUTELLA/0.6 200 OK")
    );
    expect(handshakeMessages.length).toBe(1);

    // Should also send ping
    expect(sentMessages.length).toBeGreaterThan(1);
    expect(mockConnection.handshake).toBe(true);
  });
});
