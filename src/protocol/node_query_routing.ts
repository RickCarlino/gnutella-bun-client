import { TYPE } from "../const";
import type { QueryDescriptor } from "../types";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";
import { canRouteRemoteQrpQuery, QrpTable } from "./qrp";

function canRouteQueryToPeer(
  node: GnutellaServent,
  peer: Peer,
  q: QueryDescriptor,
): boolean {
  if (!node.config().enableQrp) return true;
  if (node.isLeafPeer(peer))
    return canRouteRemoteQrpQuery(peer.remoteQrp, q);
  if (
    peer.role === "ultrapeer" &&
    peer.capabilities.ultrapeerQueryRoutingVersion
  ) {
    return canRouteRemoteQrpQuery(peer.remoteQrp, q);
  }
  return true;
}

function buildAggregateUltrapeerQrp(node: GnutellaServent): QrpTable {
  const table = new QrpTable(
    node.qrpTable.tableSize,
    node.qrpTable.infinity,
    1,
  );
  table.clear();
  table.mergeFromQrp(node.qrpTable);
  for (const peer of node.peers.values()) {
    if (!node.isLeafPeer(peer)) continue;
    table.mergeFromRemoteQrp(peer.remoteQrp);
  }
  return table;
}

export function sendPublishedQrpToMeshPeers(node: GnutellaServent): void {
  if (node.nodeMode() !== "ultrapeer" || !node.config().enableQrp) return;
  for (const peer of node.peers.values()) {
    if (!node.isMeshPeer(peer)) continue;
    void node.sendQrpTable(peer).catch(() => void 0);
  }
}

export function publishedQrpTableForPeer(
  node: GnutellaServent,
  peer: Peer,
): QrpTable | undefined {
  if (!node.config().enableQrp) return undefined;
  if (node.nodeMode() === "ultrapeer") {
    if (!node.isMeshPeer(peer)) return undefined;
    if (!peer.capabilities.ultrapeerQueryRoutingVersion) return undefined;
    return buildAggregateUltrapeerQrp(node);
  }
  if (
    !(
      peer.capabilities.queryRoutingVersion ||
      peer.capabilities.ultrapeerQueryRoutingVersion
    )
  ) {
    return undefined;
  }
  return node.qrpTable;
}

function sendQueryToLeafPeer(
  node: GnutellaServent,
  peer: Peer,
  descriptorId: Buffer,
  logicalTtl: number,
  hops: number,
  payload: Buffer,
  q: QueryDescriptor,
): boolean {
  if (!node.isLeafPeer(peer)) return false;
  if (!canRouteQueryToPeer(node, peer, q)) return true;
  node.sendToPeer(
    peer,
    TYPE.QUERY,
    descriptorId,
    Math.max(1, logicalTtl),
    hops,
    payload,
  );
  return true;
}

function sendLocalOriginQueryToMeshPeer(
  node: GnutellaServent,
  peer: Peer,
  descriptorId: Buffer,
  logicalTtl: number,
  hops: number,
  payload: Buffer,
  q: QueryDescriptor,
): boolean {
  if (logicalTtl <= 0) return true;
  if (
    node.nodeMode() === "ultrapeer" &&
    logicalTtl === 1 &&
    !canRouteQueryToPeer(node, peer, q)
  ) {
    return true;
  }
  node.sendToPeer(
    peer,
    TYPE.QUERY,
    descriptorId,
    logicalTtl,
    hops,
    payload,
  );
  return true;
}

function sendRelayedQueryToMeshPeer(
  node: GnutellaServent,
  peer: Peer,
  descriptorId: Buffer,
  logicalTtl: number,
  hops: number,
  payload: Buffer,
  q: QueryDescriptor,
): void {
  if (logicalTtl <= 0 || node.nodeMode() === "leaf") return;
  if (node.nodeMode() === "ultrapeer" && logicalTtl === 1) {
    if (!canRouteQueryToPeer(node, peer, q)) return;
    node.sendToPeer(peer, TYPE.QUERY, descriptorId, 1, hops, payload);
    return;
  }
  node.sendToPeer(
    peer,
    TYPE.QUERY,
    descriptorId,
    logicalTtl - 1,
    hops + 1,
    payload,
  );
}

export function routeQueryToPeers(
  node: GnutellaServent,
  descriptorId: Buffer,
  logicalTtl: number,
  hops: number,
  payload: Buffer,
  q: QueryDescriptor,
  exceptPeerKey?: string,
  localOrigin = false,
): void {
  for (const candidate of node.peers.values()) {
    if (exceptPeerKey && candidate.key === exceptPeerKey) continue;
    if (
      sendQueryToLeafPeer(
        node,
        candidate,
        descriptorId,
        logicalTtl,
        hops,
        payload,
        q,
      )
    ) {
      continue;
    }
    if (localOrigin) {
      sendLocalOriginQueryToMeshPeer(
        node,
        candidate,
        descriptorId,
        logicalTtl,
        hops,
        payload,
        q,
      );
      continue;
    }
    sendRelayedQueryToMeshPeer(
      node,
      candidate,
      descriptorId,
      logicalTtl,
      hops,
      payload,
      q,
    );
  }
}

export function broadcastPingToPeers(
  node: GnutellaServent,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  exceptPeerKey?: string,
): void {
  const skipLeaves = node.nodeMode() === "ultrapeer";
  const peers = [...node.peers.values()];
  for (const peer of peers) {
    const skipPeer = exceptPeerKey != null && peer.key === exceptPeerKey;
    const skipLeaf = skipLeaves && node.isLeafPeer(peer);
    if (skipPeer || skipLeaf) continue;
    node.sendToPeer(peer, TYPE.PING, descriptorId, ttl, hops, payload);
  }
}
