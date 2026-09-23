import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sha1ToUrn } from "../../../src/protocol/content_urn";
import type { SearchHit } from "../../../src/types";
import type { TransferOptions } from "../../../src/transfers/types";
import { DownloadTimeoutError } from "../../../src/transfers/errors";
import { makeNode, withTempDir } from "../protocol/node/helpers";

function hit(patch: Partial<SearchHit> = {}): SearchHit {
  return {
    resultNo: 1,
    queryIdHex: "aa".repeat(16),
    queryHops: 1,
    remoteHost: "9.8.7.6",
    remotePort: 6346,
    speedKBps: 256,
    fileIndex: 5,
    fileName: "alpha.txt",
    fileSize: 5,
    serventIdHex: "11".repeat(16),
    viaPeerKey: "p1",
    ...patch,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

function sha1UrnFor(content: Buffer): string {
  return sha1ToUrn(crypto.createHash("sha1").update(content).digest());
}

describe("download manager", () => {
  test("persists consecutive no-progress failures, resets on new bytes, and keeps total attempts", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const initial = makeNode(configPath);
      initial.lastResults = [hit()];
      const job = await initial.downloadResult(1);
      const expectedFailures = [1, 0, 1, 2];
      for (let step = 0; step < expectedFailures.length; step++) {
        const node = makeNode(configPath, {
          runtimeConfig: { downloadRetryLimit: 2 },
          collaborators: { clock: { now: () => 1_000_000 * (step + 1) } },
        });
        node.directDownload = async (_hit, destPath, options) => {
          if (step === 1) await fs.writeFile(destPath, "he");
          // Progress notifications alone must not count as saved data.
          options?.onProgress?.({ bytesCompleted: 4 });
          throw new DownloadTimeoutError("body", "download body stalled");
        };
        try {
          await node.downloadManager.start();
          await waitFor(
            () => node.getDownloadJobs()[0]?.status !== "active",
          );
          const failed = node.getDownloadJobs()[0]!;
          expect(failed.status).toBe(step === 3 ? "failed" : "queued");
          expect(failed.sources[0]?.attempts).toBe(step + 1);
          expect(failed.sources[0]?.failuresWithoutProgress).toBe(
            expectedFailures[step],
          );
        } finally {
          await node.downloadManager.stop();
        }
      }
      const restarted = makeNode(configPath);
      await restarted.downloadManager.persist();
      expect(
        restarted.getDownloadJobs()[0]?.sources[0]
          ?.failuresWithoutProgress,
      ).toBe(2);
      const resumed = await restarted.resumeDownload(job.id);
      expect(resumed.sources[0]?.failuresWithoutProgress).toBe(0);
      expect(resumed.sources[0]?.attempts).toBe(4);
      expect(await fs.readFile(job.incompletePath, "utf8")).toBe("he");
    });
  });

  test("a connection timeout skips /get but can still use push", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"));
      node.lastResults = [
        hit({ sha1Urn: sha1UrnFor(Buffer.from("hello")) }),
      ];
      const requests: string[] = [];
      let pushed = false;
      node.directDownloadViaRequest = async (_host, _port, request) => {
        requests.push(request);
        throw new DownloadTimeoutError(
          "connect",
          "download connect timeout",
        );
      };
      node.sendPush = async (_hit, destPath) => {
        pushed = true;
        await fs.writeFile(destPath, "hello");
      };
      await node.downloadResult(1);
      try {
        await node.downloadManager.start();
        await waitFor(
          () => node.getDownloadJobs()[0]?.status === "complete",
        );
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("/uri-res/");
        expect(pushed).toBe(true);
      } finally {
        await node.downloadManager.stop();
      }
    });
  });

  test("persists queued jobs across manager instances", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const first = makeNode(configPath);
      first.lastResults = [hit()];

      const queued = await first.downloadResult(1);
      await first.downloadManager.persist();

      const second = makeNode(configPath);
      await second.downloadManager.persist();

      expect(second.getDownloadJobs()).toEqual([
        expect.objectContaining({
          id: queued.id,
          status: "queued",
          fileName: "alpha.txt",
        }),
      ]);
    });
  });

  test("verifies SHA1 downloads before moving them complete", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const content = Buffer.from("hello");
      const sha1Urn = sha1UrnFor(content);
      const events: string[] = [];
      const node = makeNode(configPath);
      node.subscribe((event) => events.push(event.type));
      node.lastResults = [hit({ sha1Urn, urns: [sha1Urn] })];
      node.directDownload = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content);
        options?.onProgress?.({ bytesCompleted: content.length });
        return { ok: true };
      };

      const job = await node.downloadResult(1);
      await node.downloadManager.start();
      await waitFor(
        () => node.getDownloadJobs()[0]?.status === "complete",
      );

      const completed = node.getDownloadJobs()[0];
      expect(completed).toMatchObject({
        id: job.id,
        status: "complete",
        bytesCompleted: content.length,
      });
      expect(await fs.readFile(completed!.destPath, "utf8")).toBe("hello");
      await expect(fs.stat(completed!.incompletePath)).rejects.toThrow();
      expect(node.getDownloads()).toHaveLength(1);
      expect(events).toContain("DOWNLOAD_SUCCEEDED");
    });
  });

  test("marks mismatched SHA1 downloads as verification_failed", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const sha1Urn = sha1UrnFor(Buffer.from("expected"));
      const node = makeNode(configPath);
      node.lastResults = [hit({ sha1Urn, urns: [sha1Urn] })];
      node.directDownload = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, "wrong");
        options?.onProgress?.({ bytesCompleted: 5 });
        return { ok: true };
      };

      await node.downloadResult(1);
      await node.downloadManager.start();
      await waitFor(
        () => node.getDownloadJobs()[0]?.status === "verification_failed",
      );

      const failed = node.getDownloadJobs()[0];
      expect(failed?.error).toBe("SHA1 verification failed");
      expect(await fs.readFile(failed!.incompletePath, "utf8")).toBe(
        "wrong",
      );
      expect(node.getDownloads()).toHaveLength(0);
    });
  });

  test("fails a completed transfer when the final size is wrong", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeNode(configPath);
      node.lastResults = [hit({ fileSize: 10 })];
      node.directDownload = async (
        _hit: SearchHit,
        destPath: string,
        options?: TransferOptions,
      ) => {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, "short");
        options?.onProgress?.({ bytesCompleted: 5 });
        return { ok: true };
      };

      const job = await node.downloadResult(1);
      await node.downloadManager.start();
      await waitFor(() => node.getDownloadJobs()[0]?.status === "failed");

      const failed = node.getDownloadJobs()[0];
      expect(failed).toMatchObject({
        id: job.id,
        status: "failed",
        bytesCompleted: 0,
        error: "download size mismatch: expected 10 bytes, got 5",
      });
      expect(failed?.sources[0]?.lastError).toBe(
        "download size mismatch: expected 10 bytes, got 5",
      );
      await expect(fs.stat(job.incompletePath)).rejects.toThrow();
      expect(node.getDownloads()).toHaveLength(0);
    });
  });

  test("pauses, resumes, and removes queued jobs", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeNode(configPath);
      node.lastResults = [hit()];

      const job = await node.downloadResult(1);
      await fs.mkdir(path.dirname(job.incompletePath), {
        recursive: true,
      });
      await fs.writeFile(job.incompletePath, "part");

      expect((await node.pauseDownload(job.id)).status).toBe("paused");
      expect((await node.resumeDownload(job.id)).status).toBe("queued");
      await node.removeDownload(job.id);

      expect(node.getDownloadJobs()).toEqual([]);
      await expect(fs.stat(job.incompletePath)).rejects.toThrow();
    });
  });

  test("retains both direct request errors when push fallback also fails", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeNode(configPath, {
        runtimeConfig: { downloadRetryLimit: 1 },
      });
      node.lastResults = [
        hit({ sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      ];
      node.directDownloadViaRequest = async (_host, _port, request) => {
        throw new Error(
          request.includes("/uri-res/") ? "HTTP 503" : "download timeout",
        );
      };
      node.sendPush = async () => {
        throw new Error("push timed out");
      };
      const job = await node.downloadResult(1);
      await fs.mkdir(path.dirname(job.incompletePath), {
        recursive: true,
      });
      await fs.writeFile(job.incompletePath, "he");
      try {
        await node.downloadManager.start();
        await waitFor(
          () => node.getDownloadJobs()[0]?.status === "failed",
        );
        await node.downloadManager.persist();
        const restored = makeNode(configPath);
        await restored.downloadManager.persist();
        const failed = restored.getDownloadJobs()[0]!;
        expect(failed.error).toBe(
          "direct: uri-res: HTTP 503; /get: download timeout; push: push timed out",
        );
        expect(failed.sources[0]?.lastError).toBe(failed.error);
        expect(failed.bytesCompleted).toBe(2);
        expect(await fs.readFile(job.incompletePath, "utf8")).toBe("he");
      } finally {
        await node.downloadManager.stop();
      }
    });
  });

  test("pausing a direct transfer does not attempt push fallback", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      node.lastResults = [hit()];
      let started = false;
      let pushed = false;
      node.directDownload = async (_hit, _path, options) => {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("download aborted")),
            { once: true },
          );
          started = true;
        });
      };
      node.sendPush = async () => {
        pushed = true;
      };
      const job = await node.downloadResult(1);
      try {
        await node.downloadManager.start();
        await waitFor(() => started);
        await node.pauseDownload(job.id);
        expect(node.getDownloadJobs()[0]?.status).toBe("paused");
        expect(pushed).toBe(false);
      } finally {
        await node.downloadManager.stop();
      }
    });
  });
});
