import { describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import {
  buildAggregateQrpTable,
  canRouteRemoteQrpQuery,
  initialRemoteQrpState,
  QrpTable,
  selectQueryRouteTargets,
  type QueryRouteCandidate,
  type RemoteQrpState,
} from "../../../src/routing";

function remoteFromTable(table: QrpTable): RemoteQrpState {
  const remote = initialRemoteQrpState();
  remote.resetSeen = true;
  remote.tableSize = table.tableSize;
  remote.infinity = table.infinity;
  remote.entryBits = table.entryBits;
  remote.table = table.table.slice();
  return remote;
}

describe("standalone query routing", () => {
  test("publishes four-bit deltas without changing the table's default encoding", () => {
    const table = new QrpTable(8, 7, 1);
    table.table[2] = 1;
    table.table[5] = 1;
    const patches = table.encodePatchChunks(1024, 4);
    expect(patches[0].subarray(0, 5)).toEqual(
      Buffer.from([1, 1, 1, 1, 4]),
    );
    // Signed -6 lowers an empty slot from infinity 7 to presence 1.
    expect(zlib.inflateSync(patches[0].subarray(5))).toEqual(
      Buffer.from([0x00, 0xa0, 0x0a, 0x00]),
    );
    expect(table.entryBits).toBe(1);
    expect(table.encodePatchChunks(1024)[0][4]).toBe(1);
  });

  test("builds QRP tables from structural keyword sources", () => {
    const table = new QrpTable(1024);
    table.rebuildFromShares([{ keywords: ["alpha beta", "gamma"] }]);

    expect(table.matchesQuery("alpha beta")).toBe(true);
    expect(table.matchesQuery("alpha gamma")).toBe(true);
    expect(table.matchesQuery("alpha delta")).toBe(false);
  });

  test("routes leaf candidates only after positive QRP matches", () => {
    const matchingTable = new QrpTable(1024);
    matchingTable.rebuildFromShares([{ keywords: ["alpha beta"] }]);
    const missingTable = new QrpTable(1024);
    missingTable.rebuildFromShares([{ keywords: ["zeta"] }]);
    const candidates: QueryRouteCandidate<string>[] = [
      {
        id: "matching-leaf",
        role: "leaf",
        remoteQrp: remoteFromTable(matchingTable),
      },
      {
        id: "missing-leaf",
        role: "leaf",
        remoteQrp: remoteFromTable(missingTable),
      },
      { id: "unknown-leaf", role: "leaf" },
      { id: "mesh", role: "mesh" },
    ];

    expect(
      selectQueryRouteTargets({
        nodeMode: "ultrapeer",
        enableQrp: true,
        query: { search: "alpha beta", urns: [] },
        candidates,
        ttl: 2,
        hops: 0,
      }),
    ).toEqual([
      { id: "matching-leaf", ttl: 2, hops: 0 },
      { id: "mesh", ttl: 1, hops: 1 },
    ]);
  });

  test("uses last-hop QRP for capable mesh candidates", () => {
    const matchingTable = new QrpTable(1024);
    matchingTable.rebuildFromShares([{ keywords: ["alpha"] }]);
    const missingTable = new QrpTable(1024);
    missingTable.rebuildFromShares([{ keywords: ["zeta"] }]);
    const candidates: QueryRouteCandidate<string>[] = [
      {
        id: "matching-mesh",
        role: "mesh",
        supportsLastHopQrp: true,
        remoteQrp: remoteFromTable(matchingTable),
      },
      {
        id: "missing-mesh",
        role: "mesh",
        supportsLastHopQrp: true,
        remoteQrp: remoteFromTable(missingTable),
      },
      {
        id: "legacy-mesh",
        role: "mesh",
        supportsLastHopQrp: false,
        remoteQrp: remoteFromTable(missingTable),
      },
      { id: "unknown-mesh", role: "mesh", supportsLastHopQrp: true },
    ];

    expect(
      selectQueryRouteTargets({
        nodeMode: "ultrapeer",
        enableQrp: true,
        query: { search: "alpha", urns: [] },
        candidates,
        ttl: 1,
        hops: 3,
      }),
    ).toEqual([
      { id: "matching-mesh", ttl: 1, hops: 3 },
      { id: "legacy-mesh", ttl: 1, hops: 3 },
      { id: "unknown-mesh", ttl: 1, hops: 3 },
    ]);
  });

  test("builds aggregate QRP tables from local and remote inputs", () => {
    const ownTable = new QrpTable(8);
    ownTable.rebuildFromShares([{ keywords: ["alpha"] }]);
    const leafTable = new QrpTable(16);
    leafTable.rebuildFromShares([{ keywords: ["zeta"] }]);

    const aggregate = buildAggregateQrpTable(
      ownTable,
      [remoteFromTable(leafTable)],
      { maxTableSize: 16 },
    );

    expect(aggregate.tableSize).toBe(16);
    expect(aggregate.matchesQuery("alpha")).toBe(true);
    expect(aggregate.matchesQuery("zeta")).toBe(true);
  });

  test("routes URNs only when the remote QRP table advertises the URN", () => {
    const urn = "urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const table = new QrpTable(1024);
    const remote = remoteFromTable(table);

    expect(
      canRouteRemoteQrpQuery(remote, { search: "", urns: [urn] }),
    ).toBe(false);

    table.table[table.hashKeyword(urn)] = 1;
    remote.table = table.table.slice();
    expect(
      canRouteRemoteQrpQuery(remote, { search: "", urns: [urn] }),
    ).toBe(true);
  });
});

for (const entryBits of [1, 4, 8]) {
  test(`bounds compressed ${entryBits}-bit QRP output to the declared table`, () => {
    const state = remoteFromTable(new QrpTable(64, 7, entryBits));
    const original = state.table!.slice();
    const expectedBytes = (64 * entryBits) / 8;
    state.seqSize = 1;
    state.compressor = 1;
    state.parts.set(1, zlib.deflateSync(Buffer.alloc(expectedBytes + 1)));
    expect(() => QrpTable.applyPatch(state)).toThrow();
    expect(state.table).toEqual(original);
    state.parts.set(1, zlib.deflateSync(Buffer.alloc(expectedBytes)));
    expect(QrpTable.applyPatch(state)).toBeUndefined();
    expect(state.parts.size).toBe(0);
  });
}
