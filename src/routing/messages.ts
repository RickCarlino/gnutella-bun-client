import { descriptorTypeName } from "../connections/transport";
import type { PeerConnection as Peer } from "../connections/types";
import { TYPE } from "../const";
import { ts } from "../shared";
import type { QueryDescriptor, Route } from "../types";
import {
  encodeBye,
  encodePong,
  encodeQueryHit,
  parseBye,
  parsePong,
  parsePush,
  parseQuery,
  parseQueryHit,
} from "../wire/codec";
import type { DescriptorHeader } from "../wire/types";
import {
  forwardedDescriptorLifetime,
  normalizeQueryLifetime as normalizeQueryLifetimePolicy,
  overflowPongCacheKeys,
  pongCacheKey,
  pongReplyTtl,
  queryHitReplyTtl,
  responseRouteDecision,
  selectCachedPongPayloads,
  shouldMarkDescriptorSeen,
  shouldRelayPing,
  shouldSuppressDescriptor,
} from "./descriptors";
import type { DescriptorLifetime } from "./descriptors/types";
import { splitSearchTerms } from "./qrp";
import { broadcastPingToPeers, routeQueryToPeers } from "./queries";
import type { MessageRouter } from "./router";

type RoutedDescriptor = Pick<
  DescriptorHeader,
  "descriptorId" | "descriptorIdHex" | "payloadType" | "ttl" | "hops"
>;

/** Apply routing guards before dispatching a descriptor. */
export function handleDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  if (router.rejectRelayedLeafDescriptor(peer, hdr)) return;
  if (router.shouldIgnoreDescriptor(peer, hdr, payload)) return;
  if (shouldMarkDescriptorSeen(hdr.payloadType)) {
    router.markSeen(hdr.payloadType, hdr.descriptorIdHex, payload);
  }
  router.dispatchDescriptor(peer, hdr, payload);
}

/** Invoke the handler for a descriptor's payload type. */
export function dispatchDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  switch (hdr.payloadType) {
    case TYPE.PING:
      router.onPingDescriptor(peer, hdr, payload);
      return;
    case TYPE.PONG:
      router.onPong(peer, hdr, payload);
      return;
    case TYPE.BYE:
      router.onBye(peer, payload);
      return;
    case TYPE.ROUTE_TABLE_UPDATE:
      router.onRouteTableUpdate(peer, payload);
      return;
    case TYPE.QUERY:
      router.onQueryDescriptor(peer, hdr, payload);
      return;
    case TYPE.QUERY_HIT:
      router.onQueryHit(peer, hdr, payload);
      return;
    case TYPE.PUSH:
      void router.onPush(peer, hdr, payload);
      return;
    default:
      return;
  }
}

/** Answer a query locally and relay it when allowed. */
export function onQueryDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const q = parseQuery(payload);
  const normalized = router.normalizeQueryLifetime(hdr.ttl, hdr.hops);
  router.deps.emit({
    type: "QUERY_RECEIVED",
    at: ts(),
    peer: router.deps.transport.peerInfo(peer),
    descriptorIdHex: hdr.descriptorIdHex,
    ttl: normalized?.ttl ?? hdr.ttl,
    hops: hdr.hops,
    search: q.search,
    urns: q.urns,
  });
  if (!normalized) return;
  hdr.ttl = normalized.ttl;
  hdr.hops = normalized.hops;
  if (router.shouldIgnoreQuery(hdr, q)) return;
  router.queryRoutes.set(hdr.descriptorIdHex, {
    peerKey: peer.key,
    ts: router.now(),
  });
  router.respondQueryHit(peer, hdr, q);
  if (!router.deps.transport.shouldRelayQueries()) return;
  routeQueryToPeers(
    router,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
    q,
    peer.key,
  );
}

