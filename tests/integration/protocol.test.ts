import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  defaultDoc,
  GnutellaServent,
  loadDoc,
  writeDoc,
} from "../../src/protocol";
import { withFakeNet } from "../helpers/fake_net";
import { sleep } from "../../src/shared";
import type { GnutellaEvent, RuntimeConfig } from "../../src/types";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "protocol-integration-"),
  );
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to allocate an ephemeral port"));
        return;
      }
      const { port } = addr;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 3_000,
  describeState?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  const suffix = describeState ? ` (${describeState()})` : "";
  throw new Error(`timed out waiting for ${description}${suffix}`);
}

async function readSocketResponse(
  port: number,
  request: string,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let done = false;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("latin1"));
    });
  });
}

type MeshNodeName = "A" | "B" | "C";

type MeshNode = {
  name: MeshNodeName;
  configPath: string;
  downloadsDir: string;
  listenPort: number;
  advertisedPort: number;
  node: GnutellaServent;
  events: GnutellaEvent[];
};

type Mesh = {
  nodes: Record<MeshNodeName, MeshNode>;
  badPort: number;
};

async function writeShare(
  node: MeshNode,
  rel: string,
  contents: string,
): Promise<void> {
  const abs = path.join(node.downloadsDir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents, "utf8");
}

function eventsOfType<T extends GnutellaEvent["type"]>(
  node: MeshNode,
  type: T,
): Extract<GnutellaEvent, { type: T }>[] {
  return node.events.filter(
    (event): event is Extract<GnutellaEvent, { type: T }> =>
      event.type === type,
  );
}

function newResults(node: MeshNode, fromIndex: number) {
  return node.node.getResults().slice(fromIndex);
}

function overrideRuntimeConfig(
  node: GnutellaServent,
  patch: Partial<RuntimeConfig>,
): void {
  const original = node.config.bind(node);
  (node as unknown as { config: () => RuntimeConfig }).config = () => ({
    ...original(),
    ...patch,
  });
}

function peerState(
  entries: Array<[string, number]>,
): Record<string, number> {
  return Object.fromEntries(entries);
}

async function createMeshNode(
  root: string,
  name: MeshNodeName,
  options: {
    listenPort: number;
    advertisedPort: number;
    advertisedSpeedKBps: number;
    peers: string[];
    shares: Record<string, string>;
  },
): Promise<MeshNode> {
  const dir = path.join(root, name.toLowerCase());
  const configPath = path.join(dir, "protocol.json");
  const downloadsDir = path.join(dir, "downloads");

  await fs.mkdir(downloadsDir, { recursive: true });
  for (const [rel, contents] of Object.entries(options.shares)) {
    const abs = path.join(downloadsDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents, "utf8");
  }

  const doc = defaultDoc(configPath);
  const nowSec = Math.floor(Date.now() / 1000);
  doc.config.listenHost = "127.0.0.1";
  doc.config.listenPort = options.listenPort;
  doc.config.advertisedHost = "127.0.0.1";
  doc.config.advertisedPort = options.advertisedPort;
  doc.config.dataDir = dir;
  doc.state.peers = peerState(options.peers.map((peer) => [peer, nowSec]));

  await writeDoc(configPath, doc);
  const loaded = await loadDoc(configPath);
  const events: GnutellaEvent[] = [];
  const node = new GnutellaServent(configPath, loaded, {
    onEvent: (event) => events.push(event),
  });
  overrideRuntimeConfig(node, {
    maxConnections: 4,
    connectTimeoutMs: 1_000,
    pingIntervalSec: 3_600,
    reconnectIntervalSec: 3_600,
    rescanSharesSec: 3_600,
    routeTtlSec: 60,
    seenTtlSec: 60,
    defaultPingTtl: 2,
    defaultQueryTtl: 2,
    downloadTimeoutMs: 1_500,
    pushWaitMs: 1_500,
    maxResultsPerQuery: 10,
    advertisedSpeedKBps: options.advertisedSpeedKBps,
    enableCompression: false,
    enableQrp: false,
    enableBye: true,
    enablePongCaching: true,
    enableGgep: true,
  });

  return {
    name,
    configPath,
    downloadsDir,
    listenPort: options.listenPort,
    advertisedPort: options.advertisedPort,
    node,
    events,
  };
}

