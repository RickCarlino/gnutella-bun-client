import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  buildHeader,
  buildUriResRequest,
  GnutellaServent,
  defaultDoc,
  encodeBye,
  encodeQuery,
  parseBye,
  parseQuery,
  parseQueryHit,
  parseRouteTableUpdate,
  type Peer,
} from "../../../src/protocol";
import {
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  TYPE,
} from "../../../src/const";
import { sleep } from "../../../src/shared";
import type { ShareFile } from "../../../src/types";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "protocol-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

class MockSocket extends EventEmitter {
  remoteAddress?: string;
  remotePort?: number;
  writes: Buffer[] = [];
  ended = false;
  destroyed = false;

  constructor(remoteAddress = "127.0.0.1", remotePort = 6346) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
  }

  setNoDelay(_noDelay: boolean): this {
    return this;
  }

  setTimeout(_timeoutMs: number, callback?: () => void): this {
    if (callback) this.on("timeout", callback);
    return this;
  }

  write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array<ArrayBufferLike>): this {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.emit("end");
    return this;
  }

  destroy(_error?: Error): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function makeShare(
  index: number,
  absPath: string,
  name: string,
): ShareFile {
  const stem = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
  const suffix = String.fromCharCode(64 + index).repeat(32);
  return {
    index,
    name,
    rel: name,
    abs: absPath,
    size: 5,
    sha1: Buffer.alloc(20, index),
    sha1Urn: `urn:sha1:${suffix}`,
    keywords: stem,
  };
}

function makeNode(configPath: string): GnutellaServent {
  const doc = defaultDoc(configPath);
  doc.config.sharedDir = path.join(path.dirname(configPath), "shared");
  doc.config.downloadsDir = path.join(
    path.dirname(configPath),
    "downloads",
  );
  doc.config.enableQrp = false;
  return new GnutellaServent(configPath, doc);
}

function makePeer(label = "1.2.3.4:6346"): Peer {
  const socket = new MockSocket();
  return {
    key: label,
    socket: socket as unknown as net.Socket,
    buf: Buffer.alloc(0),
    outbound: false,
    remoteLabel: label,
    capabilities: {
      version: "0.6",
      headers: {},
      supportsGgep: true,
      supportsPongCaching: false,
      supportsBye: true,
      supportsCompression: false,
      compressIn: false,
      compressOut: false,
      isUltrapeer: false,
      ultrapeerNeeded: false,
    },
    remoteQrp: {
      resetSeen: false,
      tableSize: 0,
      infinity: 0,
      entryBits: 0,
      table: null,
      seqSize: 0,
      compressor: 0,
      parts: new Map<number, Buffer>(),
    },
    lastPingAt: 0,
  };
}

