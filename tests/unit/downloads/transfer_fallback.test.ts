import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DownloadTimeoutError } from "../../../src/transfers/errors";
import type { SearchHit } from "../../../src/types";
import { sha1ToUrn } from "../../../src/wire/content_urn";
import { makeNode, withTempDir } from "../../helpers/protocol";

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

describe("download transfer fallback", () => {
  test("a connection timeout skips /get but can still use push", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "config.json"));
      const source = hit({ sha1Urn: sha1UrnFor(Buffer.from("hello")) });
      const requests: string[] = [];
      let pushed = false;
      node.transfers.directDownloadViaRequest = async (
        _host,
        _port,
        request,
      ) => {
        requests.push(request);
        throw new DownloadTimeoutError(
          "connect",
          "download connect timeout",
        );
      };
      node.transfers.sendPush = async (_hit, destPath) => {
        pushed = true;
        await fs.writeFile(destPath, "hello");
        return { destPath, bytes: 5, label: "test source" };
      };
      await node.downloadManager.queue(source);
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

  test("retains both direct request errors when push fallback also fails", async () => {
    await withTempDir(async (dir) => {
      const configPath = path.join(dir, "protocol.json");
      const node = makeNode(configPath, {
        runtimeConfig: { downloadRetryLimit: 1 },
      });
      const source = hit({
        sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      node.transfers.directDownloadViaRequest = async (
        _host,
        _port,
        request,
      ) => {
        throw new Error(
          request.includes("/uri-res/") ? "HTTP 503" : "download timeout",
        );
      };
      node.transfers.sendPush = async () => {
        throw new Error("push timed out");
      };
      const job = await node.downloadManager.queue(source);
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
});
