import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { GnutellaServent, SearchHit } from "../../src/protocol";
import { sha1ToUrn } from "../../src/protocol/content_urn";
import { withFakeNet } from "../helpers/fake_net";
import { makeNode, withTempDir } from "../unit/protocol/node/helpers";

type Mode =
  | "keep-alive"
  | "close"
  | "truncated"
  | "unknown-total"
  | "stall-headers"
  | "stall-body"
  | "stall-resume"
  | "slow-body";
type Fixture = {
  node: GnutellaServent;
  hit: SearchHit;
  requests: string[];
  connections: () => number;
  destPath: string;
};
const CONTENT = Buffer.from("0123456789");

function partialResponse(
  mode: Mode,
  start: number,
  truncated: boolean,
): Buffer {
  const end = Math.min(start + 3, CONTENT.length - 1);
  const responseEnd =
    truncated || mode === "stall-body" || mode === "stall-resume"
      ? CONTENT.length - 1
      : end;
  const total = mode === "unknown-total" ? "*" : CONTENT.length;
  return Buffer.concat([
    Buffer.from(
      `HTTP/1.1 206 Partial Content\r\nContent-Length: ${responseEnd - start + 1}\r\nContent-Range: bytes ${start}-${responseEnd}/${total}\r\nConnection: ${mode === "close" ? "close" : "keep-alive"}\r\n\r\n`,
    ),
    CONTENT.subarray(start, end + 1),
  ]);
}

