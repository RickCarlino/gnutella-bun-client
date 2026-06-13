import type { PeerRole } from "../types";
import type { PeerRoleClassification } from "./types";

export function isMeshPeerRole(role: PeerRole): boolean {
  return role !== "leaf";
}

export function isLeafPeerRole(role: PeerRole): boolean {
  return role === "leaf";
}

export function classifyRemotePeerRole(
  input: PeerRoleClassification,
): PeerRole {
  if (input.localMode === "ultrapeer") {
    return input.remoteIsUltrapeer === true ? "ultrapeer" : "leaf";
  }
  return input.remoteIsUltrapeer === true ? "ultrapeer" : "leaf";
}
