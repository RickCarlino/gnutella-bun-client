import { DEFAULT_QRP_ENTRY_BITS, TYPE } from "../const";
import { errMsg } from "../shared";
import { parseRouteTableUpdate } from "./codec";
import type { GnutellaServent } from "./node";
import {
  publishedQrpTableForPeer,
  sendPublishedQrpToMeshPeers,
} from "./node_query_routing";
import type { Peer } from "./node_types";
import {
  QrpTable,
  validateRemoteQrpPatchSequence,
  validateRemoteQrpReset,
} from "./qrp";

function rejectQrpUpdate(
  node: GnutellaServent,
  peer: Peer,
  reason: string,
): void {
  if (peer.capabilities.supportsBye) node.sendBye(peer, 413, reason);
  else peer.socket.end();
}

export function onRouteTableUpdate(
  node: GnutellaServent,
  peer: Peer,
  payload: Buffer,
): void {
  let msg: ReturnType<typeof parseRouteTableUpdate>;
  try {
    msg = parseRouteTableUpdate(payload);
  } catch (error) {
    rejectQrpUpdate(node, peer, errMsg(error));
    return;
  }
  if (msg.variant === "reset") {
    const rejection = validateRemoteQrpReset(msg);
    if (rejection) {
      rejectQrpUpdate(node, peer, rejection);
      return;
    }
    peer.remoteQrp.resetSeen = true;
    peer.remoteQrp.tableSize = msg.tableLength;
    peer.remoteQrp.infinity = msg.infinity;
    peer.remoteQrp.entryBits = DEFAULT_QRP_ENTRY_BITS;
    peer.remoteQrp.table = null;
    peer.remoteQrp.seqSize = 0;
    peer.remoteQrp.parts.clear();
    return;
  }
  const rejection = validateRemoteQrpPatchSequence(peer.remoteQrp, msg);
  if (rejection) {
    rejectQrpUpdate(node, peer, rejection);
    return;
  }
  peer.remoteQrp.seqSize = msg.seqSize;
  peer.remoteQrp.compressor = msg.compressor;
  peer.remoteQrp.entryBits = msg.entryBits;
  peer.remoteQrp.parts.set(msg.seqNo, Buffer.from(msg.data));
  QrpTable.applyPatch(peer.remoteQrp);
  if (peer.remoteQrp.table && peer.role === "leaf")
    sendPublishedQrpToMeshPeers(node);
}

export async function sendQrpTable(
  node: GnutellaServent,
  peer: Peer,
): Promise<void> {
  const published = publishedQrpTableForPeer(node, peer);
  if (!published) return;
  node.sendToPeer(
    peer,
    TYPE.ROUTE_TABLE_UPDATE,
    node.randomId16(),
    1,
    0,
    published.encodeReset(),
  );
  for (const patch of published.encodePatchChunks(
    Math.min(node.config().maxPayloadBytes, 60 * 1024),
  )) {
    node.sendToPeer(
      peer,
      TYPE.ROUTE_TABLE_UPDATE,
      node.randomId16(),
      1,
      0,
      patch,
    );
    await node.sleep(5);
  }
}
