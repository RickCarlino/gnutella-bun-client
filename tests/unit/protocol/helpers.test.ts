import { describe, expect, test } from "bun:test";

import {
  initialRemoteQrpState,
  parseRouteTableUpdate,
  QrpTable,
} from "../../../src/protocol";
import type { ShareFile } from "../../../src/types";

describe("protocol helper coverage", () => {
  test("encodes and applies QRP resets and patches", () => {
    const share: ShareFile = {
      index: 1,
      name: "alpha-track.txt",
      rel: "alpha-track.txt",
      abs: "/tmp/alpha-track.txt",
      size: 5,
      mtimeMs: 1,
      sha1: Buffer.alloc(20, 1),
      sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      keywords: ["alpha", "track"],
    };

    const table = new QrpTable(64, 7, 1);
    table.rebuildFromShares([share]);
    const usedHashes = new Set(
      share.keywords.map((keyword) => table.hashKeyword(keyword)),
    );
    let missingSearch = "";
    for (let i = 0; i < 256; i++) {
      const candidate = `missingx${i}`;
      if (!usedHashes.has(table.hashKeyword(candidate))) {
        missingSearch = candidate;
        break;
      }
    }

    expect(table.hashKeyword("alpha")).toBeGreaterThanOrEqual(0);
    expect(table.matchesQuery("alpha")).toBe(true);
    expect(table.matchesQuery("alpha track")).toBe(true);
    expect(missingSearch).not.toBe("");
    expect(table.matchesQuery(missingSearch)).toBe(false);
    expect(table.matchesQuery("   ")).toBe(true);

    const reset = parseRouteTableUpdate(table.encodeReset());
    expect(reset.variant).toBe("reset");
    if (reset.variant !== "reset")
      throw new Error("expected reset message");
    expect(reset.tableLength).toBe(64);
    expect(reset.infinity).toBe(7);

    const patches = table.encodePatchChunks(32);
    expect(patches.length).toBeGreaterThan(0);

    const remote = initialRemoteQrpState();
    remote.resetSeen = true;
    remote.tableSize = reset.tableLength;
    remote.infinity = reset.infinity;

    for (const payload of patches) {
      const patch = parseRouteTableUpdate(payload);
      expect(patch.variant).toBe("patch");
      if (patch.variant !== "patch")
        throw new Error("expected patch message");
      remote.seqSize = patch.seqSize;
      remote.compressor = patch.compressor;
      remote.entryBits = patch.entryBits;
      remote.parts.set(patch.seqNo, patch.data);
    }

    QrpTable.applyPatch(remote);

    expect(remote.table).not.toBeNull();
    expect(remote.parts.size).toBe(0);
    expect(remote.seqSize).toBe(0);
    expect(QrpTable.matchesRemote(remote, "alpha")).toBe(true);
    expect(QrpTable.matchesRemote(remote, "   ")).toBe(true);
    expect(QrpTable.matchesRemote(remote, missingSearch)).toBe(false);
  });

  test("handles 4-bit QRP tables and invalid route-table updates", () => {
    const packed = new QrpTable(4, 15, 4);
    packed.table = Uint8Array.from([1, 15, 2, 3]);
    expect(packed.packTable()).toEqual(Buffer.from([0x1f, 0x23]));

    const nibbleState = initialRemoteQrpState();
    nibbleState.resetSeen = true;
    nibbleState.tableSize = 4;
    nibbleState.infinity = 15;
    nibbleState.entryBits = 4;
    nibbleState.seqSize = 1;
    nibbleState.compressor = 0;
    nibbleState.parts.set(1, Buffer.from([0x1f, 0x23]));

    QrpTable.applyPatch(nibbleState);
    expect(Array.from(nibbleState.table ?? [])).toEqual([1, 15, 2, 3]);

    const incomplete = initialRemoteQrpState();
    incomplete.resetSeen = true;
    incomplete.tableSize = 8;
    incomplete.entryBits = 1;
    incomplete.seqSize = 2;
    incomplete.parts.set(1, Buffer.from([0xff]));
    QrpTable.applyPatch(incomplete);
    expect(incomplete.table).toBeNull();

    const unsupportedState = initialRemoteQrpState();
    unsupportedState.resetSeen = true;
    unsupportedState.tableSize = 4;
    unsupportedState.entryBits = 2;
    unsupportedState.seqSize = 1;
    unsupportedState.compressor = 0;
    unsupportedState.parts.set(1, Buffer.from([0xff]));
    QrpTable.applyPatch(unsupportedState);
    expect(unsupportedState.table).toBeNull();

    const unsupportedTable = new QrpTable(4, 7, 2);
    expect(() => unsupportedTable.packTable()).toThrow(
      "unsupported QRP entry bits 2",
    );

    expect(
      QrpTable.matchesRemote(initialRemoteQrpState(), "anything"),
    ).toBe(true);
    expect(() => parseRouteTableUpdate(Buffer.alloc(0))).toThrow(
      "invalid route table update length",
    );
    expect(() => parseRouteTableUpdate(Buffer.from([0x00, 0x01]))).toThrow(
      "invalid qrp reset length",
    );
    expect(() =>
      parseRouteTableUpdate(Buffer.from([0x01, 0x01, 0x01, 0x00, 0x01])),
    ).toThrow("invalid qrp patch length");
    expect(() => parseRouteTableUpdate(Buffer.from([0x02]))).toThrow(
      "unsupported qrp variant 2",
    );
  });
});
