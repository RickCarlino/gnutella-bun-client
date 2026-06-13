import { describe, expect, test } from "bun:test";

import { parseRouteTableUpdate } from "../../../src/protocol";
import {
  canRouteRemoteQrpQuery,
  initialRemoteQrpState,
  QrpTable,
} from "../../../src/query_routing";
import type { ShareFile } from "../../../src/types";

describe("protocol helper coverage", () => {
  test("matches gtk-gnutella QRP hash vectors and word routing rules", () => {
    const hashCases: Array<[string, number, number]> = [
      ["", 13, 0],
      ["eb", 13, 6791],
      ["ebc", 13, 7082],
      ["ebck", 13, 6698],
      ["ebckl", 13, 3179],
      ["ebcklm", 13, 3235],
      ["ebcklme", 13, 6438],
      ["ebcklmen", 13, 1062],
      ["ebcklmenq", 13, 3527],
      ["", 16, 0],
      ["n", 16, 65003],
      ["nd", 16, 54193],
      ["ndf", 16, 4953],
      ["ndfl", 16, 58201],
      ["ndfla", 16, 34830],
      ["ndflal", 16, 36910],
      ["ndflale", 16, 34586],
      ["ndflalem", 16, 37658],
      ["ndflaleme", 16, 45559],
      ["ol2j34lj", 10, 318],
      ["asdfas23", 10, 503],
      ["9um3o34fd", 10, 758],
      ["a234d", 10, 281],
      ["a3f", 10, 767],
      ["3nja9", 10, 581],
      ["2459345938032343", 10, 146],
      ["7777a88a8a8a8", 10, 342],
      ["asdfjklkj3k", 10, 861],
      ["adfk32l", 10, 1011],
      ["zzzzzzzzzzz", 10, 944],
      [String.fromCodePoint(0x30a2, 0x30cb, 0x30e1), 10, 46],
      [String.fromCodePoint(0x30e9), 10, 0],
      [String.fromCodePoint(0x58f0, 0x512a), 10, 731],
      [String.fromCodePoint(0x10400), 10, 316],
      [String.fromCodePoint(0x10428), 10, 658],
      [String.fromCodePoint(0x0001, 0x0028), 10, 658],
      [String.fromCodePoint(0xff01, 0x9428), 10, 658],
      [String.fromCodePoint(0x1001, 0x2000), 10, 316],
    ];

    for (const [word, bits, expected] of hashCases) {
      expect(new QrpTable(1 << bits).hashKeyword(word)).toBe(expected);
    }
    expect(new QrpTable(1 << 10).hashKeyword("3NJA9")).toBe(581);
    expect(new QrpTable(1 << 16).hashKeyword("FAIL")).not.toBe(37458);

    const share: ShareFile = {
      index: 1,
      name: "abcdefgh alpha beta.txt",
      rel: "abcdefgh alpha beta.txt",
      abs: "/tmp/abcdefgh alpha beta.txt",
      size: 5,
      mtimeMs: 1,
      sha1: Buffer.alloc(20, 1),
      sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      keywords: ["abcdefgh", "alpha", "beta"],
    };
    const table = new QrpTable();
    table.rebuildFromShares([share]);

    expect(table.entryBits).toBe(1);
    expect(table.matchesQuery("abcdefgh")).toBe(true);
    expect(table.matchesQuery("abcdefg")).toBe(true);
    expect(table.matchesQuery("abcdef")).toBe(true);
    expect(table.matchesQuery("abcde")).toBe(true);
    expect(table.matchesQuery("abcd")).toBe(true);
    expect(table.matchesQuery("abc")).toBe(false);
    expect(table.matchesQuery("alpha beta gamma")).toBe(true);
    expect(table.matchesQuery("alpha gamma delta")).toBe(false);
    expect(table.matchesQuery("alpha beta")).toBe(true);
    expect(table.matchesQuery("alpha gamma")).toBe(false);
  });

  test("uses gtk-gnutella QRP routing rules for URNs and short words", () => {
    const share: ShareFile = {
      index: 1,
      name: "alpha beta.txt",
      rel: "alpha beta.txt",
      abs: "/tmp/alpha beta.txt",
      size: 5,
      mtimeMs: 1,
      sha1: Buffer.alloc(20, 1),
      sha1Urn: "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      keywords: ["alpha", "beta"],
    };
    const table = new QrpTable();
    table.rebuildFromShares([share]);
    const remote = initialRemoteQrpState();
    remote.resetSeen = true;
    remote.tableSize = table.tableSize;
    remote.infinity = table.infinity;
    remote.entryBits = table.entryBits;
    remote.table = table.table.slice();

    expect(
      canRouteRemoteQrpQuery(remote, {
        search: "",
        urns: [share.sha1Urn!],
      }),
    ).toBe(false);
    expect(
      canRouteRemoteQrpQuery(remote, {
        search: "alpha beta",
        urns: ["urn:sha1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"],
      }),
    ).toBe(true);
    expect(
      canRouteRemoteQrpQuery(remote, {
        search: "ab cd",
        urns: [],
      }),
    ).toBe(false);

    table.table[table.hashKeyword(share.sha1Urn!)] = 1;
    remote.table = table.table.slice();
    expect(
      canRouteRemoteQrpQuery(remote, {
        search: "",
        urns: [share.sha1Urn!],
      }),
    ).toBe(true);
  });

  test("scales QRP tables when merging different table sizes", () => {
    const small = new QrpTable(8, 7, 1);
    small.table[small.hashKeyword("alpha")] = 1;

    const expanded = new QrpTable(16, 7, 1);
    expanded.mergeFromQrp(small);
    expect(expanded.matchesQuery("alpha")).toBe(true);

    const large = new QrpTable(16, 7, 1);
    large.table[large.hashKeyword("alpha")] = 1;

    const shrunk = new QrpTable(8, 7, 1);
    shrunk.mergeFromQrp(large);
    expect(shrunk.matchesQuery("alpha")).toBe(true);
  });

  test("applies QRP spec appendix patch examples", () => {
    const table = new QrpTable(8, 7, 8);
    expect(table.hashKeyword("test")).toBe(2);
    expect(table.hashKeyword("qrp")).toBe(7);

    const makeRemote = () => {
      const remote = initialRemoteQrpState();
      const reset = parseRouteTableUpdate(Buffer.from([0, 8, 0, 0, 0, 7]));
      expect(reset.variant).toBe("reset");
      if (reset.variant !== "reset")
        throw new Error("expected reset message");
      remote.resetSeen = true;
      remote.tableSize = reset.tableLength;
      remote.infinity = reset.infinity;
      return remote;
    };

    const applyPayloads = (
      remote: ReturnType<typeof initialRemoteQrpState>,
      payloads: Buffer[],
    ): Uint8Array => {
      for (const payload of payloads) {
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
      return remote.table ?? new Uint8Array();
    };

    const expectAppendixSequence = (
      payloadSets: Buffer[][],
      expectedTables: number[][],
    ): void => {
      const remote = makeRemote();
      for (let i = 0; i < payloadSets.length; i++) {
        expect(Array.from(applyPayloads(remote, payloadSets[i]))).toEqual(
          expectedTables[i],
        );
      }
    };

    const testOnly = [7, 7, 1, 7, 7, 7, 7, 7];
    const testAndQrp = [7, 7, 1, 7, 7, 7, 7, 1];
    const qrpOnly = [7, 7, 7, 7, 7, 7, 7, 1];

    expectAppendixSequence(
      [
        [Buffer.from([1, 1, 1, 0, 8, 0, 0, 0xfa, 0, 0, 0, 0, 0])],
        [Buffer.from([1, 1, 1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0xfa])],
        [Buffer.from([1, 1, 1, 0, 8, 0, 0, 6, 0, 0, 0, 0, 0])],
      ],
      [testOnly, testAndQrp, qrpOnly],
    );

    // The appendix's later "qrp" raw bytes conflict with its stated hash=7.
    expectAppendixSequence(
      [[Buffer.from([1, 1, 1, 0, 4, 0, 0xa0, 0, 0])]],
      [testOnly],
    );

    expectAppendixSequence(
      [
        [
          Buffer.from([1, 1, 2, 0, 4, 0, 0xa0]),
          Buffer.from([1, 2, 2, 0, 4, 0, 0]),
        ],
      ],
      [testOnly],
    );

    expectAppendixSequence(
      [
        [
          Buffer.from([
            1, 1, 1, 1, 4, 0x78, 0x9c, 0x63, 0x58, 0xc0, 0xc0, 0, 0, 0x01,
            0xe4, 0, 0xa1,
          ]),
        ],
      ],
      [testOnly],
    );

    expectAppendixSequence(
      [
        [
          Buffer.from([
            1, 1, 2, 1, 4, 0x78, 0x9c, 0x63, 0x58, 0xc0, 0xc0, 0, 0, 0x01,
            0xe4,
          ]),
          Buffer.from([1, 2, 2, 1, 4, 0, 0xa1]),
        ],
      ],
      [testOnly],
    );
  });

  test("encodes and applies QRP resets and 1-bit flip patches", () => {
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

  test("handles 4-bit QRP delta patches and invalid route-table updates", () => {
    const packed = new QrpTable(4, 7, 4);
    packed.table = Uint8Array.from([1, 7, 1, 7]);
    expect(packed.packTable()).toEqual(Buffer.from([0xa0, 0xa0]));

    const nibbleState = initialRemoteQrpState();
    nibbleState.resetSeen = true;
    nibbleState.tableSize = 4;
    nibbleState.infinity = 7;
    nibbleState.entryBits = 4;
    nibbleState.seqSize = 1;
    nibbleState.compressor = 0;
    nibbleState.parts.set(1, Buffer.from([0xa0, 0xa0]));

    QrpTable.applyPatch(nibbleState);
    expect(Array.from(nibbleState.table ?? [])).toEqual([1, 7, 1, 7]);

    nibbleState.seqSize = 1;
    nibbleState.parts.set(1, Buffer.from([0x70, 0x00]));
    QrpTable.applyPatch(nibbleState);
    expect(Array.from(nibbleState.table ?? [])).toEqual([7, 7, 1, 7]);

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
