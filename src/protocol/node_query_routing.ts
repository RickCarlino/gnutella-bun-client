import { TYPE } from "../const";
import {
  selectQueryRouteTargets,
  type QueryRouteCandidate,
} from "../query_routing/dynamic_query";
import { buildAggregateQrpTable, QrpTable } from "../query_routing/qrp";
import type { QueryDescriptor } from "../types";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";

const MAX_ULTRAPEER_QRP_TABLE_SIZE = 131072;

function buildAggregateUltrapeerQrp(node: GnutellaServent): QrpTable {
  return buildAggregateQrpTable(
    node.qrpTable,
    [...node.peers.values()]
      .filter((peer) => node.isLeafPeer(peer))
      .map((peer) => peer.remoteQrp),
    { maxTableSize: MAX_ULTRAPEER_QRP_TABLE_SIZE },
  );
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

function queryRouteCandidate(
  node: GnutellaServent,
  peer: Peer,
): QueryRouteCandidate<string> {
  return {
    id: peer.key,
    role: node.isLeafPeer(peer) ? "leaf" : "mesh",
    remoteQrp: peer.remoteQrp,
    supportsLastHopQrp:
      peer.role === "ultrapeer" &&
      !!peer.capabilities.ultrapeerQueryRoutingVersion,
  };
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
  const peers = [...node.peers.values()].filter(
    (peer) => !exceptPeerKey || peer.key !== exceptPeerKey,
  );
  const peerByKey = new Map(peers.map((peer) => [peer.key, peer]));
  const targets = selectQueryRouteTargets({
    nodeMode: node.nodeMode(),
    enableQrp: node.config().enableQrp,
    query: q,
    candidates: peers.map((peer) => queryRouteCandidate(node, peer)),
    ttl: logicalTtl,
    hops,
    localOrigin,
  });
  for (const target of targets) {
    const peer = peerByKey.get(target.id);
    if (!peer) continue;
    node.sendToPeer(
      peer,
      TYPE.QUERY,
      descriptorId,
      target.ttl,
      target.hops,
      payload,
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
