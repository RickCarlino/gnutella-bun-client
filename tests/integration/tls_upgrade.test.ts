import { expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { upgradeSocketToTls } from "../../src/connections/tls";
import { makeNode, withTempDir } from "../helpers/protocol";

test("accepted TLS upgrade preserves an already-read ClientHello", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "protocol.json"));
    const sockets = new Set<net.Socket>();
    let accept!: (socket: tls.TLSSocket) => void;
    let fail!: (error: unknown) => void;
    const accepted = new Promise<tls.TLSSocket>((resolve, reject) => {
      accept = resolve;
      fail = reject;
    });
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("data", () => {});
      socket.once("data", (hello) => {
        void upgradeSocketToTls(
          node.connections,
          socket,
          "server",
          Buffer.from(hello),
        ).then(accept, fail);
      });
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as net.AddressInfo;
      const raw = net.createConnection(address.port, "127.0.0.1");
      sockets.add(raw);
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      const [client, inbound] = await Promise.all([
        upgradeSocketToTls(node.connections, raw, "client"),
        accepted,
      ]);
      sockets.add(client);
      sockets.add(inbound);
      const received = new Promise<string>((resolve) =>
        inbound.once("data", (data) => resolve(data.toString())),
      );
      client.write("encrypted descriptor payload");
      expect(await received).toBe("encrypted descriptor payload");
      expect(client.encrypted).toBe(true);
      expect(inbound.encrypted).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("inbound TLS is classified before an HTTP request", async () => {
  await withTempDir(async (dir) => {
    const node = makeNode(path.join(dir, "protocol.json"));
    const server = net.createServer((socket) =>
      node.connections.handleProbe(socket),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const client = tls.connect({
      host: "127.0.0.1",
      port: (server.address() as net.AddressInfo).port,
      rejectUnauthorized: false,
    });
    try {
      const response = await new Promise<string>((resolve, reject) => {
        let received = "";
        client.once("error", reject);
        client.once("secureConnect", () =>
          client.write("GET /missing HTTP/1.0\r\nHost: localhost\r\n\r\n"),
        );
        client.on("data", (chunk) => {
          received += chunk.toString();
        });
        client.once("end", () => resolve(received));
      });
      expect(response).toContain("HTTP/1.0 400 Bad Request");
    } finally {
      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