/** Remember the push route and deliver or forward hits. */
export function onQueryHit(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const qh = parseQueryHit(payload);
  router.pushRoutes.set(qh.serventIdHex, {
    peerKey: peer.key,
    ts: router.now(),
  });
  const decision = responseRouteDecision(
    router.queryRoutes.get(hdr.descriptorIdHex),
    { nodeMode: router.deps.transport.nodeMode() },
  );
  if (decision.kind === "drop") return;
  if (decision.kind === "local") {
    router.deps.search.ingest(
      {
        queryIdHex: hdr.descriptorIdHex,
        queryHops: hdr.hops,
        viaPeerKey: peer.key,
      },
      qh,
    );
    return;
  }
  router.forwardToRoute(
    decision.route,
    TYPE.QUERY_HIT,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

/** Fulfill a local push request or forward it toward its owner. */
export async function onPush(
  router: MessageRouter,
  _peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): Promise<void> {
  const push = parsePush(payload);
  if (push.serventIdHex === router.deps.serventId.toString("hex")) {
    await router.deps.fulfillPush(push);
    return;
  }
  if (router.deps.transport.nodeMode() === "leaf") return;
  const decision = responseRouteDecision(
    router.pushRoutes.get(push.serventIdHex),
    { nodeMode: router.deps.transport.nodeMode() },
  );
  if (decision.kind !== "forward") return;
  router.forwardToRoute(
    decision.route,
    TYPE.PUSH,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

/** Remember the return route, answer, and possibly relay a ping. */
export function onPingDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  router.pingRoutes.set(hdr.descriptorIdHex, {
    peerKey: peer.key,
    ts: router.now(),
  });
  router.respondPong(peer, hdr);
  if (!router.deps.transport.shouldRelayPings()) return;
  if (
    !shouldRelayPing(
      hdr.ttl,
      router.now(),
      router.peerState(peer).lastPingAt,
      1000,
    )
  )
    return;
  router.peerState(peer).lastPingAt = router.now();
  broadcastPingToPeers(
    router,
    hdr.descriptorId,
    hdr.ttl - 1,
    hdr.hops + 1,
    payload,
    peer.key,
  );
}

/** Cache a discovered endpoint and deliver or forward its pong. */
export function onPong(
  router: MessageRouter,
  _peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const pong = parsePong(payload);
  router.cachePongPayload(payload);
  router.deps.discoveredPeer(pong.ip, pong.port);
  const decision = responseRouteDecision(
    router.pingRoutes.get(hdr.descriptorIdHex),
    { forwardInLeaf: true },
  );
  if (decision.kind === "drop") return;
  if (decision.kind === "local") {
    router.deps.emit({
      type: "PONG",
      at: ts(),
      ip: pong.ip,
      port: pong.port,
      files: pong.files,
      kbytes: pong.kbytes,
    });
    return;
  }
  router.forwardToRoute(
    decision.route,
    TYPE.PONG,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

/** Consume a disconnect notice and end the peer socket. */
export function onBye(
  _router: MessageRouter,
  peer: Peer,
  payload: Buffer,
): void {
  try {
    parseBye(payload);
  } catch {}
  peer.socket.end();
}

/** Forward along a saved route with updated TTL and hops. */
export function forwardToRoute(
  router: MessageRouter,
  route: Route,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
): void {
  const lifetime = forwardedDescriptorLifetime(ttl, hops);
  if (!lifetime) return;
  const peer = router.deps.transport.peers.get(route.peerKey);
  if (!peer) return;
  router.deps.transport.sendToPeer(
    peer,
    payloadType,
    descriptorId,
    lifetime.ttl,
    lifetime.hops,
    payload,
  );
}

/** Send a descriptor to every peer except an optional exclusion. */
export function broadcast(
  router: MessageRouter,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  exceptPeerKey?: string,
): void {
  for (const peer of router.deps.transport.peers.values()) {
    if (exceptPeerKey && peer.key === exceptPeerKey) continue;
    router.deps.transport.sendToPeer(
      peer,
      payloadType,
      descriptorId,
      ttl,
      hops,
      payload,
    );
  }
}

/** Route an originating query using its encoded payload. */
export function broadcastQuery(
  router: MessageRouter,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  _search: string,
  exceptPeerKey?: string,
): void {
  routeQueryToPeers(
    router,
    descriptorId,
    ttl,
    hops,
    payload,
    parseQuery(payload),
    exceptPeerKey,
    true,
  );
}

/** Clamp query lifetime or reject invalid TTL and hops. */
export function normalizeQueryLifetime(
  router: MessageRouter,
  ttl: number,
  hops: number,
): DescriptorLifetime | null {
  return normalizeQueryLifetimePolicy(ttl, hops, router.config().maxTtl);
}

/** Recognize a one-hop request for the full share index. */
export function isIndexQuery(
  _router: MessageRouter,
  hdr: Pick<DescriptorHeader, "ttl" | "hops">,
  q: QueryDescriptor,
): boolean {
  return hdr.ttl === 1 && hdr.hops === 0 && q.search === "    ";
}

/** Reject empty or trivial searches except valid index queries. */
export function shouldIgnoreQuery(
  router: MessageRouter,
  hdr: Pick<DescriptorHeader, "ttl" | "hops">,
  q: QueryDescriptor,
): boolean {
  if (q.urns.length) return false;
  if (router.isIndexQuery(hdr, q)) return false;
  if (!q.search.trim()) return true;
  const words = splitSearchTerms(q.search);
  if (!words.length) return true;
  return words.every((word) => word.length <= 1);
}

/** Cache a pong and evict entries beyond capacity. */
export function cachePongPayload(
  router: MessageRouter,
  payload: Buffer,
): void {
  const digest = pongCacheKey(payload);
  router.pongCache.set(digest, {
    payload: Buffer.from(payload),
    at: router.now(),
  });
  for (const key of overflowPongCacheKeys(
    router.pongCache.entries(),
    64,
  )) {
    router.pongCache.delete(key);
  }
}

/** Check duplicate and closing-peer suppression rules. */
export function shouldIgnoreDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): boolean {
  return shouldSuppressDescriptor({
    closingAfterBye: !!peer.closingAfterBye,
    payloadType: hdr.payloadType,
    alreadySeen: router.hasSeen(
      hdr.payloadType,
      hdr.descriptorIdHex,
      payload,
    ),
  });
}

/** Disconnect a leaf that relays another node's traffic. */
export function rejectRelayedLeafDescriptor(
  router: MessageRouter,
  peer: Peer,
  hdr: RoutedDescriptor,
): boolean {
  if (!router.deps.transport.isLeafPeer(peer) || hdr.hops === 0)
    return false;
  if (peer.capabilities.supportsBye)
    router.sendBye(
      peer,
      414,
      `Leaf node relayed ${descriptorTypeName(hdr.payloadType)}`,
    );
  else peer.socket.end();
  return true;
}

/** Send a disconnect notice and mark the peer as closing. */
export function sendBye(
  router: MessageRouter,
  peer: Peer,
  code: number,
  message: string,
): void {
  peer.closingAfterBye = true;
  router.deps.transport.sendToPeer(
    peer,
    TYPE.BYE,
    router.randomId16(),
    1,
    0,
    encodeBye(code, message),
  );
}

/** Reply with local statistics and eligible cached pongs. */
export function respondPong(
  router: MessageRouter,
  peer: Peer,
  hdr: Pick<DescriptorHeader, "descriptorId" | "hops">,
): void {
  const ttl = pongReplyTtl(hdr.hops);
  const own = encodePong(
    router.deps.address.currentAdvertisedPort(),
    router.deps.address.currentAdvertisedHost(),
    router.deps.shares.list().length,
    router.deps.shares.totalSharedKBytes(),
  );
  router.deps.transport.sendToPeer(
    peer,
    TYPE.PONG,
    hdr.descriptorId,
    ttl,
    0,
    own,
  );
  if (!router.config().enablePongCaching) return;
  let sent = 1;
  for (const payload of selectCachedPongPayloads(
    router.pongCache.values(),
    sent,
    10,
  )) {
    router.deps.transport.sendToPeer(
      peer,
      TYPE.PONG,
      hdr.descriptorId,
      ttl,
      0,
      payload,
    );
    sent++;
  }
}

/** Send bounded batches of matching local shares. */
export function respondQueryHit(
  router: MessageRouter,
  peer: Peer,
  hdr: Pick<DescriptorHeader, "descriptorId" | "hops" | "ttl">,
  payloadOrQuery: Buffer | QueryDescriptor,
): void {
  const q = Buffer.isBuffer(payloadOrQuery)
    ? parseQuery(payloadOrQuery)
    : payloadOrQuery;
  const matches = router.isIndexQuery(hdr, q)
    ? router.deps.shares.list()
    : router.deps.shares.matches(q);
  if (!matches.length) return;
  const limit = Math.max(1, router.config().maxResultsPerQuery);
  const batchSize = 16;
  const chosen = matches.slice(0, limit);
  const replyTtl = queryHitReplyTtl(hdr.hops, router.config().maxTtl);
  for (let off = 0; off < chosen.length; off += batchSize) {
    const batch = chosen.slice(off, off + batchSize);
    const out = encodeQueryHit(
      router.deps.address.currentAdvertisedPort(),
      router.deps.address.currentAdvertisedHost(),
      router.config().advertisedSpeedKBps,
      batch,
      router.deps.serventId,
      {
        vendorCode: router.config().vendorCode,
        push: false,
        busy: false,
        haveUploaded: false,
        measuredSpeed: true,
        ggepHashes: q.ggepHAllowed && !!router.config().enableGgep,
        browseHost: !!router.config().enableGgep,
      },
    );
    router.deps.transport.sendToPeer(
      peer,
      TYPE.QUERY_HIT,
      hdr.descriptorId,
      replyTtl,
      0,
      out,
    );
  }
}