async function createMesh(root: string): Promise<Mesh> {
  const [aPort, bPort, cPort, badPort] = await Promise.all([
    getFreePort(),
    getFreePort(),
    getFreePort(),
    getFreePort(),
  ]);

  const nodes: Record<MeshNodeName, MeshNode> = {
    A: await createMeshNode(root, "A", {
      listenPort: aPort,
      advertisedPort: aPort,
      advertisedSpeedKBps: 256,
      peers: [`127.0.0.1:${bPort}`],
      shares: {
        "a-local.txt": "shared by A",
      },
    }),
    B: await createMeshNode(root, "B", {
      listenPort: bPort,
      advertisedPort: bPort,
      advertisedSpeedKBps: 128,
      peers: [],
      shares: {
        "mesh-common-b.txt": "common from B",
        "resume-b.bin": "resume-from-b",
      },
    }),
    C: await createMeshNode(root, "C", {
      listenPort: cPort,
      advertisedPort: badPort,
      advertisedSpeedKBps: 768,
      peers: [`127.0.0.1:${bPort}`],
      shares: {
        "mesh-common-c.txt": "common from C",
        "push-only-c.bin": "push-from-c",
      },
    }),
  };

  return { nodes, badPort };
}

async function withMesh<T>(fn: (mesh: Mesh) => Promise<T>): Promise<T> {
  return await withTempDir(async (root) => {
    const mesh = await createMesh(root);
    const { A, B, C } = mesh.nodes;
    try {
      await B.node.start();
      await A.node.start();
      await C.node.start();

      await waitFor(
        () =>
          A.node.peerCount() === 1 &&
          B.node.peerCount() === 2 &&
          C.node.peerCount() === 1,
        "A-B-C 0.6 mesh to come online",
      );

      await sleep(700);
      return await fn(mesh);
    } finally {
      await Promise.allSettled([
        A.node.stop(),
        B.node.stop(),
        C.node.stop(),
      ]);
    }
  });
}

async function withFakeMesh<T>(
  fn: (mesh: Mesh) => Promise<T>,
): Promise<T> {
  return await withFakeNet(async () => await withMesh(fn));
}

