import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  GnutellaServent,
  defaultDoc,
  parseQuery,
} from "../../../../src/protocol";
import { TYPE } from "../../../../src/const";
import {
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  withTempDir,
} from "./helpers";

describe("protocol node", () => {
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
      ) => ({
        destPath,
      });

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

  test("downloadResult auto-picks a unique filename when the default path already exists", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const node = new GnutellaServent(configPath, doc);
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
      const occupiedPath = path.join(
        node.config().downloadsDir,
        "alpha.txt",
      );
      let seenDestPath = "";

      await fs.mkdir(path.dirname(occupiedPath), { recursive: true });
      await fs.writeFile(occupiedPath, "existing", "utf8");
      node.lastResults = [hit as never];
      (node as any).directDownload = async (
        _hit: unknown,
        destPath: string,
      ) => {
        seenDestPath = destPath;
        return { ok: true };
      };

      await node.downloadResult(7);

      expect(seenDestPath).toBe(
        path.resolve(
          path.join(node.config().downloadsDir, "alpha (2).txt"),
        ),
      );
      expect(node.getDownloads()[0]).toMatchObject({
        destPath: path.resolve(
          path.join(node.config().downloadsDir, "alpha (2).txt"),
        ),
      });
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
        parsedSearch: string;
        maxHits: number;
        urns: string[];
      } | null = null;

      (node as any).sendToPeer = (
        _peer: unknown,
        payloadType: number,
        _descriptorId: Buffer,
        ttl: number,
        _hops: number,
        _payload: Buffer,
      ) => {
        if (payloadType !== TYPE.PING) return;
        pingTtl = ttl;
      };
      const queries: Array<{
        ttl: number;
        search: string;
        parsedSearch: string;
        maxHits: number;
        urns: string[];
      }> = [];
      (node as any).broadcastQuery = (
        _descriptorId: Buffer,
        ttl: number,
        _hops: number,
        payload: Buffer,
        search: string,
      ) => {
        const parsed = parseQuery(payload);
        queryArgs = {
          ttl,
          search,
          parsedSearch: parsed.search,
          maxHits: parsed.maxHits,
          urns: parsed.urns,
        };
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
        parsedSearch: "alpha",
        maxHits: node.config().maxResultsPerQuery,
        urns: [],
      });
      expect(queries).toEqual([
        {
          ttl: node.config().defaultQueryTtl,
          search: "alpha",
          parsedSearch: "alpha",
          maxHits: node.config().maxResultsPerQuery,
          urns: [],
        },
        {
          ttl: node.config().maxTtl,
          search: "alpha",
          parsedSearch: "alpha",
          maxHits: node.config().maxResultsPerQuery,
          urns: [],
        },
      ]);

      node.sendQuery("urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2 alpha", 2);

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2 alpha",
        parsedSearch: "alpha",
        maxHits: node.config().maxResultsPerQuery,
        urns: ["urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
      });
      expect(events).toEqual([
        "QUERY_SKIPPED",
        "PING_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
      ]);

      node.sendQuery("urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2", 2);

      expect(queries.at(-1)).toEqual({
        ttl: 2,
        search: "urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2",
        parsedSearch: "",
        maxHits: node.config().maxResultsPerQuery,
        urns: ["urn:sha1:TXZM6VTBVPDC7YVN7RPM3FLDXUAH6HA2"],
      });

      node.sendQuery("    ", 1);

      expect(queries.at(-1)).toEqual({
        ttl: 1,
        search: "    ",
        parsedSearch: "    ",
        maxHits: node.config().maxResultsPerQuery,
        urns: [],
      });
      expect(events).toEqual([
        "QUERY_SKIPPED",
        "PING_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
        "QUERY_SENT",
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
});
