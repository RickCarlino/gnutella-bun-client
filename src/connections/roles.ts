import type { PeerCapabilities, PeerRole } from "../types";
import type { PeerConnections } from "./connections";
import {
  classifyRemotePeerRole,
  countLeafPeers,
  countMeshPeers,
  isLeafPeerRole,
  isMeshPeerRole,
  shouldRelayForMode,
  availableDialSlots as topologyAvailableDialSlots,
  canAcceptPeerRole as topologyCanAcceptPeerRole,
  countPeersByRole as topologyCountPeersByRole,
  type AdmissionResult,
  type TopologySlotState,
} from "./topology";
import type { PeerConnection as Peer } from "./types";

/** Return the configured leaf or ultrapeer mode. */
export function nodeMode(connections: PeerConnections) {
  return connections.config().nodeMode;
}

function topologySlotState(
  connections: PeerConnections,
): TopologySlotState {
  const c = connections.config();
  return {
    nodeMode: connections.nodeMode(),
    maxUltrapeerConnections: c.maxUltrapeerConnections,
    maxLeafConnections: c.maxLeafConnections,
    connectedMeshPeerCount: connections.connectedMeshPeerCount(),
    connectedLeafCount: connections.connectedLeafCount(),
    dialingCount: connections.dialing.size,
  };
}

/** Determine a peer's role from negotiated capabilities. */
export function classifyPeerRole(
  connections: PeerConnections,
  capabilities: PeerCapabilities,
): PeerRole {
  return classifyRemotePeerRole({
    localMode: connections.nodeMode(),
    remoteIsUltrapeer: capabilities.isUltrapeer,
  });
}

/** Return a peer's assigned role. */
export function peerRole(
  _connections: PeerConnections,
  peer: Pick<Peer, "role">,
): PeerRole {
  return peer.role;
}

/** Count peers assigned to a particular role. */
export function countPeersByRole(
  connections: PeerConnections,
  role: PeerRole,
): number {
  return topologyCountPeersByRole(connections.peers.values(), role);
}

/** Count connected leaf peers. */
export function connectedLeafCount(connections: PeerConnections): number {
  return countLeafPeers(connections.peers.values());
}

/** Count connected routing-mesh peers. */
export function connectedMeshPeerCount(
  connections: PeerConnections,
): number {
  return countMeshPeers(connections.peers.values());
}

/** Count remaining slots after connections and pending dials. */
export function availableDialSlots(connections: PeerConnections): number {
  return topologyAvailableDialSlots(topologySlotState(connections));
}

/** Check connection capacity for the proposed peer role. */
export function canAcceptPeerRole(
  connections: PeerConnections,
  role: PeerRole,
): AdmissionResult {
  return topologyCanAcceptPeerRole(topologySlotState(connections), role);
}

/** Check whether this node may forward queries. */
export function shouldRelayQueries(connections: PeerConnections): boolean {
  return shouldRelayForMode(connections.nodeMode());
}

/** Check whether this node may forward pings. */
export function shouldRelayPings(connections: PeerConnections): boolean {
  return shouldRelayForMode(connections.nodeMode());
}

/** Check whether a connected peer is a leaf. */
export function isLeafPeer(
  _connections: PeerConnections,
  peer: Pick<Peer, "role">,
): boolean {
  return isLeafPeerRole(peer.role);
}

/** Check whether a connected peer belongs to the mesh. */
export function isMeshPeer(
  _connections: PeerConnections,
  peer: Pick<Peer, "role">,
): boolean {
  return isMeshPeerRole(peer.role);
}