async function withPartialServer(
  mode: Mode,
  run: (fixture: Fixture) => Promise<void>,
) {
  await withFakeNet(async () => {
    await withTempDir(async (dir) => {
      const requests: string[] = [];
      const sockets: net.Socket[] = [];
      const server = net.createServer((socket) => {
        sockets.push(socket);
        let buffered = "";
        socket.on("data", (chunk) => {
          buffered += chunk.toString();
          if (!buffered.endsWith("\r\n\r\n")) return;
          requests.push(buffered);
          if (mode === "stall-headers") return;
          const start = Number(/Range: bytes=(\d+)-/.exec(buffered)?.[1]);
          buffered = "";
          const truncated = mode === "truncated" && requests.length === 1;
          const response = partialResponse(mode, start, truncated);
          if (mode === "slow-body") {
            socket.write(response.subarray(0, -2));
            setTimeout(() => {
              if (!socket.destroyed) socket.write(response.subarray(-2));
            }, 60);
            return;
          }
          if (mode === "close" || truncated) socket.end(response);
          else socket.write(response);
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as net.AddressInfo).port;
      const node = makeNode(path.join(dir, "config.json"), {
        runtimeConfig: {
          downloadsDir: path.join(dir, "complete"),
          incompleteDownloadsDir: path.join(dir, "partial"),
        },
      });
      const sha1Urn = sha1ToUrn(
        crypto.createHash("sha1").update(CONTENT).digest(),
      );
      const hit: SearchHit = {
        resultNo: 1,
        queryIdHex: "aa".repeat(16),
        queryHops: 1,
        remoteHost: "127.0.0.1",
        remotePort: port,
        speedKBps: 256,
        fileIndex: 1,
        fileName: "partial.txt",
        fileSize: CONTENT.length,
        serventIdHex: "11".repeat(16),
        viaPeerKey: "local",
        sha1Urn,
      };
      try {
        await run({
          node,
          hit,
          requests,
          connections: () => sockets.length,
          destPath: path.join(dir, "manual.part"),
        });
      } finally {
        await node.downloadManager.stop();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
      }
    });
  });
}

function starts(requests: string[]): number[] {
  return requests.map((request) =>
    Number(/Range: bytes=(\d+)-/.exec(request)?.[1]),
  );
}

describe("partial download interoperability", () => {
  test("finishes across more stalled attempts than the retry limit when bytes advance", async () => {
    await withPartialServer(
      "stall-resume",
      async ({ node, hit, requests }) => {
        node.updateRuntimeConfig({
          downloadIdleTimeoutMs: 30,
          downloadRetryLimit: 1,
          downloadRetryBackoffSec: 0.01,
        });
        node.lastResults = [hit];
        await node.downloadResult(1);
        await node.downloadManager.start();
        for (
          let i = 0;
          i < 200 && node.getDownloadJobs()[0]?.status !== "complete";
          i++
        ) {
          await Bun.sleep(10);
        }
        const completed = node.getDownloadJobs()[0]!;
        expect(completed.status).toBe("complete");
        expect(completed.sources[0]?.attempts).toBe(3);
        expect(completed.sources[0]?.failuresWithoutProgress).toBe(0);
        expect(await fs.readFile(completed.destPath)).toEqual(CONTENT);
        expect(starts(requests)).toEqual([0, 4, 8]);
      },
    );
  });

  test.each<Mode>(["stall-headers", "stall-body"])(
    "reports %s and waits for cooldown without /get or push fallback",
    async (mode) => {
      await withPartialServer(
        mode,
        async ({ node, hit, requests, connections }) => {
          node.updateRuntimeConfig({
            downloadTimeoutMs: 30,
            downloadIdleTimeoutMs: 30,
            downloadRetryBackoffSec: 60,
          });
          node.lastResults = [hit];
          let pushed = false;
          node.sendPush = async () => {
            pushed = true;
          };
          const job = await node.downloadResult(1);
          await node.downloadManager.start();
          for (
            let i = 0;
            i < 100 && node.getDownloadJobs()[0]?.status === "active";
            i++
          ) {
            await Bun.sleep(10);
          }
          const waiting = node.getDownloadJobs()[0]!;
          const source = waiting.sources[0]!;
          expect(waiting.status).toBe("queued");
          expect(source.attempts).toBe(1);
          expect(source.failuresWithoutProgress).toBe(
            mode === "stall-body" ? 0 : 1,
          );
          expect(source.cooldownUntil).toBeGreaterThan(node.now());
          expect(source.lastError).toContain(
            mode === "stall-headers"
              ? "waiting for HTTP headers"
              : "body stalled",
          );
          expect(source.lastError).toContain(
            mode === "stall-headers"
              ? "range start=0, header bytes=0"
              : "offset=4, response bytes=4, remaining=6",
          );
          expect(starts(requests)).toEqual([0]);
          expect(connections()).toBe(1);
          expect(pushed).toBe(false);
          if (mode === "stall-body") {
            expect(await fs.readFile(job.incompletePath)).toEqual(
              CONTENT.subarray(0, 4),
            );
            expect(waiting.bytesCompleted).toBe(4);
          }
        },
      );
    },
  );

  test.each<Mode>([
    "keep-alive",
    "close",
    "truncated",
    "unknown-total",
    "slow-body",
  ])(
    "finishes and verifies a managed download across %s responses",
    async (mode) => {
      await withPartialServer(
        mode,
        async ({ node, hit, requests, connections }) => {
          if (mode === "slow-body") {
            node.updateRuntimeConfig({
              downloadTimeoutMs: 30,
              downloadIdleTimeoutMs: 200,
            });
          }
          node.lastResults = [hit];
          const queued = await node.downloadResult(1);
          await node.downloadManager.start();
          expect(node.getDownloadJobs()[0]?.status).toBe("active");
          node.clearResults();
          expect(node.getResults()).toEqual([]);
          for (
            let i = 0;
            i < 200 && node.getDownloadJobs()[0]?.status !== "complete";
            i++
          ) {
            await Bun.sleep(10);
          }
          const job = node.getDownloadJobs()[0]!;
          expect(job.status).toBe("complete");
          expect(job.bytesCompleted).toBe(CONTENT.length);
          expect(await fs.readFile(job.destPath)).toEqual(CONTENT);
          expect(
            await fs.stat(queued.incompletePath).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          expect(starts(requests)).toEqual([0, 4, 8]);
          expect(connections()).toBe(
            mode === "close" ? 3 : mode === "truncated" ? 2 : 1,
          );
          if (mode === "truncated") {
            expect(requests[0]).toContain("/uri-res/");
            expect(requests[1]).toContain("/get/");
          }
        },
      );
    },
  );

  test("continues partial responses on an incoming push socket", async () => {
    await withPartialServer(
      "keep-alive",
      async ({ node, hit, requests, destPath }) => {
        const socket = node.createConnection({
          host: hit.remoteHost,
          port: hit.remotePort,
        });
        await new Promise<void>((resolve) =>
          socket.once("connect", resolve),
        );
        await node.downloadOverSocket(
          socket,
          hit.fileIndex,
          hit.fileName,
          destPath,
        );
        expect(starts(requests)).toEqual([0, 4, 8]);
        expect(await fs.readFile(destPath)).toEqual(CONTENT);
      },
    );
  });

  test("preserves bytes on cancellation and resumes from disk", async () => {
    await withPartialServer(
      "keep-alive",
      async ({ node, hit, requests, destPath }) => {
        const controller = new AbortController();
        await expect(
          node.directDownload(hit, destPath, {
            signal: controller.signal,
            onProgress: () => controller.abort(),
          }),
        ).rejects.toThrow("download aborted");
        expect(await fs.readFile(destPath)).toEqual(
          CONTENT.subarray(0, 4),
        );
        await node.directDownload(hit, destPath);
        expect(starts(requests)).toEqual([0, 4, 8]);
        expect(await fs.readFile(destPath)).toEqual(CONTENT);
      },
    );
  });
});
