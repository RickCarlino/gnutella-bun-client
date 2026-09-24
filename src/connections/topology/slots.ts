import type { PeerRole } from "../../types";
import { isMeshPeerRole } from "./classify";
import type { PeerRoleSummary, TopologySlotState } from "./types";

/** Count peers assigned to a particular role. */
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

/** Count connected leaf peers. */
export function countLeafPeers(peers: Iterable<PeerRoleSummary>): number {
  return countPeersByRole(peers, "leaf");
}

/** Count peers participating in the routing mesh. */
export function countMeshPeers(peers: Iterable<PeerRoleSummary>): number {
  let count = 0;
  for (const peer of peers) {
    if (isMeshPeerRole(peer.role)) count++;
  }
  return count;
}

/** Count remaining slots after connections and pending dials. */
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
