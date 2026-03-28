import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  buildUriResRequest,
  encodeBye,
  encodeQuery,
  parseBye,
  parseQueryHit,
} from "../../../../src/protocol";
import { TYPE } from "../../../../src/const";
import {
  makeHeader,
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  peerState,
  withMockNetworkInterfaces,
  withTempDir,
} from "./helpers";

describe("protocol node", () => {
  test("accepts non-empty ping payloads and NUL-terminates Bye messages", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      expect(
        node.validateDescriptor(
          TYPE.PING,
          Buffer.from([0xc3, 0x90, 0x00]),
        ),
      ).toBe(true);

      const encoded = encodeBye(502, "queue full");
      expect(encoded.at(-1)).toBe(0);
      expect(
        parseBye(Buffer.concat([encoded, Buffer.from("ignored", "utf8")])),
      ).toEqual({
        code: 502,
        message: "queue full",
      });
    });
  });

  test("normalizes query TTL plus hops and drops excessive query TTL values", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const peer = makePeer("source-peer");
      const other = makePeer("other-peer");
      other.role = "ultrapeer";
      node.peers.set(other.key, other);
      let forwarded: {
        ttl: number;
        hops: number;
        descriptorId: string;
      } | null = null;
      let responded = false;
      (node as any).sendToPeer = (
        target: { key: string },
        payloadType: number,
        descriptorId: Buffer,
        ttl: number,
        hops: number,
        _payload: Buffer,
      ) => {
        if (target.key !== other.key || payloadType !== TYPE.QUERY) return;
        forwarded = {
          ttl,
          hops,
          descriptorId: descriptorId.toString("hex"),
        };
      };
      (node as any).respondQueryHit = () => {
        responded = true;
      };

      const payload = encodeQuery("alpha");
      node.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 7, 4, 0x11),
        payload,
      );

      expect(responded).toBe(true);
      expect(forwarded!).toEqual({
        ttl: 2,
        hops: 5,
        descriptorId: "11".repeat(16),
      });

      forwarded = null;
      responded = false;
      node.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 16, 0, 0x12),
        payload,
      );

      expect(responded).toBe(false);
      expect(forwarded).toBeNull();
    });
  });

  test("ignores blank queries but answers the four-space index query", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        const shareA = makeShare(
          1,
          path.join(dir, "alpha.txt"),
          "alpha.txt",
        );
        const shareB = makeShare(
          2,
          path.join(dir, "beta.bin"),
          "beta.bin",
        );
        node.shares = [shareA, shareB];
        node.sharesByIndex = new Map(
          node.shares.map((share) => [share.index, share]),
        );
        const peer = makePeer();
        const sent: Array<{ payloadType: number; payload: Buffer }> = [];
        (node as any).sendToPeer = (
          _peer: unknown,
          payloadType: number,
          _descriptorId: Buffer,
          _ttl: number,
          _hops: number,
          payload: Buffer,
        ) => {
          sent.push({ payloadType, payload });
        };
        (node as any).broadcastQuery = () => {};

        node.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 2, 0, 0x21),
          encodeQuery("   "),
        );
        expect(sent).toHaveLength(0);

        node.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 1, 0, 0x22),
          encodeQuery("    "),
        );
        expect(sent).toHaveLength(1);
        expect(sent[0].payloadType).toBe(TYPE.QUERY_HIT);
        expect(
          parseQueryHit(sent[0].payload).results.map(
            (result) => result.fileName,
          ),
        ).toEqual(["alpha.txt", "beta.bin"]);

        sent.length = 0;
        node.handleDescriptor(
          peer as never,
          makeHeader(TYPE.QUERY, 2, 0, 0x23),
          encodeQuery("a b"),
        );
        expect(sent).toHaveLength(0);
      });
    });
  });

  test("accepts both /get path spellings on inbound requests", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      node.sharesByIndex = new Map([[share.index, share]]);
      const socket = new MockSocket();
      const heads: string[] = [];
      (node as any).handleExistingGet = async (
        _socket: net.Socket,
        head: string,
      ) => {
        heads.push(head);
      };

      await node.handleIncomingGet(
        socket as never,
        "GET /get/1/alpha.txt HTTP/1.1\r\n\r\n",
      );
      await node.handleIncomingGet(
        socket as never,
        "GET /get/1/alpha.txt/ HTTP/1.1\r\n\r\n",
      );

      expect(heads).toEqual([
        "GET /get/1/alpha.txt HTTP/1.1\r\n\r\n",
        "GET /get/1/alpha.txt/ HTTP/1.1\r\n\r\n",
      ]);
    });
  });

  test("refreshes shares with SHA-1 URNs, keywords, and a searchable QRP table", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      await fs.mkdir(path.join(node.config().downloadsDir, "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(node.config().downloadsDir, "caf\u00e9-au-lait.txt"),
        "hello",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.config().downloadsDir, "nested", "second-file.bin"),
        "1234567890",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.config().downloadsDir, "nested", "cats-track.txt"),
        "meow",
        "utf8",
      );

      await node.refreshShares();

      expect(node.getShares().map((share) => share.rel)).toEqual([
        "caf\u00e9-au-lait.txt",
        "nested/cats-track.txt",
        "nested/second-file.bin",
      ]);
      expect(
        node
          .getShares()
          .every((share) => /^urn:sha1:[A-Z2-7]{32}$/.test(share.sha1Urn)),
      ).toBe(true);
      expect(node.getShares()[0]?.keywords).toEqual(
        expect.arrayContaining(["cafe", "au", "lait", "txt"]),
      );
      expect(node.getShares()[1]?.keywords).toEqual(
        expect.arrayContaining(["nested", "cats", "track", "txt"]),
      );
      expect(node.getShares()[2]?.keywords).toEqual(
        expect.arrayContaining(["nested", "second", "file", "bin"]),
      );
      expect((node as any).qrpTable.matchesQuery("cafe lait")).toBe(true);
      expect((node as any).qrpTable.matchesQuery("cat track")).toBe(true);
      expect((node as any).qrpTable.matchesQuery("missing-token")).toBe(
        false,
      );
      expect(node.totalSharedKBytes()).toBe(1);
    });
  });

  test("builds handshake headers, capabilities, and rejection responses with try peers", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        node.doc.config.advertisedHost = "7.7.7.7";
        node.doc.config.advertisedPort = 7777;
        node.doc.state.peers = peerState([
          ["7.7.7.7:7777", 0],
          ["1.1.1.1:1234", 0],
        ]);

        expect(node.baseHandshakeHeaders()).toMatchObject({
          "user-agent": "GnutellaBun/0.6",
          "x-ultrapeer": "False",
          "listen-ip": "7.7.7.7:7777",
          "x-max-ttl": "7",
          "x-query-routing": "0.1",
          "accept-encoding": "deflate",
          "pong-caching": "0.1",
          ggep: "0.5",
          "bye-packet": "0.1",
        });
        expect(
          node.buildServerHandshakeHeaders(
            { "accept-encoding": "gzip, deflate" },
            "9.8.7.6",
          ),
        ).toMatchObject({
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });
        expect(
          node.buildClientFinalHeaders(
            { "accept-encoding": "deflate" },
            "9.8.7.6",
          ),
        ).toEqual({
          "content-encoding": "deflate",
          "remote-ip": "9.8.7.6",
        });

        const caps = node.buildCapabilities(
          "0.6",
          {
            "User-Agent": "Peer/1.0",
            "Accept-Encoding": "gzip, deflate",
            "X-Ultrapeer": "True",
            "X-Ultrapeer-Needed": "false",
            "Listen-IP": "9.8.7.6:6346",
            "X-Query-Routing": "0.2",
            "X-Ultrapeer-Query-Routing": "0.1",
            GGEP: "0.5",
            "Pong-Caching": "0.1",
            "Bye-Packet": "0.1",
          },
          true,
          false,
        );
        expect(caps).toMatchObject({
          userAgent: "Peer/1.0",
          supportsGgep: true,
          supportsPongCaching: true,
          supportsBye: true,
          supportsCompression: true,
          compressIn: true,
          compressOut: false,
          isUltrapeer: true,
          ultrapeerNeeded: false,
          queryRoutingVersion: "0.2",
          ultrapeerQueryRoutingVersion: "0.1",
          listenIp: { host: "9.8.7.6", port: 6346 },
        });

        const listenPeer = makePeer("2.2.2.2:2345");
        listenPeer.capabilities.listenIp = { host: "2.2.2.2", port: 2345 };
        const dialedPeer = makePeer("3.3.3.3:3456");
        dialedPeer.dialTarget = "3.3.3.3:3456";
        node.peers.set(listenPeer.key, listenPeer as never);
        node.peers.set(dialedPeer.key, dialedPeer as never);

        expect(node.selectTryPeers(4)).toEqual([
          "2.2.2.2:2345",
          "3.3.3.3:3456",
          "1.1.1.1:1234",
        ]);

        const socket = new MockSocket();
        node.reject06(socket as never, 503, "Busy", {
          server: "TestServent",
        });
        const raw = Buffer.concat(socket.writes).toString("latin1");
        expect(socket.ended).toBe(true);
        expect(raw).toContain("GNUTELLA/0.6 503 Busy\r\n");
        expect(raw).toContain(
          "X-Try: 2.2.2.2:2345,3.3.3.3:3456,1.1.1.1:1234\r\n",
        );
        expect(raw).toContain(
          "X-Try-Ultrapeers: 2.2.2.2:2345,3.3.3.3:3456,1.1.1.1:1234\r\n",
        );
        expect(raw.toLowerCase()).toContain("server: testservent\r\n");

        node.maybeAbsorbTryHeaders({
          "x-try": "4.4.4.4:4444, invalid, 2.2.2.2:2345",
          "x-try-ultrapeers": "5.5.5.5:5555",
        });
        expect(node.getKnownPeers()).toEqual(
          expect.arrayContaining([
            "1.1.1.1:1234",
            "4.4.4.4:4444",
            "5.5.5.5:5555",
          ]),
        );
      });
    });
  });

  test("learns a public advertised host from agreed Remote-IP reports", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        delete node.doc.config.advertisedHost;

        (node as any).absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "10.0.0.2",
        );
        expect((node as any).learnedAdvertisedHost).toBeUndefined();

        (node as any).absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "23.1.2.3",
        );
        (node as any).absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "23.1.9.9",
        );
        expect((node as any).learnedAdvertisedHost).toBeUndefined();

        (node as any).absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "24.2.3.4",
        );
        expect((node as any).learnedAdvertisedHost).toBeUndefined();

        (node as any).absorbHandshakeHeaders(
          { "remote-ip": "44.55.66.77" },
          "25.3.4.5",
        );
        expect((node as any).learnedAdvertisedHost).toBe("44.55.66.77");
        expect(node.currentAdvertisedHost()).toBe("44.55.66.77");

        node.addKnownPeer("44.55.66.77", node.currentAdvertisedPort());
        expect(node.getKnownPeers()).toEqual([]);

        const overrideNode = makeNode(path.join(dir, "override.json"));
        overrideNode.doc.config.advertisedHost = "7.7.7.7";
        (overrideNode as any).absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "26.4.5.6",
        );
        (overrideNode as any).absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "27.5.6.7",
        );
        (overrideNode as any).absorbHandshakeHeaders(
          { "remote-ip": "88.99.77.66" },
          "28.6.7.8",
        );
        expect(
          (overrideNode as any).learnedAdvertisedHost,
        ).toBeUndefined();
        expect(overrideNode.currentAdvertisedHost()).toBe("7.7.7.7");
      });
    });
  });

  test("rejects unexpected outbound handshake responses while absorbing X-Try peers", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        const originalCreateConnection = net.createConnection;
        const responses = [
          "GNUTELLA/0.6 503 Busy\r\nX-Try: 9.8.7.6:4321\r\n\r\n",
          "GNUTELLA OK\n\n",
        ];

        (
          net as unknown as {
            createConnection: typeof net.createConnection;
          }
        ).createConnection = ((options: net.NetConnectOpts) => {
          const tcpOptions = options as net.NetConnectOpts & {
            host?: string;
            port?: number;
          };
          const socket = new MockSocket(
            String(tcpOptions.host || "127.0.0.1"),
            Number(tcpOptions.port || 0),
          );
          const response = responses.shift();
          if (!response)
            throw new Error("expected mock handshake response");
          queueMicrotask(() => {
            socket.emit("connect");
            queueMicrotask(() => socket.emit("data", response));
          });
          return socket as unknown as net.Socket;
        }) as typeof net.createConnection;

        try {
          await expect(
            node.connectPeer06("127.0.0.1", 6346),
          ).rejects.toThrow("0.6 handshake rejected by 127.0.0.1:6346");
          expect(node.getKnownPeers()).toContain("9.8.7.6:4321");

          await expect(
            node.connectPeer06("127.0.0.1", 6347),
          ).rejects.toThrow(
            "unsupported legacy handshake response from 127.0.0.1:6347: GNUTELLA OK",
          );
        } finally {
          (
            net as unknown as {
              createConnection: typeof net.createConnection;
            }
          ).createConnection = originalCreateConnection;
        }
      });
    });
  });

  test("serves HEAD /uri-res requests and rejects missing or malformed targets", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(
        1,
        path.join(node.config().downloadsDir, "alpha.txt"),
        "alpha.txt",
      );
      await fs.mkdir(path.dirname(share.abs), { recursive: true });
      await fs.writeFile(share.abs, "hello", "utf8");
      node.shares = [share];
      node.sharesByIndex = new Map([[share.index, share]]);
      node.sharesByUrn = new Map([[share.sha1Urn.toLowerCase(), share]]);

      const headSocket = new MockSocket();
      const headRequest = buildUriResRequest(share.sha1Urn, 2).replace(
        /^GET/,
        "HEAD",
      );
      await node.handleIncomingGet(headSocket as never, headRequest);

      const headResponse = Buffer.concat(headSocket.writes).toString(
        "latin1",
      );
      expect(headSocket.ended).toBe(false);
      expect(headResponse).toContain("HTTP/1.1 206 Partial Content\r\n");
      expect(headResponse).toContain("Content-Length: 3\r\n");
      expect(headResponse).toContain("Connection: Keep-Alive\r\n");
      expect(headResponse).toContain(
        `X-Gnutella-Content-URN: ${share.sha1Urn}\r\n`,
      );
      expect(headResponse).not.toContain("hello");

      const rangedHeadSocket = new MockSocket();
      await node.handleIncomingGet(
        rangedHeadSocket as never,
        "HEAD /get/1/alpha.txt HTTP/1.1\r\nConnection: close\r\nRange: bytes=1-3\r\n\r\n",
      );

      const rangedHeadResponse = Buffer.concat(
        rangedHeadSocket.writes,
      ).toString("latin1");
      expect(rangedHeadSocket.ended).toBe(true);
      expect(rangedHeadResponse).toContain(
        "HTTP/1.1 206 Partial Content\r\n",
      );
      expect(rangedHeadResponse).toContain("Content-Length: 3\r\n");
      expect(rangedHeadResponse).toContain(
        "Content-Range: bytes 1-3/5\r\n",
      );
      expect(rangedHeadResponse).toContain("Connection: close\r\n");

      const missingSocket = new MockSocket();
      await node.handleIncomingGet(
        missingSocket as never,
        "GET /uri-res/N2R?urn:sha1:NOTFOUND HTTP/1.1\r\n\r\n",
      );
      expect(Buffer.concat(missingSocket.writes).toString("latin1")).toBe(
        "HTTP/1.0 404 Not Found\r\n\r\n",
      );

      const badSocket = new MockSocket();
      await node.handleIncomingGet(
        badSocket as never,
        "GET /not-a-download HTTP/1.1\r\n\r\n",
      );
      expect(Buffer.concat(badSocket.writes).toString("latin1")).toBe(
        "HTTP/1.0 400 Bad Request\r\n\r\n",
      );
    });
  });
});
