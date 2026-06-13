import { describe, expect, test } from "bun:test";

import {
  buildAggregateQrpTable,
  canRouteRemoteQrpQuery,
  initialRemoteQrpState,
  QrpTable,
  selectQueryRouteTargets,
  type QueryRouteCandidate,
  type RemoteQrpState,
} from "../../../src/query_routing";

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
