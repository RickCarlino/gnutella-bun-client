import type { PeerRole } from "../types";
import { isMeshPeerRole } from "./classify";
import type { PeerRoleSummary, TopologySlotState } from "./types";

export function countPeersByRole(
  peers: Iterable<PeerRoleSummary>,
  role: PeerRole,
): number {
  let count = 0;
  for (const peer of peers) {
    if (peer.role === role) count++;
  }
  return count;
}

export function countLeafPeers(peers: Iterable<PeerRoleSummary>): number {
  return countPeersByRole(peers, "leaf");
}

export function countMeshPeers(peers: Iterable<PeerRoleSummary>): number {
  let count = 0;
  for (const peer of peers) {
    if (isMeshPeerRole(peer.role)) count++;
  }
  return count;
}

export function availableDialSlots(state: TopologySlotState): number {
  if (state.nodeMode === "ultrapeer") {
    return Math.max(
      0,
      state.maxUltrapeerConnections -
        state.connectedMeshPeerCount -
        state.dialingCount,
    );
  }
  return Math.max(
    0,
    state.maxUltrapeerConnections -
      state.connectedMeshPeerCount -
      state.dialingCount,
  );
}
