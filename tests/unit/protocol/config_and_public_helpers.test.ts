import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  buildGetRequest,
  buildHeader,
  defaultDoc,
  encodePong,
  encodePush,
  GnutellaServent,
  loadDoc,
  parseHeader,
  parsePong,
  parsePush,
  writeDoc,
} from "../../../src/protocol";
import {
  bytesToIpLE,
  ipToBytesLE,
  safeFileName,
  splitArgs,
} from "../../../src/shared";
import type { Peer } from "../../../src/protocol/node_types";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "protocol-cover-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makePeer(label = "1.2.3.4:6346"): Peer {
  return {
    key: label,
    socket: {
      destroy() {
        return this;
      },
    } as net.Socket,
    buf: Buffer.alloc(0),
    outbound: false,
    dialTarget: label,
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
      listenIp: { host: "5.6.7.8", port: 6347 },
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
    connectedAt: Date.now(),
  };
}

describe("protocol config and public helpers", () => {
  test("creates, persists, and normalizes config documents", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "nested", "protocol.json");
      const created = await loadDoc(configPath);
      const createdRuntime = new GnutellaServent(
        configPath,
        created,
      ).config();

      expect(created.config.dataDir).toBe(path.join(dir, "nested"));
      expect(created.config.advertisedHost).toBeUndefined();
      expect(created.config.advertisedPort).toBeUndefined();
      await expect(fs.stat(configPath)).resolves.toBeDefined();
      await expect(
        fs.stat(createdRuntime.downloadsDir),
      ).resolves.toBeDefined();

      created.state.peers = {
        "1.2.3.4:6346": 0,
        "9.9.9.9:6346": 123.9,
        invalid: 55,
      } as never;
      created.state.serventIdHex = "not-a-valid-id";

      await writeDoc(configPath, created);
      await fs.rm(createdRuntime.downloadsDir, {
        recursive: true,
        force: true,
      });

      const loaded = await loadDoc(configPath);
      const loadedRuntime = new GnutellaServent(
        configPath,
        loaded,
      ).config();
      expect(loaded.state.peers).toEqual({
        "9.9.9.9:6346": 123,
        "1.2.3.4:6346": 0,
      });
      expect(loaded.config.dataDir).toBe(path.join(dir, "nested"));
      expect(loaded.config.advertisedHost).toBeUndefined();
      expect(loaded.state.serventIdHex).toMatch(/^[0-9a-f]{32}$/);
      await expect(
        fs.stat(loadedRuntime.downloadsDir),
      ).resolves.toBeDefined();
    });
  });

  test("exposes peer user agents through public peer info", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = new GnutellaServent(configPath, defaultDoc(configPath));
      const peer = makePeer("1.2.3.4:6346");

      peer.capabilities.userAgent = "Peer/1.0";
      node.peers.set(peer.key, peer as never);

      expect(node.getPeers()).toEqual([
        {
          key: "1.2.3.4:6346",
          remoteLabel: "1.2.3.4:6346",
          outbound: false,
          dialTarget: "1.2.3.4:6346",
          userAgent: "Peer/1.0",
        },
      ]);
    });
  });

  test("drops legacy persisted download history from state", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {},
            state: {
              serventIdHex: "ab".repeat(16),
              downloads: [{ fileName: "stale.bin" }],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const loaded = await loadDoc(configPath);

      expect(loaded.state).toEqual({
        serventIdHex: "ab".repeat(16),
        peers: {},
      });
    });
  });

  test("migrates legacy peer arrays into the unified peer state map", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      await fs.writeFile(
        configPath,
        `${JSON.stringify(
          {
            config: {
              peers: ["1.2.3.4:6346", "9.9.9.9:6346"],
            },
            state: {
              serventIdHex: "ab".repeat(16),
              knownPeers: ["7.7.7.7:7777"],
              goodPeers: ["8.8.8.8:8888"],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const loaded = await loadDoc(configPath);

      expect(loaded.state.peers).toEqual({
        "8.8.8.8:8888": 0,
        "7.7.7.7:7777": 0,
        "9.9.9.9:6346": 0,
        "1.2.3.4:6346": 0,
      });
    });
  });

  test("builds GET requests with Host headers and splits quoted args", () => {
    expect(
      buildGetRequest(12, "dir#/file name.txt", 128, "1.2.3.4", 6346),
    ).toBe(
      "GET /get/12/dir%23/file%20name.txt HTTP/1.1\r\nUser-Agent: Gnutella\r\nHost: 1.2.3.4:6346\r\nConnection: Keep-Alive\r\nRange: bytes=128-\r\n\r\n",
    );

    expect(
      splitArgs(
        `query "two words" 'three words' escaped\\ space plain\\\"quote`,
      ),
    ).toEqual([
      "query",
      "two words",
      "three words",
      "escaped space",
      'plain"quote',
    ]);
  });

  test("round-trips public protocol helpers and sanitizes filenames", () => {
    const descriptorId = Buffer.from(
      "00112233445566778899aabbccddeeff",
      "hex",
    );
    const payload = Buffer.from("hello", "utf8");
    const frame = buildHeader(descriptorId, 0x80, 7, 2, payload);
    const parsed = parseHeader(frame.subarray(0, 23));

    expect(parsed).toEqual({
      descriptorId,
      descriptorIdHex: "00112233445566778899aabbccddeeff",
      payloadType: 0x80,
      ttl: 7,
      hops: 2,
      payloadLength: 5,
    });
    expect(frame.subarray(23)).toEqual(payload);

    expect(ipToBytesLE("1.2.3.4")).toEqual(Buffer.from([4, 3, 2, 1]));
    expect(bytesToIpLE(Buffer.from([4, 3, 2, 1]))).toBe("1.2.3.4");
    expect(safeFileName("dir/name\0bin")).toBe("dir_name_bin");
    expect(safeFileName("...")).toBe("_");

    const ggep = Buffer.from([0xc3, 0x01, 0x02]);
    expect(parsePong(encodePong(6346, "5.6.7.8", 12, 34, ggep))).toEqual({
      port: 6346,
      ip: "5.6.7.8",
      files: 12,
      kbytes: 34,
      ggep,
    });

    const serventId = Buffer.from(
      "ffeeddccbbaa99887766554433221100",
      "hex",
    );
    const pushPayload = Buffer.concat([
      encodePush(serventId, 9, "9.8.7.6", 4321),
      ggep,
    ]);
    expect(parsePush(pushPayload)).toEqual({
      serventId,
      serventIdHex: serventId.toString("hex"),
      fileIndex: 9,
      ip: "9.8.7.6",
      port: 4321,
      ggep,
    });
  });

  test("rejects malformed public protocol helper inputs", () => {
    expect(() => ipToBytesLE("300.2.3.4")).toThrow("invalid IPv4 address");
    expect(() => bytesToIpLE(Buffer.from([1, 2, 3]))).toThrow(
      "expected 4 bytes for IPv4, got 3",
    );
    expect(() => parsePong(Buffer.alloc(13))).toThrow(
      "invalid pong length 13",
    );
    expect(() => parsePush(Buffer.alloc(25))).toThrow(
      "invalid push length 25",
    );
  });

  test("emits maintenance events, manages timers, and reports peer dial state", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const doc = defaultDoc(configPath);
      const node = new GnutellaServent(configPath, doc);
      const events: string[] = [];
      const unsubscribe = node.subscribe((event) =>
        events.push(event.type),
      );

      node.emitMaintenanceError("SAVE", new Error("disk full"));
      node.schedule(60_000, () => void 0);

      expect(events).toEqual(["MAINTENANCE_ERROR"]);
      expect(node.peerCount()).toBe(0);
      expect(node.config()).toMatchObject({
        dataDir: dir,
        downloadsDir: path.join(dir, "downloads"),
      });

      node.dialing.add("1.2.3.4:6346");
      expect(node.peerDialState("1.2.3.4", 6346)).toBe("dialing");
      node.dialing.clear();

      node.peers.set("peer-1", makePeer() as never);
      expect(node.peerDialState("1.2.3.4", 6346)).toBe("connected");
      expect(node.peerDialState("5.6.7.8", 6347)).toBe("connected");
      expect(node.peerDialState("8.8.8.8", 6346)).toBe("none");

      unsubscribe();
      node.emitMaintenanceError("SAVE", "ignored after unsubscribe");
      expect(events).toEqual(["MAINTENANCE_ERROR"]);

      await node.stop();
    });
  });
});