describe("Integration suite (0.6)", () => {
  test("connects peers added while already running", async () => {
    await withFakeNet(async () => {
      await withTempDir(async (root) => {
        const [aPort, bPort] = await Promise.all([
          getFreePort(),
          getFreePort(),
        ]);
        const a = await createMeshNode(root, "A", {
          listenPort: aPort,
          advertisedPort: aPort,
          advertisedSpeedKBps: 256,
          peers: [],
          shares: {},
        });
        const b = await createMeshNode(root, "B", {
          listenPort: bPort,
          advertisedPort: bPort,
          advertisedSpeedKBps: 128,
          peers: [],
          shares: {
            "live-connect.txt": "connected at runtime",
          },
        });

        try {
          await b.node.start();
          await a.node.start();
          expect(a.node.peerCount()).toBe(0);

          await expect(
            a.node.connectToPeer(`127.0.0.1:${bPort}`),
          ).resolves.toEqual({
            peer: `127.0.0.1:${bPort}`,
            status: "connected",
          });

          await waitFor(
            () => a.node.peerCount() === 1 && b.node.peerCount() === 1,
            "runtime 0.6 peer connection to come online",
          );

          const before = a.node.getResults().length;
          a.node.sendQuery("live-connect", 1);
          await waitFor(
            () =>
              newResults(a, before).some(
                (hit) => hit.fileName === "live-connect.txt",
              ),
            "runtime-connected 0.6 peer to answer a query",
          );
        } finally {
          await Promise.allSettled([a.node.stop(), b.node.stop()]);
        }
      });
    });
  });

  test("routes ping/pong, refresh, and query traffic across A -> B -> C", async () => {
    await withFakeMesh(async ({ nodes }) => {
      const { A, B, C } = nodes;
      const peerToB = A.node.getPeers()[0];

      expect(peerToB?.dialTarget).toBe(`127.0.0.1:${B.listenPort}`);
      expect(C.node.getPeers()[0]?.dialTarget).toBe(
        `127.0.0.1:${B.listenPort}`,
      );
      expect(B.node.getPeers()).toHaveLength(2);

      const pongsBefore = eventsOfType(A, "PONG").length;
      A.node.sendPing(2);
      const pingId =
        eventsOfType(A, "PING_SENT").at(-1)?.descriptorIdHex || "";
      await waitFor(
        () => eventsOfType(A, "PONG").length >= pongsBefore + 2,
        "A to receive 0.6 pongs from both B and C",
        3_000,
        () =>
          JSON.stringify({
            pingId,
            pongsBefore,
            pongEvents: eventsOfType(A, "PONG"),
            knownPeers: A.node.getKnownPeers(),
            bKnownPeers: B.node.getKnownPeers(),
            cKnownPeers: C.node.getKnownPeers(),
            aSeenPong: A.node.seen.has(`1:${pingId}`),
            bPingRoute: B.node.pingRoutes.get(pingId),
            bSeenPong: B.node.seen.has(`1:${pingId}`),
            cSeenPing: C.node.seen.has(`0:${pingId}`),
            cSeenPong: C.node.seen.has(`1:${pingId}`),
            aPeers: A.node.getPeers(),
            bPeers: B.node.getPeers(),
            cPeers: C.node.getPeers(),
          }),
      );

      expect(A.node.getKnownPeers()).toEqual(
        expect.arrayContaining([
          `127.0.0.1:${B.listenPort}`,
          `127.0.0.1:${C.advertisedPort}`,
        ]),
      );

      await writeShare(C, "late-route-c.txt", "late route from C");
      await C.node.refreshShares();
      expect(
        C.node
          .getShares()
          .some((share) => share.name === "late-route-c.txt"),
      ).toBe(true);

      const routedBefore = A.node.getResults().length;
      A.node.sendQuery("late-route-c", 2);
      await waitFor(
        () =>
          newResults(A, routedBefore).some(
            (hit) => hit.fileName === "late-route-c.txt",
          ),
        "A to receive 0.6 C query hit through B",
      );

      const routedHit = newResults(A, routedBefore).find(
        (hit) => hit.fileName === "late-route-c.txt",
      );
      expect(routedHit).toEqual(
        expect.objectContaining({
          fileName: "late-route-c.txt",
          remoteHost: "127.0.0.1",
          remotePort: C.advertisedPort,
          queryHops: 1,
          viaPeerKey: peerToB.key,
        }),
      );

      const filteredBefore = A.node.getResults().length;
      A.node.sendQuery("mesh-common", 2);
      await waitFor(() => {
        const hits = newResults(A, filteredBefore)
          .filter((hit) => hit.fileName.includes("mesh-common"))
          .map((hit) => hit.fileName)
          .sort();
        return (
          hits.length === 2 &&
          hits[0] === "mesh-common-b.txt" &&
          hits[1] === "mesh-common-c.txt"
        );
      }, "A to receive modern query hits from both B and C");
      await sleep(200);

      const filtered = newResults(A, filteredBefore).filter((hit) =>
        hit.fileName.includes("mesh-common"),
      );
      expect(filtered).toHaveLength(2);
      expect(filtered.map((hit) => hit.fileName).sort()).toEqual([
        "mesh-common-b.txt",
        "mesh-common-c.txt",
      ]);
      expect(filtered).toContainEqual(
        expect.objectContaining({
          fileName: "mesh-common-b.txt",
          remotePort: B.advertisedPort,
          queryHops: 0,
          viaPeerKey: peerToB.key,
        }),
      );
      expect(filtered).toContainEqual(
        expect.objectContaining({
          fileName: "mesh-common-c.txt",
          remotePort: C.advertisedPort,
          queryHops: 1,
          viaPeerKey: peerToB.key,
        }),
      );
    });
  });

  test("covers range downloads, direct resume, push fallback, and persisted state", async () => {
    await withFakeMesh(async ({ nodes, badPort }) => {
      const { A, B, C } = nodes;

      const pingCount = eventsOfType(A, "PONG").length;
      A.node.sendPing(2);
      await waitFor(
        () => eventsOfType(A, "PONG").length >= pingCount + 2,
        "A to refresh discovered peers before saving 0.6 state",
        3_000,
        () =>
          JSON.stringify({
            pingCount,
            pongEvents: eventsOfType(A, "PONG"),
            knownPeers: A.node.getKnownPeers(),
          }),
      );

      const resumeShare = B.node
        .getShares()
        .find((share) => share.name === "resume-b.bin");
      expect(resumeShare).toBeDefined();

      const ranged = await readSocketResponse(
        B.listenPort,
        `GET /get/${resumeShare!.index}/${resumeShare!.name}/ HTTP/1.0\r\nConnection: close\r\nRange: bytes=7-\r\n\r\n`,
      );
      expect(ranged).toContain("HTTP/1.0 206 Partial Content\r\n");
      expect(ranged).toContain("Content-Length: 6\r\n");
      expect(ranged).toContain("Content-Range: bytes 7-12/13\r\n");
      expect(ranged.endsWith("from-b")).toBe(true);

      const directBefore = A.node.getResults().length;
      A.node.sendQuery("resume-b", 2);
      await waitFor(
        () =>
          newResults(A, directBefore).some(
            (hit) => hit.fileName === "resume-b.bin",
          ),
        "A to receive a 0.6 direct-download result from B",
      );

      const directHit = newResults(A, directBefore).find(
        (hit) => hit.fileName === "resume-b.bin",
      );
      expect(directHit).toBeDefined();

      const directDest = path.join(A.downloadsDir, "resume-b.bin");
      await fs.writeFile(directDest, "resume-", "utf8");
      await A.node.downloadResult(directHit!.resultNo, directDest);
      await expect(fs.readFile(directDest, "utf8")).resolves.toBe(
        "resume-from-b",
      );

      const directDownloads = eventsOfType(A, "DOWNLOAD_SUCCEEDED").filter(
        (event) => event.mode === "direct",
      );
      expect(directDownloads).toContainEqual(
        expect.objectContaining({
          fileName: "resume-b.bin",
          destPath: directDest,
          remoteHost: "127.0.0.1",
          remotePort: B.listenPort,
        }),
      );

      const pushBefore = A.node.getResults().length;
      A.node.sendQuery("push-only-c", 2);
      await waitFor(
        () =>
          newResults(A, pushBefore).some(
            (hit) => hit.fileName === "push-only-c.bin",
          ),
        "A to receive 0.6 push-only result from C",
      );

      const pushHit = newResults(A, pushBefore).find(
        (hit) => hit.fileName === "push-only-c.bin",
      );
      expect(pushHit).toEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          remotePort: badPort,
        }),
      );

      const pushDest = path.join(A.downloadsDir, "push-only-c.bin");
      await A.node.downloadResult(pushHit!.resultNo, pushDest);
      await expect(fs.readFile(pushDest, "utf8")).resolves.toBe(
        "push-from-c",
      );

      const directFailures = eventsOfType(A, "DOWNLOAD_DIRECT_FAILED");
      expect(directFailures).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          remoteHost: "127.0.0.1",
          remotePort: badPort,
        }),
      );

      const pushDownloads = eventsOfType(A, "DOWNLOAD_SUCCEEDED").filter(
        (event) => event.mode === "push",
      );
      expect(pushDownloads).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          destPath: pushDest,
          remoteHost: "127.0.0.1",
          remotePort: badPort,
        }),
      );
      expect(eventsOfType(C, "PUSH_REQUESTED")).toContainEqual(
        expect.objectContaining({
          fileName: "push-only-c.bin",
          ip: "127.0.0.1",
          port: A.listenPort,
        }),
      );

      await A.node.save();
      const saved = JSON.parse(await fs.readFile(A.configPath, "utf8"));
      expect(saved.state.peers).toEqual(
        expect.objectContaining({
          [`127.0.0.1:${B.listenPort}`]: expect.any(Number),
          [`127.0.0.1:${badPort}`]: expect.any(Number),
        }),
      );
      expect(saved.state.downloads).toBeUndefined();
      expect(A.node.getDownloads()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileName: "resume-b.bin",
            mode: "direct",
            host: "127.0.0.1",
            port: B.listenPort,
            destPath: directDest,
          }),
          expect.objectContaining({
            fileName: "push-only-c.bin",
            mode: "push",
            host: "127.0.0.1",
            port: badPort,
            destPath: pushDest,
          }),
        ]),
      );
    });
  });
});
