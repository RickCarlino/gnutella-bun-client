import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { sha1ToUrn } from "../../../src/protocol/content_urn";
import type { SearchHit } from "../../../src/types";
import type { TransferOptions } from "../../../src/transfers/types";
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
});
