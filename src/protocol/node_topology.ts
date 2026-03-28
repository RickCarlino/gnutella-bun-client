import type { PeerCapabilities, PeerRole } from "../types";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";

function isMeshPeerRole(role: PeerRole): boolean {
  return role !== "leaf";
}

export function nodeMode(node: GnutellaServent) {
  return node.config().nodeMode;
}

export function classifyPeerRole(
  node: GnutellaServent,
  capabilities: PeerCapabilities,
): PeerRole {
  const remoteIsUltrapeer = capabilities.isUltrapeer;
  const mode = node.nodeMode();

  if (mode === "ultrapeer") {
    if (remoteIsUltrapeer === false) return "leaf";
    return remoteIsUltrapeer === true ? "ultrapeer" : "legacy";
  }

  if (mode === "leaf") {
    return remoteIsUltrapeer === true ? "ultrapeer" : "legacy";
  }

  if (remoteIsUltrapeer === true) return "ultrapeer";
  if (remoteIsUltrapeer === false) return "leaf";
  return "legacy";
}

export function peerRole(
  _node: GnutellaServent,
  peer: Pick<Peer, "role">,
): PeerRole {
  return peer.role;
}

export function countPeersByRole(
  node: GnutellaServent,
  role: PeerRole,
): number {
  let count = 0;
  for (const peer of node.peers.values()) {
    if (peer.role === role) count++;
  }
  return count;
}

export function connectedLeafCount(node: GnutellaServent): number {
  return node.countPeersByRole("leaf");
}

export function connectedMeshPeerCount(node: GnutellaServent): number {
  let count = 0;
  for (const peer of node.peers.values()) {
    if (isMeshPeerRole(peer.role)) count++;
  }
  return count;
}

export function availableDialSlots(node: GnutellaServent): number {
  const c = node.config();
  if (node.nodeMode() === "ultrapeer") {
    return Math.max(
      0,
      c.maxConnections - node.connectedMeshPeerCount() - node.dialing.size,
    );
  }
  if (node.nodeMode() === "leaf") {
    return Math.max(
      0,
      c.maxUltrapeerConnections -
        node.connectedMeshPeerCount() -
        node.dialing.size,
    );
  }
  return Math.max(
    0,
    c.maxConnections - node.peerCount() - node.dialing.size,
  );
}

export function canAcceptPeerRole(
  node: GnutellaServent,
  role: PeerRole,
): { ok: true } | { ok: false; code: number; reason: string } {
  const c = node.config();
  const mode = node.nodeMode();

  if (mode === "legacy") {
    if (node.peerCount() >= c.maxConnections) {
      return { ok: false, code: 503, reason: "Busy" };
    }
    return { ok: true };
  }

  if (mode === "leaf") {
    if (role === "leaf") {
      return {
        ok: false,
        code: 503,
        reason: `Shielded leaf node (${c.maxUltrapeerConnections} ultrapeers max)`,
      };
    }
    if (node.connectedMeshPeerCount() >= c.maxUltrapeerConnections) {
      return {
        ok: false,
        code: 503,
        reason: `Too many ultrapeer connections (${c.maxUltrapeerConnections} max)`,
      };
    }
    return { ok: true };
  }

  if (role === "leaf") {
    if (node.connectedLeafCount() >= c.maxLeafConnections) {
      return {
        ok: false,
        code: 503,
        reason: `Too many leaf connections (${c.maxLeafConnections} max)`,
      };
    }
    return { ok: true };
  }

  if (node.connectedMeshPeerCount() >= c.maxConnections) {
    return {
      ok: false,
      code: 503,
      reason: `Too many ultrapeer connections (${c.maxConnections} max)`,
    };
  }
  return { ok: true };
}

export function shouldRelayQueries(node: GnutellaServent): boolean {
  return node.nodeMode() !== "leaf";
}

export function shouldRelayPings(node: GnutellaServent): boolean {
  return node.nodeMode() !== "leaf";
}

export function isLeafPeer(
  _node: GnutellaServent,
  peer: Pick<Peer, "role">,
): boolean {
  return peer.role === "leaf";
}

export function isMeshPeer(
  _node: GnutellaServent,
  peer: Pick<Peer, "role">,
): boolean {
  return isMeshPeerRole(peer.role);
}
