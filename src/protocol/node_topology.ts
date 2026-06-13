import type { PeerCapabilities, PeerRole } from "../types";
import {
  availableDialSlots as topologyAvailableDialSlots,
  canAcceptPeerRole as topologyCanAcceptPeerRole,
  classifyRemotePeerRole,
  countLeafPeers,
  countMeshPeers,
  countPeersByRole as topologyCountPeersByRole,
  isLeafPeerRole,
  isMeshPeerRole,
  shouldRelayForMode,
  type AdmissionResult,
  type TopologySlotState,
} from "../topology";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";

export function nodeMode(node: GnutellaServent) {
  return node.config().nodeMode;
}

function topologySlotState(node: GnutellaServent): TopologySlotState {
  const c = node.config();
  return {
    nodeMode: node.nodeMode(),
    maxUltrapeerConnections: c.maxUltrapeerConnections,
    maxLeafConnections: c.maxLeafConnections,
    connectedMeshPeerCount: node.connectedMeshPeerCount(),
    connectedLeafCount: node.connectedLeafCount(),
    dialingCount: node.dialing.size,
  };
}

export function classifyPeerRole(
  node: GnutellaServent,
  capabilities: PeerCapabilities,
): PeerRole {
  return classifyRemotePeerRole({
    localMode: node.nodeMode(),
    remoteIsUltrapeer: capabilities.isUltrapeer,
  });
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
  return topologyCountPeersByRole(node.peers.values(), role);
}

export function connectedLeafCount(node: GnutellaServent): number {
  return countLeafPeers(node.peers.values());
}

export function connectedMeshPeerCount(node: GnutellaServent): number {
  return countMeshPeers(node.peers.values());
}

export function availableDialSlots(node: GnutellaServent): number {
  return topologyAvailableDialSlots(topologySlotState(node));
}

export function canAcceptPeerRole(
  node: GnutellaServent,
  role: PeerRole,
): AdmissionResult {
  return topologyCanAcceptPeerRole(topologySlotState(node), role);
}

export function shouldRelayQueries(node: GnutellaServent): boolean {
  return shouldRelayForMode(node.nodeMode());
}

export function shouldRelayPings(node: GnutellaServent): boolean {
  return shouldRelayForMode(node.nodeMode());
}

export function isLeafPeer(
  _node: GnutellaServent,
  peer: Pick<Peer, "role">,
): boolean {
  return isLeafPeerRole(peer.role);
}

export function isMeshPeer(
  _node: GnutellaServent,
  peer: Pick<Peer, "role">,
): boolean {
  return isMeshPeerRole(peer.role);
}
