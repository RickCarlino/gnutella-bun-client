import { describe, expect, test } from "bun:test";

import {
  buildShareCatalog,
  cachedShareHash,
  parseShareCatalogManifest,
  serializeShareCatalogManifest,
  shareKeywords,
  withShareHash,
  type ShareCatalogEntry,
  type ShareCatalogFile,
  type ShareCatalogHash,
} from "../../../src/share_catalog";

const SHA1_HEX = "0123456789abcdef0123456789abcdef01234567";
const SHA1_URN = "urn:sha1:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function file(
  rel: string,
  size: number,
  mtimeMs: number,
): ShareCatalogFile {
  return {
    abs: `/shares/${rel}`,
    rel,
    size,
    mtimeMs,
  };
}

function entry(
  rel: string,
  size: number,
  mtimeMs: number,
): ShareCatalogEntry {
  return { rel, size, mtimeMs };
}

function hash(hex = SHA1_HEX, urn = SHA1_URN): ShareCatalogHash {
  return {
    sha1: Buffer.from(hex, "hex"),
    sha1Hex: hex,
    sha1Urn: urn,
  };
}

describe("share catalog", () => {
  test("builds deterministic shares and reuses matching cached hashes", () => {
    const files = [
      file("caf\u00e9-au-lait.txt", 5, 100),
      file("nested/second-file.bin", 10, 200),
    ];
    const previous = new Map<string, ShareCatalogEntry>([
      [
        "caf\u00e9-au-lait.txt",
        {
          rel: "caf\u00e9-au-lait.txt",
          size: 5,
          mtimeMs: 100,
          sha1Hex: SHA1_HEX,
          sha1Urn: SHA1_URN,
        },
      ],
    ]);

    const first = buildShareCatalog(files, previous);
    const second = buildShareCatalog(files, previous);

    expect(first).toEqual(second);
    expect(first.shares.map((share) => share.rel)).toEqual([
      "caf\u00e9-au-lait.txt",
      "nested/second-file.bin",
    ]);
    expect(first.shares[0]).toMatchObject({
      index: 1,
      name: "caf\u00e9-au-lait.txt",
      sha1Urn: SHA1_URN,
      keywords: ["cafe", "au", "lait", "txt"],
    });
    expect(first.shares[0]?.sha1?.toString("hex")).toBe(SHA1_HEX);
    expect(first.shares[1]).toMatchObject({
      index: 2,
      name: "second-file.bin",
      keywords: ["second", "file", "bin", "nested"],
    });
    expect(first.pendingHashes.map((share) => share.rel)).toEqual([
      "nested/second-file.bin",
    ]);
    expect([...first.entries.keys()]).toEqual([
      "caf\u00e9-au-lait.txt",
      "nested/second-file.bin",
    ]);
    expect(first.entries.get("caf\u00e9-au-lait.txt")).toMatchObject({
      sha1Hex: SHA1_HEX,
      sha1Urn: SHA1_URN,
    });
  });

  test("requires size and mtime matches before reusing cached SHA-1", () => {
    const cached = {
      rel: "alpha.txt",
      size: 10,
      mtimeMs: 20,
      sha1Hex: SHA1_HEX,
      sha1Urn: SHA1_URN,
    };

    expect(cachedShareHash(cached, 10, 20)?.sha1Hex).toBe(SHA1_HEX);
    expect(cachedShareHash(cached, 11, 20)).toBeUndefined();
    expect(cachedShareHash(cached, 10, 21)).toBeUndefined();
    expect(cachedShareHash(entry("alpha.txt", 10, 20), 10, 20)).toBe(
      undefined,
    );
  });

  test("drops removed files from the rebuilt catalog", () => {
    const result = buildShareCatalog(
      [file("kept.txt", 1, 1)],
      new Map([["removed.txt", entry("removed.txt", 2, 2)]]),
    );

    expect([...result.entries.keys()]).toEqual(["kept.txt"]);
    expect(result.shares.map((share) => share.rel)).toEqual(["kept.txt"]);
  });

  test("extracts share keywords with existing QRP normalization", () => {
    expect(
      shareKeywords(
        "/shares/nested/caf\u00e9-au-lait.txt",
        "nested/caf\u00e9-au-lait.txt",
      ),
    ).toEqual(["cafe", "au", "lait", "txt", "nested"]);
  });

  test("applies hash results without mutating source records", () => {
    const catalog = buildShareCatalog(
      [file("alpha.txt", 1, 2)],
      new Map(),
    );
    const originalShare = catalog.shares[0]!;
    const originalEntry = catalog.entries.get("alpha.txt")!;
    const updated = withShareHash(originalShare, originalEntry, hash());

    expect(originalShare.sha1Urn).toBeUndefined();
    expect(originalEntry.sha1Urn).toBeUndefined();
    expect(updated.share.sha1Urn).toBe(SHA1_URN);
    expect(updated.share.sha1?.toString("hex")).toBe(SHA1_HEX);
    expect(updated.entry).toMatchObject({
      sha1Hex: SHA1_HEX,
      sha1Urn: SHA1_URN,
    });
  });

  test("manifest serialization round-trips and normalizes cached hashes", () => {
    const manifest = serializeShareCatalogManifest(
      new Map([
        [
          "beta.txt",
          {
            rel: "beta.txt",
            size: 2,
            mtimeMs: 2,
            sha1Hex: SHA1_HEX.toUpperCase(),
            sha1Urn: SHA1_URN,
          },
        ],
        ["alpha.txt", entry("alpha.txt", 1, 1)],
      ]),
    );

    expect(manifest.files.map((item) => item.rel)).toEqual([
      "alpha.txt",
      "beta.txt",
    ]);
    expect([...parseShareCatalogManifest(manifest).entries()]).toEqual([
      ["alpha.txt", entry("alpha.txt", 1, 1)],
      [
        "beta.txt",
        {
          rel: "beta.txt",
          size: 2,
          mtimeMs: 2,
          sha1Hex: SHA1_HEX,
          sha1Urn: SHA1_URN,
        },
      ],
    ]);
    expect(parseShareCatalogManifest({ version: 2, files: [] }).size).toBe(
      0,
    );
  });
});