function makeHeader(
  payloadType: number,
  ttl: number,
  hops: number,
  fill: number,
) {
  const descriptorId = Buffer.alloc(16, fill);
  return {
    descriptorId,
    descriptorIdHex: descriptorId.toString("hex"),
    payloadType,
    ttl,
    hops,
  };
}

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
      const peer = makePeer();
      let broadcastArgs: {
        ttl: number;
        hops: number;
        search: string;
      } | null = null;
      let responded = false;
      (node as any).broadcastQuery = (
        _descriptorId: Buffer,
        ttl: number,
        hops: number,
        _payload: Buffer,
        search: string,
      ) => {
        broadcastArgs = { ttl, hops, search };
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
      expect(broadcastArgs!).toEqual({ ttl: 2, hops: 5, search: "alpha" });

      broadcastArgs = null;
      responded = false;
      node.handleDescriptor(
        peer as never,
        makeHeader(TYPE.QUERY, 16, 0, 0x12),
        payload,
      );

      expect(responded).toBe(false);
      expect(broadcastArgs).toBeNull();
    });
  });

  test("ignores blank queries but answers the four-space index query", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const shareA = makeShare(
        1,
        path.join(dir, "alpha.txt"),
        "alpha.txt",
      );
      const shareB = makeShare(2, path.join(dir, "beta.bin"), "beta.bin");
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
      await fs.mkdir(path.join(node.doc.config.sharedDir, "nested"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(node.doc.config.sharedDir, "caf\u00e9-au-lait.txt"),
        "hello",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.doc.config.sharedDir, "nested", "second-file.bin"),
        "1234567890",
        "utf8",
      );
      await fs.writeFile(
        path.join(node.doc.config.sharedDir, "nested", "cats-track.txt"),
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
      const node = makeNode(path.join(dir, "protocol.json"));
      node.doc.config.enableQrp = true;
      node.doc.config.advertiseUltrapeer = true;
      node.doc.config.advertisedHost = "7.7.7.7";
      node.doc.config.advertisedPort = 7777;
      node.doc.config.peers = ["7.7.7.7:7777", "1.1.1.1:1234"];

      expect(node.baseHandshakeHeaders()).toMatchObject({
        "user-agent": "GnutellaBun/0.6",
        "x-ultrapeer": "True",
        "x-ultrapeer-needed": "False",
        "listen-ip": "7.7.7.7:7777",
        "x-max-ttl": "7",
        "x-query-routing": "0.1",
        "accept-encoding": "deflate",
        "pong-caching": "0.1",
        ggep: "0.5",
        "bye-packet": "0.1",
      });
      expect(
        node.buildServerHandshakeHeaders({
          "accept-encoding": "gzip, deflate",
        }),
      ).toMatchObject({
        "content-encoding": "deflate",
      });
      expect(
        node.buildClientFinalHeaders({ "accept-encoding": "deflate" }),
      ).toEqual({
        "content-encoding": "deflate",
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

  test("rejects unexpected outbound handshake responses while absorbing X-Try peers", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const server06 = net.createServer((socket) => {
        socket.once("data", () => {
          socket.end(
            "GNUTELLA/0.6 503 Busy\r\nX-Try: 9.8.7.6:4321\r\n\r\n",
          );
        });
      });
      await new Promise<void>((resolve) =>
        server06.listen(0, "127.0.0.1", resolve),
      );
      const addr06 = server06.address();
      if (!addr06 || typeof addr06 === "string")
        throw new Error("expected tcp server address");
      try {
        await expect(
          node.connectPeer06("127.0.0.1", addr06.port),
        ).rejects.toThrow(
          `0.6 handshake rejected by 127.0.0.1:${addr06.port}`,
        );
        expect(node.getKnownPeers()).toContain("9.8.7.6:4321");

        const serverLegacy = net.createServer((socket) => {
          socket.once("data", () => {
            socket.end("GNUTELLA OK\n\n");
          });
        });
        await new Promise<void>((resolve) =>
          serverLegacy.listen(0, "127.0.0.1", resolve),
        );
        const legacyAddr = serverLegacy.address();
        if (!legacyAddr || typeof legacyAddr === "string")
          throw new Error("expected tcp server address");
        try {
          await expect(
            node.connectPeer06("127.0.0.1", legacyAddr.port),
          ).rejects.toThrow(
            `unsupported legacy handshake response from 127.0.0.1:${legacyAddr.port}: GNUTELLA OK`,
          );
        } finally {
          await new Promise<void>((resolve, reject) =>
            serverLegacy.close((error) =>
              error ? reject(error) : resolve(),
            ),
          );
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server06.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  });

  test("serves HEAD /uri-res requests and rejects missing or malformed targets", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(
        1,
        path.join(node.doc.config.sharedDir, "alpha.txt"),
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

  test("ignores GIV file metadata and downloads the originally requested result", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new MockSocket("9.8.7.6", 4321);
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "wanted.bin",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "peer-1",
      };
      const destPath = path.join(dir, "downloads", "wanted.bin");
      let captured: {
        fileIndex: number;
        fileName: string;
        destPath: string;
      } | null = null;
      (node as any).downloadOverSocket = async (
        _socket: net.Socket,
        fileIndex: number,
        fileName: string,
        passedDestPath: string,
      ) => {
        captured = { fileIndex, fileName, destPath: passedDestPath };
        return { ok: true };
      };
      const resolved = new Promise((resolve, reject) => {
        node.enqueuePendingPush({
          serventIdHex: hit.serventIdHex,
          result: hit,
          destPath,
          createdAt: Date.now(),
          resolve,
          reject,
        });
      });

      await node.handleIncomingGiv(
        socket as never,
        `GIV 999:${hit.serventIdHex}/wrong-name.bin\n\n`,
      );

      await expect(resolved).resolves.toEqual({ ok: true });
      expect(captured!).toEqual({
        fileIndex: 5,
        fileName: "wanted.bin",
        destPath,
      });
      expect(node.pendingPushes.has(hit.serventIdHex)).toBe(false);
    });
  });

  test("allows any follow-up GET on a push callback socket", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(1, path.join(dir, "alpha.txt"), "alpha.txt");
      node.shares = [share];
      node.sharesByIndex = new Map([[share.index, share]]);

      const socket = new MockSocket("5.6.7.8", 7654);
      let headSeen = "";
      let existingCalled = false;
      (node as any).handleIncomingGet = async (
        _socket: net.Socket,
        head: string,
      ) => {
        headSeen = head;
      };
      (node as any).handleExistingGet = async () => {
        existingCalled = true;
      };

      const originalCreateConnection = net.createConnection;
      (net as any).createConnection = () =>
        socket as unknown as net.Socket;
      try {
        await node.fulfillPush({
          serventId: Buffer.from(node.serventId),
          serventIdHex: node.serventId.toString("hex"),
          fileIndex: 1,
          ip: "5.6.7.8",
          port: 7654,
          ggep: Buffer.alloc(0),
        });
        socket.emit("connect");
        socket.emit(
          "data",
          Buffer.from("GET /get/2/other.bin HTTP/1.0\r\n\r\n", "latin1"),
        );
        await Promise.resolve();
      } finally {
        (net as any).createConnection = originalCreateConnection;
      }

      expect(socket.writes[0]?.toString("latin1")).toContain(
        `GIV 1:${node.serventId.toString("hex")}/alpha.txt`,
      );
      expect(headSeen).toBe("GET /get/2/other.bin HTTP/1.0\r\n\r\n");
      expect(existingCalled).toBe(false);
    });
  });

  test("downloads over an existing socket using the current file size as a range start", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = new MockSocket("9.8.7.6", 4321);
      const destPath = path.join(dir, "downloads", "alpha.txt");
      let captured: {
        destPath: string;
        label: string;
        existing: number;
      } | null = null;

      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, "hello", "utf8");
      (node as any).readHttpDownload = async (
        _socket: net.Socket,
        passedDestPath: string,
        label: string,
        existing: number,
      ) => {
        captured = { destPath: passedDestPath, label, existing };
        return { ok: true };
      };

      await expect(
        node.downloadOverSocket(socket as never, 7, "alpha.txt", destPath),
      ).resolves.toEqual({ ok: true });

      expect(socket.writes).toHaveLength(1);
      expect(socket.writes[0]?.toString("latin1")).toBe(
        "GET /get/7/alpha.txt HTTP/1.1\r\nUser-Agent: Gnutella\r\nHost: 9.8.7.6:4321\r\nConnection: Keep-Alive\r\nRange: bytes=5-\r\n\r\n",
      );
      expect(captured!).toEqual({
        destPath,
        label: "9.8.7.6:4321",
        existing: 5,
      });
    });
  });

  test("reads HTTP downloads for both resume success and truncated responses", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const resumedSocket = new MockSocket("9.8.7.6", 4321);
      const resumedPath = path.join(dir, "downloads", "resume.bin");

      await fs.mkdir(path.dirname(resumedPath), { recursive: true });
      await fs.writeFile(resumedPath, "hello", "utf8");

      const resumed = node.readHttpDownload(
        resumedSocket as never,
        resumedPath,
        "9.8.7.6:4321",
        5,
      );
      resumedSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.0 206 Partial Content\r\nContent-length: 3\r\n\r\nXYZ",
          "latin1",
        ),
      );

      await expect(resumed).resolves.toEqual({
        destPath: resumedPath,
        bytes: 8,
        label: "9.8.7.6:4321",
      });
      await expect(fs.readFile(resumedPath, "utf8")).resolves.toBe(
        "helloXYZ",
      );
      expect(resumedSocket.ended).toBe(false);

      const zeroStartSocket = new MockSocket("9.8.7.6", 4321);
      const zeroStartPath = path.join(dir, "downloads", "zero-start.bin");
      const zeroStart = node.readHttpDownload(
        zeroStartSocket as never,
        zeroStartPath,
        "9.8.7.6:4321",
        0,
      );
      zeroStartSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 0-4/5\r\n\r\nhello",
          "latin1",
        ),
      );

      await expect(zeroStart).resolves.toEqual({
        destPath: zeroStartPath,
        bytes: 5,
        label: "9.8.7.6:4321",
      });
      await expect(fs.readFile(zeroStartPath, "utf8")).resolves.toBe(
        "hello",
      );
      expect(zeroStartSocket.ended).toBe(false);

      const truncatedSocket = new MockSocket("9.8.7.6", 4321);
      const truncatedPath = path.join(dir, "downloads", "truncated.bin");
      const truncated = node.readHttpDownload(
        truncatedSocket as never,
        truncatedPath,
        "9.8.7.6:4321",
        0,
      );
      truncatedSocket.emit(
        "data",
        Buffer.from(
          "HTTP/1.0 200 OK\r\nContent-length: 5\r\n\r\nabc",
          "latin1",
        ),
      );
      truncatedSocket.emit("end");

      await expect(truncated).rejects.toThrow(
        "connection closed before full body received",
      );
      expect(truncatedSocket.destroyed).toBe(true);
    });
  });

  test("falls back from uri-res requests to /get downloads when direct urn downloads fail", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const destPath = path.join(dir, "downloads", "alpha.txt");
      const requests: string[] = [];
      const existingSizes: number[] = [];
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "alpha.txt",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "peer-1",
        sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      };

      node.doc.config.serveUriRes = true;
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, "hello", "utf8");
      (node as any).directDownloadViaRequest = async (
        _host: string,
        _port: number,
        request: string,
        _passedDestPath: string,
        existing: number,
      ) => {
        requests.push(request);
        existingSizes.push(existing);
        if (requests.length === 1) throw new Error("uri-res failed");
        return { ok: true };
      };

      await expect(
        node.directDownload(hit as never, destPath),
      ).resolves.toEqual({ ok: true });

      expect(requests).toHaveLength(2);
      expect(requests[0]).toContain(
        "GET /uri-res/N2R?urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA HTTP/1.1",
      );
      expect(requests[1]).toContain("GET /get/5/alpha.txt HTTP/1.1");
      expect(existingSizes).toEqual([5, 5]);
    });
  });

  test("records direct and push downloads while emitting result events", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: string[] = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) => events.push(event.type),
      });
      const hit = {
        resultNo: 7,
        queryIdHex: "aa".repeat(16),
        queryHops: 2,
        remoteHost: "9.8.7.6",
        remotePort: 4321,
        speedKBps: 128,
        fileIndex: 5,
        fileName: "alpha.txt",
        fileSize: 99,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "peer-1",
      };
      const fallbackPath = path.join(dir, "custom", "push.bin");

      node.lastResults = [hit as never];
      (node as any).directDownload = async () => ({ ok: true });

      await node.downloadResult(7);
      expect(node.getDownloads()).toHaveLength(1);
      expect(node.getDownloads()[0]).toMatchObject({
        fileName: "alpha.txt",
        bytes: 99,
        host: "9.8.7.6",
        port: 4321,
        mode: "direct",
        destPath: path.resolve(
          path.join(node.config().downloadsDir, "alpha.txt"),
        ),
      });
      expect(events).toEqual(["DOWNLOAD_SUCCEEDED"]);

      events.length = 0;
      node.downloads = [];
      (node as any).directDownload = async () => {
        throw new Error("direct failed");
      };
      (node as any).sendPush = async (
        _hit: unknown,
        destPath: string,
      ) => ({ destPath });

      await node.downloadResult(7, fallbackPath);
      expect(node.getDownloads()).toHaveLength(1);
      expect(node.getDownloads()[0]).toMatchObject({
        mode: "push",
        destPath: path.resolve(fallbackPath),
      });
      expect(events).toEqual([
        "DOWNLOAD_DIRECT_FAILED",
        "DOWNLOAD_SUCCEEDED",
      ]);
      expect(node.getResults()).toHaveLength(1);
    });
  });

  test("emits skipped and sent query events and exposes peer-facing getters", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: string[] = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) => events.push(event.type),
      });
      let pingTtl = -1;
      let queryArgs: {
        ttl: number;
        search: string;
        maxHits: number;
      } | null = null;

      (node as any).broadcast = (
        _payloadType: number,
        _descriptorId: Buffer,
        ttl: number,
      ) => {
        pingTtl = ttl;
      };
      const queries: Array<{
        ttl: number;
        search: string;
        maxHits: number;
      }> = [];
      (node as any).broadcastQuery = (
        _descriptorId: Buffer,
        ttl: number,
        _hops: number,
        payload: Buffer,
        search: string,
      ) => {
        const parsed = parseQuery(payload);
        queryArgs = { ttl, search, maxHits: parsed.maxHits };
        queries.push(queryArgs);
      };

      node.sendQuery("alpha");
      expect(events).toEqual(["QUERY_SKIPPED"]);

      const peer = makePeer("peer-1");
      peer.remoteLabel = "9.8.7.6:4321";
      peer.outbound = true;
      peer.dialTarget = "9.8.7.6:4321";
      node.peers.set(peer.key, peer as never);

      node.sendPing(99);
      node.sendQuery("alpha");
      node.sendQuery("alpha", 99);

      expect(pingTtl).toBe(node.config().maxTtl);
      expect(queryArgs!).toEqual({
        ttl: node.config().maxTtl,
        search: "alpha",
        maxHits: node.config().maxResultsPerQuery,
      });
      expect(queries).toEqual([
        {
          ttl: node.config().defaultQueryTtl,
          search: "alpha",
          maxHits: node.config().maxResultsPerQuery,
        },
        {
          ttl: node.config().maxTtl,
          search: "alpha",
          maxHits: node.config().maxResultsPerQuery,
        },
      ]);
      expect(events).toEqual([
        "QUERY_SKIPPED",
        "PING_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
      ]);
      expect(node.getPeers()).toEqual([
        {
          key: "peer-1",
          remoteLabel: "9.8.7.6:4321",
          outbound: true,
          dialTarget: "9.8.7.6:4321",
        },
      ]);
      expect(node.getServentIdHex()).toMatch(/^[0-9a-f]{32}$/);
      expect(node.getStatus()).toEqual({
        peers: 1,
        shares: 0,
        results: 0,
        knownPeers: 0,
      });

      node.lastResults = [{ resultNo: 99 } as never];
      node.resultSeq = 100;
      node.clearResults();

      expect(node.getResults()).toEqual([]);
      expect(node.resultSeq).toBe(1);
      expect(node.getStatus()).toEqual({
        peers: 1,
        shares: 0,
        results: 0,
        knownPeers: 0,
      });
      await expect(node.downloadResult(99)).rejects.toThrow(
        "no such result 99",
      );
    });
  });

  test("connectKnownPeers bootstraps multiple peer dials in parallel", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      node.doc.config.maxConnections = 3;
      node.doc.config.connectTimeoutMs = 5000;
      node.doc.config.peers = [
        "1.1.1.1:1111",
        "2.2.2.2:2222",
        "3.3.3.3:3333",
        "4.4.4.4:4444",
        "5.5.5.5:5555",
      ];

      const started: string[] = [];
      const timeouts: number[] = [];
      const releases: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;

      (node as any).connectPeer = async (
        host: string,
        port: number,
        timeoutMs: number,
      ) => {
        const target = `${host}:${port}`;
        started.push(target);
        timeouts.push(timeoutMs);
        node.dialing.add(target);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            node.dialing.delete(target);
            inFlight -= 1;
            resolve();
          });
        });
      };

      const bootstrap = node.connectKnownPeers();

      expect(started).toEqual([
        "1.1.1.1:1111",
        "2.2.2.2:2222",
        "3.3.3.3:3333",
      ]);
      expect(maxInFlight).toBe(
        Math.min(
          BOOTSTRAP_CONNECT_CONCURRENCY,
          node.doc.config.maxConnections,
        ),
      );
      expect(timeouts).toEqual([2500, 2500, 2500]);

      while (releases.length) {
        releases.shift()?.();
        await Promise.resolve();
      }

      await bootstrap;
      expect(started).toEqual(node.doc.config.peers);
      expect(timeouts).toEqual(
        node.doc.config.peers.map(() =>
          Math.floor(
            node.doc.config.connectTimeoutMs /
              BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
          ),
        ),
      );
    });
  });

  test("start schedules recurring work and reports maintenance failures", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: Array<{
        type: string;
        operation?: string;
        message?: string;
      }> = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) =>
          events.push(event as unknown as (typeof events)[number]),
      });
      const scheduled: Array<{ ms: number; fn: () => void }> = [];
      const pingTtls: number[] = [];
      let refreshCalls = 0;
      let reconnectCalls = 0;
      let saveCalls = 0;
      let startServerCalls = 0;
      let pruneCalls = 0;

      (node as any).refreshShares = async () => {
        refreshCalls += 1;
        if (refreshCalls > 1) throw new Error("rescan failed");
      };
      (node as any).startServer = async () => {
        startServerCalls += 1;
      };
      (node as any).schedule = (ms: number, fn: () => void) => {
        scheduled.push({ ms, fn });
      };
      (node as any).connectKnownPeers = async () => {
        reconnectCalls += 1;
        throw new Error(
          reconnectCalls === 1
            ? "initial reconnect failed"
            : "scheduled reconnect failed",
        );
      };
      (node as any).sendPing = (ttl: number) => {
        pingTtls.push(ttl);
      };
      (node as any).pruneMaps = () => {
        pruneCalls += 1;
      };
      (node as any).save = async () => {
        saveCalls += 1;
        throw new Error("save failed");
      };

      await node.start();
      await Promise.resolve();

      expect(startServerCalls).toBe(1);
      expect(refreshCalls).toBe(1);
      expect(scheduled.map((entry) => entry.ms)).toEqual([
        doc.config.rescanSharesSec * 1000,
        5000,
        doc.config.reconnectIntervalSec * 1000,
        doc.config.pingIntervalSec * 1000,
        15000,
      ]);

      for (const entry of scheduled) entry.fn();
      await Promise.resolve();

      expect(refreshCalls).toBe(2);
      expect(reconnectCalls).toBe(2);
      expect(pruneCalls).toBe(1);
      expect(saveCalls).toBe(1);
      expect(pingTtls).toEqual([doc.config.defaultPingTtl]);

      const maintenance = events.filter(
        (event) => event.type === "MAINTENANCE_ERROR",
      );
      expect(maintenance).toEqual([
        expect.objectContaining({
          operation: "RECONNECT",
          message: "initial reconnect failed",
        }),
        expect.objectContaining({
          operation: "SHARE_RESCAN",
          message: "rescan failed",
        }),
        expect.objectContaining({
          operation: "RECONNECT",
          message: "scheduled reconnect failed",
        }),
        expect.objectContaining({
          operation: "SAVE",
          message: "save failed",
        }),
      ]);
    });
  });

  test("emits inbound peer message events for received descriptors", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const events: Array<Record<string, unknown>> = [];
      const node = new GnutellaServent(configPath, doc, {
        onEvent: (event) =>
          events.push(event as unknown as Record<string, unknown>),
      });
      const peer = makePeer("9.8.7.6:4321");
      const payload = Buffer.alloc(0);
      const frame = buildHeader(
        Buffer.alloc(16, 0xaa),
        TYPE.PING,
        9,
        2,
        payload,
      );

      peer.buf = Buffer.concat([frame, payload]);
      node.consumePeerBuffer(peer);

      expect(events).toEqual([
        expect.objectContaining({
          type: "PEER_MESSAGE_RECEIVED",
          peer: {
            key: "9.8.7.6:4321",
            remoteLabel: "9.8.7.6:4321",
            outbound: false,
          },
          payloadType: TYPE.PING,
          payloadTypeName: "PING",
          descriptorIdHex: "aa".repeat(16),
          ttl: 7,
          hops: 2,
          payloadLength: 0,
        }),
      ]);
    });
  });

  test("prunes stale routes, pending pushes, and cached pongs", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      node.doc.config.seenTtlSec = 1;
      node.doc.config.routeTtlSec = 1;
      node.doc.config.pushWaitMs = 1_000;
      const now = Date.now();
      const rejected: string[] = [];

      node.seen.set("stale-seen", now - 2_000);
      node.seen.set("fresh-seen", now);
      node.pingRoutes.set("stale-ping", {
        peerKey: "peer-1",
        ts: now - 2_000,
      } as never);
      node.pingRoutes.set("local-ping", "__local__" as never);
      node.queryRoutes.set("stale-query", {
        peerKey: "peer-1",
        ts: now - 2_000,
      } as never);
      node.queryRoutes.set("local-query", "__local__" as never);
      node.pushRoutes.set("stale-push", {
        peerKey: "peer-1",
        ts: now - 2_000,
      } as never);
      node.pendingPushes.set("servent-1", [
        {
          serventIdHex: "servent-1",
          result: { fileIndex: 1 } as never,
          destPath: path.join(dir, "downloads", "stale.bin"),
          createdAt: now - 2_000,
          resolve: () => void 0,
          reject: (error) =>
            rejected.push(
              error instanceof Error ? error.message : String(error),
            ),
        },
        {
          serventIdHex: "servent-1",
          result: { fileIndex: 2 } as never,
          destPath: path.join(dir, "downloads", "fresh.bin"),
          createdAt: now,
          resolve: () => void 0,
          reject: () => void 0,
        },
      ]);
      node.pongCache.set("stale-pong", {
        payload: Buffer.from("stale", "utf8"),
        at: now - 2_000,
      });
      node.pongCache.set("fresh-pong", {
        payload: Buffer.from("fresh", "utf8"),
        at: now,
      });
      node.lastResults = Array.from(
        { length: 1_002 },
        (_unused, index) => ({ resultNo: index + 1 }) as never,
      );

      node.pruneMaps();

      expect(node.seen.has("stale-seen")).toBe(false);
      expect(node.seen.has("fresh-seen")).toBe(true);
      expect(node.pingRoutes.has("stale-ping")).toBe(false);
      expect(node.pingRoutes.get("local-ping")).toBe("__local__");
      expect(node.queryRoutes.has("stale-query")).toBe(false);
      expect(node.queryRoutes.get("local-query")).toBe("__local__");
      expect(node.pushRoutes.has("stale-push")).toBe(false);
      expect(rejected).toEqual(["push timed out"]);
      expect(node.pendingPushes.get("servent-1")).toHaveLength(1);
      expect(node.pongCache.has("stale-pong")).toBe(false);
      expect(node.pongCache.has("fresh-pong")).toBe(true);
      expect(node.lastResults).toHaveLength(1_000);
      expect(node.lastResults[0]?.resultNo).toBe(3);
    });
  });

  test("applies route-table updates and only sends QRP tables when negotiated", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      doc.config.sharedDir = path.join(dir, "shared");
      doc.config.downloadsDir = path.join(dir, "downloads");
      doc.config.enableQrp = true;
      const node = new GnutellaServent(configPath, doc);
      const share = makeShare(
        1,
        path.join(doc.config.sharedDir, "alpha-track.txt"),
        "alpha-track.txt",
      );
      node.qrpTable.rebuildFromShares([share]);

      const peer = makePeer("peer-qrp");
      const sent: Buffer[] = [];
      (node as any).sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        _ttl: number,
        _hops: number,
        payload: Buffer,
      ) => {
        expect(payloadType).toBe(TYPE.ROUTE_TABLE_UPDATE);
        sent.push(Buffer.from(payload));
      };

      await node.sendQrpTable(peer as never);
      expect(sent).toHaveLength(0);

      peer.capabilities.queryRoutingVersion = "0.1";
      node.doc.config.enableQrp = false;
      await node.sendQrpTable(peer as never);
      expect(sent).toHaveLength(0);

      node.doc.config.enableQrp = true;
      await node.sendQrpTable(peer as never);
      expect(sent.length).toBeGreaterThan(1);
      expect(parseRouteTableUpdate(sent[0])?.variant).toBe("reset");
      for (const payload of sent.slice(1)) {
        expect(parseRouteTableUpdate(payload).variant).toBe("patch");
      }

      const remote = makePeer("remote-qrp");
      node.onRouteTableUpdate(remote as never, sent[1]);
      expect(remote.remoteQrp.resetSeen).toBe(false);
      node.onRouteTableUpdate(remote as never, sent[0]);
      for (const payload of sent.slice(1))
        node.onRouteTableUpdate(remote as never, payload);
      expect(remote.remoteQrp.resetSeen).toBe(true);
      expect(remote.remoteQrp.table).not.toBeNull();
    });
  });

  test("closes sockets on Bye even when the payload is malformed", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));

      const validPeer = makePeer("valid-bye");
      node.onBye(validPeer as never, encodeBye(200, "closing"));
      expect((validPeer.socket as unknown as MockSocket).ended).toBe(true);

      const malformedPeer = makePeer("bad-bye");
      expect(() =>
        node.onBye(malformedPeer as never, Buffer.from([0x00])),
      ).not.toThrow();
      expect((malformedPeer.socket as unknown as MockSocket).ended).toBe(
        true,
      );
    });
  });

  test("processes successive keep-alive HEAD requests on one HTTP socket", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const share = makeShare(
        1,
        path.join(node.doc.config.sharedDir, "alpha.txt"),
        "alpha.txt",
      );
      await fs.mkdir(path.dirname(share.abs), { recursive: true });
      await fs.writeFile(share.abs, "hello", "utf8");
      node.shares = [share];
      node.sharesByIndex = new Map([[share.index, share]]);
      node.sharesByUrn = new Map([[share.sha1Urn.toLowerCase(), share]]);

      const socket = new MockSocket();
      (node as any).startHttpSession(
        socket as never,
        "HEAD /get/1/alpha.txt HTTP/1.1\r\n\r\n",
      );

      await sleep(5);
      socket.emit(
        "data",
        Buffer.from(
          `HEAD /uri-res/N2R?${share.sha1Urn} HTTP/1.1\r\nConnection: close\r\n\r\n`,
          "latin1",
        ),
      );

      await sleep(25);

      const raw = Buffer.concat(socket.writes).toString("latin1");
      expect(raw.match(/HTTP\/1\.1 200 OK/g)?.length).toBe(2);
      expect(raw).toContain("Connection: Keep-Alive\r\n");
      expect(raw).toContain("Connection: close\r\n");
      expect(socket.ended).toBe(true);
    });
  });
});
