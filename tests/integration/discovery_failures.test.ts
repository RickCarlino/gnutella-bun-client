import { expect, test } from "bun:test";
import net from "node:net";
import path from "node:path";
import { connectBootstrapPeers } from "../../src/gwebcache_client";
import { loadDoc } from "../../src/protocol";
import { makeNode, withTempDir } from "../helpers/protocol";

test.each([
  "connect timeout",
  "GNUTELLA/0.6 204 Shielded leaf node",
  "GNUTELLA/0.6 409 Already connected",
  "GNUTELLA/0.6 429 Banned for 5m 0s",
  "GNUTELLA/0.6 503 I am busy",
])(
  "automatic failures are forgotten but preserve referrals: %s",
  async (response) => {
    await withTempDir(async (dir) => {
      const sockets = new Set<net.Socket>();
      let connections = 0;
      const server = net.createServer((socket) => {
        connections += 1;
        sockets.add(socket);
        socket.once("data", () => {
          if (response !== "connect timeout")
            socket.end(
              `${response}\r\nX-Try-Ultrapeers: 127.0.0.2:6346,127.0.0.1:${socket.localPort}\r\n\r\n`,
            );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as net.AddressInfo).port;
      const target = `127.0.0.1:${port}`;
      const configPath = path.join(dir, "config.json");
      const node = makeNode(configPath, {
        runtimeConfig: { connectTimeoutMs: 100 },
        collaborators: {
          bootstrapClient: {
            connectBootstrapPeers: (options) =>
              connectBootstrapPeers({
                ...options,
                caches: ["http://cache.test/"],
                fetchImpl: async () =>
                  new Response("I|pong|Test|gnutella\n"),
              }),
          },
        },
      });
      try {
        node.discovery.updateKnownPeerLastSeen("127.0.0.1", port);
        await node.discovery.connectKnownPeers();
        expect(connections).toBe(1);
        expect(node.getKnownPeers()).not.toContain(target);
        if (response !== "connect timeout")
          expect(node.getKnownPeers()).toContain("127.0.0.2:6346");
        await node.save();
        expect((await loadDoc(configPath)).state.peers).not.toHaveProperty(
          target,
        );

        node.discovery.addKnownPeer("127.0.0.1", port);
        await node.discovery.connectKnownPeers();
        expect(connections).toBe(1);

        expect(await node.connectToPeer(target)).toMatchObject({
          status: "saved",
          message: expect.stringContaining(response),
        });
        expect(connections).toBe(2);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
      }
    });
  },
);
