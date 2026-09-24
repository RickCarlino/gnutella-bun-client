import type { PeerRole } from "../../types";
import type { PeerRoleClassification } from "./types";

/** Check whether a role belongs to the routing mesh. */
export function isMeshPeerRole(role: PeerRole): boolean {
  return role !== "leaf";
}

/** Check whether a role identifies a leaf. */
export function isLeafPeerRole(role: PeerRole): boolean {
  return role === "leaf";
}

/** Determine the remote role from handshake declarations. */
export function classifyRemotePeerRole(
  input: PeerRoleClassification,
): PeerRole {
  if (input.localMode === "ultrapeer") {
    return input.remoteIsUltrapeer === true ? "ultrapeer" : "leaf";
  }
  return input.remoteIsUltrapeer === true ? "ultrapeer" : "leaf";
}
