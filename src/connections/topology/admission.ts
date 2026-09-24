import type { PeerRole } from "../../types";
import type { AdmissionResult, TopologySlotState } from "./types";

/** Check connection capacity for the proposed peer role. */
export function canAcceptPeerRole(
  state: TopologySlotState,
  role: PeerRole,
): AdmissionResult {
  if (state.nodeMode === "leaf") {
    if (role === "leaf") {
      return {
        ok: false,
        code: 503,
        reason: `Shielded leaf node (${state.maxUltrapeerConnections} ultrapeers max)`,
      };
    }
    if (state.connectedMeshPeerCount >= state.maxUltrapeerConnections) {
      return {
        ok: false,
        code: 503,
        reason: `Too many ultrapeer connections (${state.maxUltrapeerConnections} max)`,
      };
    }
    return { ok: true };
  }

  if (role === "leaf") {
    if (state.connectedLeafCount >= state.maxLeafConnections) {
      return {
        ok: false,
        code: 503,
        reason: `Too many leaf connections (${state.maxLeafConnections} max)`,
      };
    }
    return { ok: true };
  }

  if (state.connectedMeshPeerCount >= state.maxUltrapeerConnections) {
    return {
      ok: false,
      code: 503,
      reason: `Too many ultrapeer connections (${state.maxUltrapeerConnections} max)`,
    };
  }
  return { ok: true };
}

/** Allow relaying only when running as an ultrapeer. */
export function shouldRelayForMode(
  nodeMode: TopologySlotState["nodeMode"],
): boolean {
  return nodeMode === "ultrapeer";
}
