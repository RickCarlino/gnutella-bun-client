import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildHeader,
  defaultDoc,
  encodeBye,
  GnutellaServent,
  parseRouteTableUpdate,
} from "../../../../src/protocol";
import { TYPE } from "../../../../src/const";
import { sleep } from "../../../../src/shared";
import {
  makeNode,
  makePeer,
  makeShare,
  MockSocket,
  overrideRuntimeConfig,
  withMockNetworkInterfaces,
  withTempDir,
} from "./helpers";

describe("protocol node", () => {
  test("start schedules recurring work and reports maintenance failures", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
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
          node.config().rescanSharesSec * 1000,
          5000,
          node.config().reconnectIntervalSec * 1000,
          node.config().pingIntervalSec * 1000,
          15000,
        ]);

        for (const entry of scheduled) entry.fn();
        await Promise.resolve();

        expect(refreshCalls).toBe(2);
        expect(reconnectCalls).toBe(2);
        expect(pruneCalls).toBe(1);
        expect(saveCalls).toBe(1);
        expect(pingTtls).toEqual([node.config().defaultPingTtl]);

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
  });

  test("emits inbound peer message events for received descriptors", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
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
  });

  test("prunes stale routes, pending pushes, and cached pongs", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      overrideRuntimeConfig(node, {
        seenTtlSec: 1,
        routeTtlSec: 1,
        pushWaitMs: 1_000,
      });
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
      doc.config.dataDir = dir;
      const node = new GnutellaServent(configPath, doc);
      const share = makeShare(
        1,
        path.join(node.config().downloadsDir, "alpha-track.txt"),
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
      overrideRuntimeConfig(node, { enableQrp: false });
      await node.sendQrpTable(peer as never);
      expect(sent).toHaveLength(0);

      overrideRuntimeConfig(node, { enableQrp: true });
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
      expect(
        (malformedPeer.socket as unknown as { ended: boolean }).ended,
      ).toBe(true);
    });
  });

  test("processes successive keep-alive HEAD requests on one HTTP socket", async () => {
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
