import { describe, expect, test } from "bun:test";

import {
  availableDialSlots,
  canAcceptPeerRole,
  classifyRemotePeerRole,
  countLeafPeers,
  countMeshPeers,
  countPeersByRole,
  isLeafPeerRole,
  isMeshPeerRole,
  shouldRelayForMode,
  type PeerRoleSummary,
  type TopologySlotState,
} from "../../../src/topology";

function state(patch: Partial<TopologySlotState> = {}): TopologySlotState {
  return {
    nodeMode: "leaf",
    maxUltrapeerConnections: 2,
    maxLeafConnections: 1,
    connectedMeshPeerCount: 0,
    connectedLeafCount: 0,
    dialingCount: 0,
    ...patch,
  };
}

describe("standalone topology", () => {
  test("classifies remote peers from structural capabilities", () => {
    expect(
      classifyRemotePeerRole({
        localMode: "leaf",
        remoteIsUltrapeer: undefined,
      }),
    ).toBe("leaf");
    expect(
      classifyRemotePeerRole({
        localMode: "leaf",
        remoteIsUltrapeer: false,
      }),
    ).toBe("leaf");
    expect(
      classifyRemotePeerRole({
        localMode: "ultrapeer",
        remoteIsUltrapeer: true,
      }),
    ).toBe("ultrapeer");
  });

  test("counts leaf and mesh roles", () => {
    const peers: PeerRoleSummary[] = [
      { role: "leaf" },
      { role: "ultrapeer" },
      { role: "ultrapeer" },
    ];

    expect(countPeersByRole(peers, "leaf")).toBe(1);
    expect(countPeersByRole(peers, "ultrapeer")).toBe(2);
    expect(countLeafPeers(peers)).toBe(1);
    expect(countMeshPeers(peers)).toBe(2);
    expect(isLeafPeerRole("leaf")).toBe(true);
    expect(isMeshPeerRole("leaf")).toBe(false);
    expect(isMeshPeerRole("ultrapeer")).toBe(true);
  });

  test("enforces shielded leaf admission and ultrapeer slots", () => {
    expect(canAcceptPeerRole(state(), "leaf")).toEqual({
      ok: false,
      code: 503,
      reason: "Shielded leaf node (2 ultrapeers max)",
    });
    expect(canAcceptPeerRole(state(), "ultrapeer")).toEqual({
      ok: true,
    });
    expect(
      canAcceptPeerRole(state({ connectedMeshPeerCount: 2 }), "ultrapeer"),
    ).toEqual({
      ok: false,
      code: 503,
      reason: "Too many ultrapeer connections (2 max)",
    });
  });

  test("enforces ultrapeer leaf and mesh admission", () => {
    expect(
      canAcceptPeerRole(
        state({
          nodeMode: "ultrapeer",
          connectedLeafCount: 1,
        }),
        "leaf",
      ),
    ).toEqual({
      ok: false,
      code: 503,
      reason: "Too many leaf connections (1 max)",
    });
    expect(
      canAcceptPeerRole(
        state({
          nodeMode: "ultrapeer",
          connectedLeafCount: 0,
        }),
        "leaf",
      ),
    ).toEqual({ ok: true });
    expect(
      canAcceptPeerRole(
        state({
          nodeMode: "ultrapeer",
          connectedMeshPeerCount: 2,
        }),
        "ultrapeer",
      ),
    ).toEqual({
      ok: false,
      code: 503,
      reason: "Too many ultrapeer connections (2 max)",
    });
  });

  test("computes dial slots and relay mode", () => {
    expect(
      availableDialSlots(
        state({ connectedMeshPeerCount: 1, dialingCount: 1 }),
      ),
    ).toBe(0);
    expect(
      availableDialSlots(
        state({
          nodeMode: "ultrapeer",
          maxUltrapeerConnections: 4,
          connectedMeshPeerCount: 1,
          dialingCount: 1,
        }),
      ),
    ).toBe(2);
    expect(shouldRelayForMode("leaf")).toBe(false);
    expect(shouldRelayForMode("ultrapeer")).toBe(true);
  });
});
