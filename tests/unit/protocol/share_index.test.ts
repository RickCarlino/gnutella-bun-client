import { describe, expect, test } from "bun:test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  loadShareIndex,
  writeShareIndex,
  type ShareIndexEntry,
} from "../../../src/protocol/share_index";

async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "share-index-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function entry(rel: string, size = 1): ShareIndexEntry {
  return {
    rel,
    size,
    mtimeMs: size,
  };
}

async function waitFor<T>(
  read: () => T | undefined,
  attempts = 200,
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for condition");
}

describe("share index", () => {
  test("serializes concurrent writes and leaves the newest manifest on disk", async () => {
    await withTempDir(async (dir) => {
      const originalRename = fsp.rename;
      const renameCalls: string[] = [];
      let releaseFirstRename: (() => void) | undefined;
      let blockedFirstRename = false;

      (
        fsp as unknown as {
          rename: typeof fsp.rename;
        }
      ).rename = async (from, to) => {
        renameCalls.push(path.basename(String(from)));
        if (!blockedFirstRename) {
          blockedFirstRename = true;
          await new Promise<void>((resolve) => {
            releaseFirstRename = resolve;
          });
        }
        return await originalRename(from, to);
      };

      try {
        const firstWrite = writeShareIndex(
          dir,
          new Map([["alpha.txt", entry("alpha.txt")]]),
        );
        await waitFor(() => releaseFirstRename);

        const secondWrite = writeShareIndex(
          dir,
          new Map([["beta.txt", entry("beta.txt", 2)]]),
        );

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(renameCalls).toHaveLength(1);

        releaseFirstRename?.();
        await Promise.all([firstWrite, secondWrite]);

        const loaded = await loadShareIndex(dir);
        expect([...loaded.keys()]).toEqual(["beta.txt"]);
        expect(renameCalls).toHaveLength(2);
      } finally {
        (
          fsp as unknown as {
            rename: typeof fsp.rename;
          }
        ).rename = originalRename;
      }
    });
  });
});
