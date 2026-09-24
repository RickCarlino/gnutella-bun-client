import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { ShareLibrary } from "../../../src/shares/library";
import { loadShareIndex } from "../../../src/shares/store";
import { sha1ToUrn } from "../../../src/wire/content_urn";
import { withTempDir } from "../../helpers/protocol";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dependencies(dir: string, events: string[] = []) {
  return {
    paths: () => ({
      dataDir: dir,
      downloadsDir: path.join(dir, "shares"),
    }),
    onCatalog: () => {
      events.push("catalog");
    },
    onRefresh: () => {
      events.push("refresh");
    },
    onError: (operation: string, error: unknown) => {
      throw new Error(`${operation}: ${error}`);
    },
  };
}

async function writeShare(
  dir: string,
  name = "alpha.txt",
  content = "hello",
) {
  const shareDir = path.join(dir, "shares");
  await fs.mkdir(shareDir, { recursive: true });
  await fs.writeFile(path.join(shareDir, name), content);
}

describe("share library owner", () => {
  test("publishes before hashing and reuses persisted hashes and indexes", async () => {
    await withTempDir(async (dir) => {
      await writeShare(dir);
      const hash = deferred<Buffer>();
      const events: string[] = [];
      const library = new ShareLibrary(dependencies(dir, events), {
        hash: () => hash.promise,
      });
      await library.refreshShares();
      expect(events).toEqual(["catalog", "refresh"]);
      expect(library.shares[0]?.sha1Urn).toBeUndefined();
      const index = library.shares[0]!.index;
      hash.resolve(Buffer.alloc(20, 1));
      await library.shareHashTask;
      const urn = sha1ToUrn(Buffer.alloc(20, 1));
      expect(library.sharesByUrn.get(urn.toLowerCase())?.index).toBe(
        index,
      );
      expect((await loadShareIndex(dir)).get("alpha.txt")?.sha1Urn).toBe(
        urn,
      );
      let hashes = 0;
      const restarted = new ShareLibrary(dependencies(dir), {
        hash: async () => {
          hashes++;
          return Buffer.alloc(20, 2);
        },
      });
      await restarted.refreshShares();
      await restarted.persistShareIndex();
      expect(restarted.shares[0]?.index).toBe(index);
      expect(restarted.shares[0]?.sha1Urn).toBe(urn);
      expect(hashes).toBe(0);
    });
  });

  test("a rescan rejects a stale hash while the current pass can publish", async () => {
    await withTempDir(async (dir) => {
      await writeShare(dir);
      const oldHash = deferred<Buffer>();
      const started = deferred<void>();
      let calls = 0;
      const library = new ShareLibrary(dependencies(dir), {
        hash: async () => {
          if (++calls === 1) {
            started.resolve();
            return oldHash.promise;
          }
          return Buffer.alloc(20, 2);
        },
      });
      await library.refreshShares();
      const oldTask = library.shareHashTask;
      await started.promise;
      await writeShare(dir, "alpha.txt", "new contents");
      await library.refreshShares();
      await library.shareHashTask;
      oldHash.resolve(Buffer.alloc(20, 1));
      await oldTask;
      expect(library.shares[0]?.sha1Urn).toBe(
        sha1ToUrn(Buffer.alloc(20, 2)),
      );
      expect(library.sharesByUrn.size).toBe(1);
    });
  });

  test("disposal rejects an in-flight hash", async () => {
    await withTempDir(async (dir) => {
      await writeShare(dir);
      const hash = deferred<Buffer>();
      const started = deferred<void>();
      const library = new ShareLibrary(dependencies(dir), {
        hash: () => {
          started.resolve();
          return hash.promise;
        },
      });
      await library.refreshShares();
      await started.promise;
      library.dispose();
      hash.resolve(Buffer.alloc(20, 1));
      await library.shareHashTask;
      await library.persistShareIndex();
      expect(library.sharesByUrn.size).toBe(0);
      expect(
        (await loadShareIndex(dir)).get("alpha.txt")?.sha1Urn,
      ).toBeUndefined();
    });
  });

  test("a disappearing file does not abort hashing other files", async () => {
    await withTempDir(async (dir) => {
      await writeShare(dir);
      await writeShare(dir, "beta.txt");
      const library = new ShareLibrary(dependencies(dir), {
        hash: async (file) => {
          if (file.endsWith("alpha.txt")) throw new Error("ENOENT");
          return Buffer.alloc(20, 3);
        },
      });
      await library.refreshShares();
      await library.shareHashTask;
      expect(
        library.shares.find((share) => share.name === "alpha.txt")
          ?.sha1Urn,
      ).toBeUndefined();
      expect(
        library.shares.find((share) => share.name === "beta.txt")?.sha1Urn,
      ).toBe(sha1ToUrn(Buffer.alloc(20, 3)));
    });
  });
});

for (const stop of [false, true]) {
  test(`a suspended catalog scan cannot publish after ${stop ? "disposal" : "a newer scan"}`, async () => {
    const entered = deferred<void>();
    const resume = deferred<void>();
    const events: string[] = [];
    let scans = 0;
    const library = new ShareLibrary(dependencies("/tmp", events), {
      ensureDir: async () => {},
      load: async () => new Map(),
      write: async () => {},
      walk: async function* () {
        if (++scans === 1) {
          entered.resolve();
          await resume.promise;
        }
      },
    });
    const oldScan = library.refreshShares();
    await entered.promise;
    if (stop) library.dispose();
    else await library.refreshShares();
    const published = [...events];
    resume.resolve();
    await oldScan;
    expect(events).toEqual(published);
    expect(events).toHaveLength(stop ? 0 : 2);
  });
}
