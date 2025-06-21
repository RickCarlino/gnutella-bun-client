import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import net from "net";
import { createCompressedGnutellaServer } from "../src/server-compressed";
import { startCompressedConnection } from "../src/gnutella-connection-compressed";
import { createHandshakeConnect, createHandshakeOk } from "../src/parser";
import type { GnutellaObject } from "../src/parser";

describe("Handshake Compression", () => {
  let server: any;
  const TEST_PORT = 16346;
  const serverMessages: Array<{ clientId: string; message: GnutellaObject }> =
    [];
  const clientMessages: GnutellaObject[] = [];

  beforeEach(() => {
    serverMessages.length = 0;
    clientMessages.length = 0;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  test("server should wait for client's final OK before sending binary data", async () => {
    let serverSentOk = false;
    let receivedClientFinalOk = false;

    server = createCompressedGnutellaServer({
      port: TEST_PORT,
      headers: {
        "User-Agent": "TestServer/1.0",
        "Accept-Encoding": "deflate",
      },
      handler: {
        onConnect: () => {},
        onMessage: (clientId, send, msg) => {
          serverMessages.push({ clientId, message: msg });

          if (msg.type === "handshake_connect") {
            // Send server's 200 OK
            const responseHeaders: Record<string, string> = {
              "User-Agent": "TestServer/1.0",
              "Accept-Encoding": "deflate",
            };

            // Check if client supports compression
            if (msg.headers?.["Accept-Encoding"]?.includes("deflate")) {
              responseHeaders["Content-Encoding"] = "deflate";
            }

            send(createHandshakeOk(responseHeaders));
            serverSentOk = true;

            // Try to send binary data immediately (should be buffered)
            setTimeout(() => {
              if (!receivedClientFinalOk) {
                // This should not be sent yet
                send(Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03])); // Fake compressed data
              }
            }, 50);
          } else if (msg.type === "handshake_ok") {
            // Client's final OK received
            receivedClientFinalOk = true;
            server.setClientHandshake(clientId, "0.6");
          }
        },
        onError: () => {},
        onClose: () => {},
      },
    });

    await server.start();

    // Create a raw socket connection to test the handshake order
    const client = net.createConnection({ host: "127.0.0.1", port: TEST_PORT });

    let receivedData = Buffer.alloc(0);
    let handshakeComplete = false;

    await new Promise<void>((resolve, reject) => {
      client.on("connect", () => {
        // Send initial connect
        client.write("GNUTELLA CONNECT/0.6\r\n");
        client.write("User-Agent: TestClient/1.0\r\n");
        client.write("Accept-Encoding: deflate\r\n");
        client.write("\r\n");
      });

      client.on("data", (chunk) => {
        receivedData = Buffer.concat([receivedData, chunk]);
        const dataStr = receivedData.toString();

        // Check if we received server's 200 OK
        if (dataStr.includes("GNUTELLA/0.6 200 OK") && !handshakeComplete) {
          // Check that no binary data was received before handshake
          const headerEndIndex = dataStr.indexOf("\r\n\r\n");
          if (headerEndIndex !== -1) {
            const afterHeaders = receivedData.slice(headerEndIndex + 4);

            // Should be empty or only contain valid Gnutella descriptors
            expect(afterHeaders.length).toBe(0);

            // Send client's final OK
            client.write("GNUTELLA/0.6 200 OK\r\n");
            client.write("User-Agent: TestClient/1.0\r\n");
            client.write("\r\n");
            handshakeComplete = true;

            // Give server time to process and potentially send data
            setTimeout(() => {
              client.end();
              resolve();
            }, 200);
          }
        }
      });

      client.on("error", reject);
    });

    // Verify the handshake order
    expect(serverSentOk).toBe(true);
    expect(receivedClientFinalOk).toBe(true);
    expect(serverMessages.length).toBe(2); // Connect + OK
    expect(serverMessages[0].message.type).toBe("handshake_connect");
    expect(serverMessages[1].message.type).toBe("handshake_ok");
  });

  test("compression should be enabled only after complete handshake", async () => {
    server = createCompressedGnutellaServer({
      port: TEST_PORT,
      headers: {
        "User-Agent": "TestServer/1.0",
        "Accept-Encoding": "deflate",
      },
      handler: {
        onConnect: () => {},
        onMessage: (clientId, send, msg) => {
          if (msg.type === "handshake_connect") {
            const responseHeaders = {
              "User-Agent": "TestServer/1.0",
              "Accept-Encoding": "deflate",
              "Content-Encoding": "deflate", // Server will send compressed
            };
            send(createHandshakeOk(responseHeaders));
          } else if (msg.type === "handshake_ok") {
            server.setClientHandshake(clientId, "0.6");

            // Check compression state
            const compressionState = server.getCompressionState(clientId);
            expect(compressionState?.isCompressed).toBe(true);
            expect(compressionState?.peerAcceptsCompression).toBe(true);
          }
        },
        onError: () => {},
        onClose: () => {},
      },
    });

    await server.start();

    // Use the compressed connection client
    const connection = await startCompressedConnection({
      ip: "127.0.0.1",
      port: TEST_PORT,
      onMessage: (send, msg) => {
        clientMessages.push(msg);

        if (msg.type === "handshake_ok") {
          // Send final OK
          send(
            createHandshakeOk({
              "User-Agent": "TestClient/1.0",
              "Accept-Encoding": "deflate",
            })
          );

          // Notify that handshake is complete
          connection.completeHandshake();
        }
      },
      onError: () => {},
      onClose: () => {},
    });

    // Send initial connect
    connection.send(
      createHandshakeConnect({
        "User-Agent": "TestClient/1.0",
        "Accept-Encoding": "deflate",
      })
    );

    // Wait for handshake to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Check compression state
    expect(connection.compressionState.isCompressed).toBe(true);
    expect(connection.compressionState.peerSendsCompressed).toBe(true);
    expect(connection.compressionState.peerAcceptsCompression).toBe(true);

    connection.socket.destroy();
  });

  test("client should send final OK after receiving server's OK", async () => {
    const messageOrder: string[] = [];

    server = createCompressedGnutellaServer({
      port: TEST_PORT,
      headers: {
        "User-Agent": "TestServer/1.0",
      },
      handler: {
        onConnect: () => {},
        onMessage: (_, send, msg) => {
          messageOrder.push(`server_received_${msg.type}`);

          if (msg.type === "handshake_connect") {
            send(createHandshakeOk({ "User-Agent": "TestServer/1.0" }));
            messageOrder.push("server_sent_ok");
          }
        },
        onError: () => {},
        onClose: () => {},
      },
    });

    await server.start();

    const connection = await startCompressedConnection({
      ip: "127.0.0.1",
      port: TEST_PORT,
      onMessage: (send, msg) => {
        messageOrder.push(`client_received_${msg.type}`);

        if (msg.type === "handshake_ok") {
          send(createHandshakeOk({ "User-Agent": "TestClient/1.0" }));
          messageOrder.push("client_sent_final_ok");
          connection.completeHandshake();
        }
      },
      onError: () => {},
      onClose: () => {},
    });

    messageOrder.push("client_sent_connect");
    connection.send(createHandshakeConnect({ "User-Agent": "TestClient/1.0" }));

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify the correct order
    expect(messageOrder).toEqual([
      "client_sent_connect",
      "server_received_handshake_connect",
      "server_sent_ok",
      "client_received_handshake_ok",
      "client_sent_final_ok",
      "server_received_handshake_ok",
    ]);

    connection.socket.destroy();
  });
});
