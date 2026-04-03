import crypto from "node:crypto";
import type net from "node:net";
import zlib from "node:zlib";

import {
  DEFAULT_QRP_ENTRY_BITS,
  HEADER_LEN,
  LOCAL_ROUTE,
  TYPE,
  TYPE_NAME,
} from "../const";
import { errMsg, toBuffer, ts } from "../shared";
import type {
  PendingPush,
  PeerRole,
  PeerCapabilities,
  QueryDescriptor,
  Route,
  SearchHit,
} from "../types";
import {
  buildHeader,
  encodeBye,
  encodePong,
  encodeQueryHit,
  parseBye,
  parseHeader,
  parsePong,
  parsePush,
  parseQuery,
  parseQueryHit,
  parseRouteTableUpdate,
} from "./codec";
import {
  findHeaderEnd,
  parseHttpHeaders,
  socketCanEnd,
} from "./handshake";
import type { GnutellaServent } from "./node";
import {
  broadcastPingToPeers,
  publishedQrpTableForPeer,
  routeQueryToPeers,
  sendPublishedQrpToMeshPeers,
} from "./node_query_routing";
import type {
  DescriptorHeader,
  HttpSession,
  HttpSessionRequest,
  Peer,
} from "./node_types";
import { firstSha1Urn } from "./content_urn";
import {
  initialRemoteQrpState,
  matchQuery as shareMatchesQuery,
  QrpTable,
  splitSearchTerms,
} from "./qrp";
import { applyRtcCapabilityToHit, queryHitRtcGgepItems } from "./node_rtc";

function descriptorTypeName(payloadType: number): string {
  return TYPE_NAME[payloadType] || `0x${payloadType.toString(16)}`;
}

type RoutedDescriptor = Pick<
  DescriptorHeader,
  "descriptorId" | "descriptorIdHex" | "payloadType" | "ttl" | "hops"
>;

const MAX_HTTP_REQUEST_BODY_BYTES = 256 * 1024;

export function attachPeer(
  node: GnutellaServent,
  socket: net.Socket,
  outbound: boolean,
  remoteLabel: string,
  role: PeerRole,
  capabilities: PeerCapabilities,
  initialBuf: Buffer = Buffer.alloc(0),
  dialTarget?: string,
): Peer {
  const connectedAt = node.now();
  const key = `p${++node.peerSeq}`;
  const peer: Peer = {
    key,
    socket,
    buf: Buffer.alloc(0),
    outbound,
    remoteLabel,
    dialTarget,
    role,
    capabilities,
    remoteQrp: initialRemoteQrpState(),
    lastPingAt: 0,
    connectedAt,
  };
  node.peers.set(key, peer);
  socket.setNoDelay(true);
  socket.setTimeout(0);

  let closed = false;
  const drop = (message: string) => {
    if (closed) return;
    closed = true;
    const hadLeafQrp =
      node.nodeMode() === "ultrapeer" &&
      peer.role === "leaf" &&
      peer.remoteQrp.table != null;
    node.markPeerSeenIfStable(peer);
    node.peers.delete(peer.key);
    node.refreshGWebCacheReport();
    if (hadLeafQrp) sendPublishedQrpToMeshPeers(node);
    if (!node.stopped) {
      node.emitEvent({
        type: "PEER_DROPPED",
        at: ts(),
        peer: node.peerInfo(peer),
        message,
      });
    }
  };

  if (peer.capabilities.compressOut) {
    peer.deflater = zlib.createDeflate();
    peer.deflater.on("data", (chunk) => {
      if (!socket.destroyed) socket.write(chunk);
    });
    peer.deflater.on("error", (error) => {
      drop(`deflater error: ${errMsg(error)}`);
      socket.destroy();
    });
  }

  const feedDecoded = (chunk: Buffer) => {
    peer.buf = Buffer.concat([peer.buf, chunk]);
    try {
      node.consumePeerBuffer(peer);
    } catch (error) {
      drop(errMsg(error));
      socket.destroy();
    }
  };

  if (peer.capabilities.compressIn) {
    peer.inflater = zlib.createInflate();
    peer.inflater.on("data", (chunk) => feedDecoded(toBuffer(chunk)));
    peer.inflater.on("error", (error) => {
      drop(`inflater error: ${errMsg(error)}`);
      socket.destroy();
    });
  }

  socket.on("data", (chunk) => {
    if (closed) return;
    const data = toBuffer(chunk);
    if (peer.inflater) peer.inflater.write(data);
    else feedDecoded(data);
  });
  socket.on("close", () => drop("socket closed"));
  socket.on("error", (error) => drop(errMsg(error)));

  if (initialBuf.length) {
    if (peer.inflater) peer.inflater.write(initialBuf);
    else feedDecoded(initialBuf);
  }

  node.rememberPeerAddresses(peer);
  node.refreshGWebCacheReport();
  node.emitEvent({
    type: "PEER_CONNECTED",
    at: ts(),
    peer: node.peerInfo(peer),
  });
  node.scheduleOnce(300, () => node.sendPing(1));
  if (
    node.config().enableQrp &&
    (capabilities.queryRoutingVersion ||
      capabilities.ultrapeerQueryRoutingVersion)
  ) {
    node.scheduleOnce(
      500,
      () => void node.sendQrpTable(peer).catch(() => void 0),
    );
  }
  return peer;
}

export function startHttpSession(
  node: GnutellaServent,
  socket: net.Socket,
  firstHead: string,
  initialBuf: Buffer = Buffer.alloc(0),
): void {
  const session: HttpSession = {
    socket,
    buf: Buffer.from(initialBuf),
    busy: false,
    closed: false,
  };

  const closeSession = () => {
    if (session.closed) return;
    session.closed = true;
    socket.off("data", onData);
    socket.off("close", closeSession);
    socket.off("end", closeSession);
    socket.off("error", onError);
  };

  const onData = (chunk: string | Buffer) => {
    if (session.closed) return;
    session.buf = Buffer.concat([session.buf, toBuffer(chunk)]);
    void node.drainHttpSession(session, closeSession);
  };

  const onError = () => closeSession();

  socket.on("data", onData);
  socket.on("close", closeSession);
  socket.on("end", closeSession);
  socket.on("error", onError);

  void node.drainHttpSession(session, closeSession, firstHead);
}

export function pendingHttpSessionHeadEnd(
  _node: GnutellaServent,
  session: HttpSession,
): number {
  return findHeaderEnd(session.buf.toString("latin1"));
}

export function shiftHttpSessionHead(
  node: GnutellaServent,
  session: HttpSession,
): string | undefined {
  const cut = node.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  session.buf = session.buf.subarray(cut);
  return head;
}

function httpRequestContentLength(head: string): number {
  const raw = parseHttpHeaders(head)["content-length"];
  if (!raw) return 0;
  const length = Number(raw);
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("invalid http content-length");
  }
  if (length > MAX_HTTP_REQUEST_BODY_BYTES) {
    throw new Error("http request body too large");
  }
  return length;
}

export function shiftHttpSessionRequest(
  node: GnutellaServent,
  session: HttpSession,
): HttpSessionRequest | undefined {
  const cut = node.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  const contentLength = httpRequestContentLength(head);
  if (session.buf.length < cut + contentLength) return undefined;
  const body = Buffer.from(session.buf.subarray(cut, cut + contentLength));
  session.buf = session.buf.subarray(cut + contentLength);
  return { head, body };
}

export async function processHttpSessionRequests(
  node: GnutellaServent,
  session: HttpSession,
  closeSession: () => void,
  nextHead?: string,
): Promise<void> {
  let pendingHead = nextHead;
  let queued: HttpSessionRequest | undefined;
  while (!session.closed) {
    if (!queued && pendingHead) {
      const contentLength = httpRequestContentLength(pendingHead);
      if (session.buf.length < contentLength) return;
      queued = {
        head: pendingHead,
        body: Buffer.from(session.buf.subarray(0, contentLength)),
      };
      session.buf = session.buf.subarray(contentLength);
      pendingHead = undefined;
    }
    queued ||= node.shiftHttpSessionRequest(session);
    if (!queued) return;
    const keepAlive = await node.handleIncomingGet(
      session.socket,
      queued.head,
      queued.body,
    );
    queued = undefined;
    if (keepAlive) continue;
    closeSession();
    if (socketCanEnd(session.socket)) session.socket.end();
    return;
  }
}

export async function drainHttpSession(
  node: GnutellaServent,
  session: HttpSession,
  closeSession: () => void,
  nextHead?: string,
): Promise<void> {
  if (session.closed || session.busy) return;
  session.busy = true;
  try {
    await node.processHttpSessionRequests(session, closeSession, nextHead);
  } catch (error) {
    closeSession();
    session.socket.destroy(error instanceof Error ? error : undefined);
  } finally {
    session.busy = false;
  }
  if (session.closed) return;
  if (node.pendingHttpSessionHeadEnd(session) !== -1) {
    void node.drainHttpSession(session, closeSession);
  }
}

export function consumePeerBuffer(
  node: GnutellaServent,
  peer: Peer,
): void {
  while (peer.buf.length >= HEADER_LEN) {
    const hdr = parseHeader(peer.buf.subarray(0, HEADER_LEN));
    if (hdr.payloadLength > node.config().maxPayloadBytes) {
      throw new Error(`payload too large: ${hdr.payloadLength}`);
    }
    if (peer.buf.length < HEADER_LEN + hdr.payloadLength) return;
    const payload = peer.buf.subarray(
      HEADER_LEN,
      HEADER_LEN + hdr.payloadLength,
    );
    peer.buf = peer.buf.subarray(HEADER_LEN + hdr.payloadLength);
    if (!node.validateDescriptor(hdr.payloadType, payload)) {
      throw new Error(
        `invalid ${descriptorTypeName(hdr.payloadType)} payload`,
      );
    }
    if (hdr.payloadType !== TYPE.QUERY) {
      hdr.ttl = Math.min(hdr.ttl, node.config().maxTtl);
    }
    node.emitEvent({
      type: "PEER_MESSAGE_RECEIVED",
      at: ts(),
      peer: node.peerInfo(peer),
      payloadType: hdr.payloadType,
      payloadTypeName: descriptorTypeName(hdr.payloadType),
      descriptorIdHex: hdr.descriptorIdHex,
      ttl: hdr.ttl,
      hops: hdr.hops,
      payloadLength: payload.length,
    });
    node.handleDescriptor(peer, hdr, payload);
  }
}

export function validateDescriptor(
  _node: GnutellaServent,
  payloadType: number,
  payload: Buffer,
): boolean {
  switch (payloadType) {
    case TYPE.PING:
      return true;
    case TYPE.PONG:
      return payload.length >= 14;
    case TYPE.BYE:
      return payload.length >= 2;
    case TYPE.ROUTE_TABLE_UPDATE:
      return payload.length >= 1;
    case TYPE.PUSH:
      return payload.length >= 26;
    case TYPE.QUERY:
      return payload.length >= 3;
    case TYPE.QUERY_HIT:
      return payload.length >= 27;
    default:
      return true;
  }
}

export function sendRaw(
  _node: GnutellaServent,
  peer: Peer,
  frame: Buffer,
): void {
  if (peer.deflater) {
    peer.deflater.write(frame);
    peer.deflater.flush(zlib.constants.Z_SYNC_FLUSH);
    return;
  }
  peer.socket.write(frame);
}

export function sendToPeer(
  node: GnutellaServent,
  peer: Peer,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
): void {
  if (peer.closingAfterBye && payloadType !== TYPE.BYE) return;
  const frame = buildHeader(descriptorId, payloadType, ttl, hops, payload);
  node.sendRaw(peer, frame);
  node.emitEvent({
    type: "PEER_MESSAGE_SENT",
    at: ts(),
    peer: node.peerInfo(peer),
    payloadType,
    payloadTypeName: descriptorTypeName(payloadType),
    descriptorIdHex: descriptorId.toString("hex"),
    ttl,
    hops,
    payloadLength: payload.length,
  });
}

export function forwardToRoute(
  node: GnutellaServent,
  route: Route,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
): void {
  if (ttl <= 0) return;
  const peer = node.peers.get(route.peerKey);
  if (!peer) return;
  node.sendToPeer(
    peer,
    payloadType,
    descriptorId,
    Math.max(0, ttl - 1),
    hops + 1,
    payload,
  );
}

export function broadcast(
  node: GnutellaServent,
  payloadType: number,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  exceptPeerKey?: string,
): void {
  for (const peer of node.peers.values()) {
    if (exceptPeerKey && peer.key === exceptPeerKey) continue;
    node.sendToPeer(peer, payloadType, descriptorId, ttl, hops, payload);
  }
}

export function broadcastQuery(
  node: GnutellaServent,
  descriptorId: Buffer,
  ttl: number,
  hops: number,
  payload: Buffer,
  _search: string,
  exceptPeerKey?: string,
): void {
  routeQueryToPeers(
    node,
    descriptorId,
    ttl,
    hops,
    payload,
    parseQuery(payload),
    exceptPeerKey,
    true,
  );
}

export function normalizeQueryLifetime(
  node: GnutellaServent,
  ttl: number,
  hops: number,
): { ttl: number; hops: number } | null {
  if (ttl > 15) return null;
  const maxLife = Math.max(1, node.config().maxTtl);
  if (hops > maxLife) return null;
  return { ttl: Math.max(0, Math.min(ttl, maxLife - hops)), hops };
}

export function isIndexQuery(
  _node: GnutellaServent,
  hdr: Pick<DescriptorHeader, "ttl" | "hops">,
  q: QueryDescriptor,
): boolean {
  return hdr.ttl === 1 && hdr.hops === 0 && q.search === "    ";
}

export function shouldIgnoreQuery(
  node: GnutellaServent,
  hdr: Pick<DescriptorHeader, "ttl" | "hops">,
  q: QueryDescriptor,
): boolean {
  if (q.urns.length) return false;
  if (node.isIndexQuery(hdr, q)) return false;
  if (!q.search.trim()) return true;
  const words = splitSearchTerms(q.search);
  if (!words.length) return true;
  return words.every((word) => word.length <= 1);
}

export function enqueuePendingPush(
  node: GnutellaServent,
  pending: PendingPush,
): void {
  const queue = node.pendingPushes.get(pending.serventIdHex) || [];
  queue.push(pending);
  node.pendingPushes.set(pending.serventIdHex, queue);
}

export function shiftPendingPush(
  node: GnutellaServent,
  serventIdHex: string,
): PendingPush | undefined {
  const queue = node.pendingPushes.get(serventIdHex);
  if (!queue?.length) return undefined;
  const pending = queue.shift();
  if (queue.length) node.pendingPushes.set(serventIdHex, queue);
  else node.pendingPushes.delete(serventIdHex);
  return pending;
}

export function cachePongPayload(
  node: GnutellaServent,
  payload: Buffer,
): void {
  const digest = crypto.createHash("sha1").update(payload).digest("hex");
  node.pongCache.set(digest, {
    payload: Buffer.from(payload),
    at: node.now(),
  });
  if (node.pongCache.size <= 64) return;
  const oldest = [...node.pongCache.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, node.pongCache.size - 64);
  for (const [key] of oldest) node.pongCache.delete(key);
}

export function shouldIgnoreDescriptor(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): boolean {
  if (
    peer.closingAfterBye &&
    hdr.payloadType !== TYPE.QUERY_HIT &&
    hdr.payloadType !== TYPE.PUSH
  ) {
    return true;
  }
  if (hdr.payloadType === TYPE.ROUTE_TABLE_UPDATE) return false;
  return node.hasSeen(hdr.payloadType, hdr.descriptorIdHex, payload);
}

export function onPingDescriptor(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  node.pingRoutes.set(hdr.descriptorIdHex, {
    peerKey: peer.key,
    ts: node.now(),
  });
  node.respondPong(peer, hdr);
  if (!node.shouldRelayPings()) return;
  if (hdr.ttl <= 1 || node.now() - peer.lastPingAt < 1000) return;
  peer.lastPingAt = node.now();
  broadcastPingToPeers(
    node,
    hdr.descriptorId,
    hdr.ttl - 1,
    hdr.hops + 1,
    payload,
    peer.key,
  );
}

export function onQueryDescriptor(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const q = parseQuery(payload);
  const normalized = node.normalizeQueryLifetime(hdr.ttl, hdr.hops);
  node.emitEvent({
    type: "QUERY_RECEIVED",
    at: ts(),
    peer: node.peerInfo(peer),
    descriptorIdHex: hdr.descriptorIdHex,
    ttl: normalized?.ttl ?? hdr.ttl,
    hops: hdr.hops,
    search: q.search,
    urns: q.urns,
  });
  if (!normalized) return;
  hdr.ttl = normalized.ttl;
  hdr.hops = normalized.hops;
  if (node.shouldIgnoreQuery(hdr, q)) return;
  node.queryRoutes.set(hdr.descriptorIdHex, {
    peerKey: peer.key,
    ts: node.now(),
  });
  node.respondQueryHit(peer, hdr, q);
  if (!node.shouldRelayQueries()) return;
  routeQueryToPeers(
    node,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
    q,
    peer.key,
  );
}

export function dispatchDescriptor(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  switch (hdr.payloadType) {
    case TYPE.PING:
      node.onPingDescriptor(peer, hdr, payload);
      return;
    case TYPE.PONG:
      node.onPong(peer, hdr, payload);
      return;
    case TYPE.BYE:
      node.onBye(peer, payload);
      return;
    case TYPE.ROUTE_TABLE_UPDATE:
      node.onRouteTableUpdate(peer, payload);
      return;
    case TYPE.QUERY:
      node.onQueryDescriptor(peer, hdr, payload);
      return;
    case TYPE.QUERY_HIT:
      node.onQueryHit(peer, hdr, payload);
      return;
    case TYPE.PUSH:
      void node.onPush(peer, hdr, payload);
      return;
    default:
      return;
  }
}

export function handleDescriptor(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  if (node.shouldIgnoreDescriptor(peer, hdr, payload)) return;
  if (hdr.payloadType !== TYPE.ROUTE_TABLE_UPDATE) {
    node.markSeen(hdr.payloadType, hdr.descriptorIdHex, payload);
  }
  node.dispatchDescriptor(peer, hdr, payload);
}

export function onRouteTableUpdate(
  node: GnutellaServent,
  peer: Peer,
  payload: Buffer,
): void {
  const msg = parseRouteTableUpdate(payload);
  if (msg.variant === "reset") {
    peer.remoteQrp.resetSeen = true;
    peer.remoteQrp.tableSize = msg.tableLength;
    peer.remoteQrp.infinity = msg.infinity;
    peer.remoteQrp.entryBits = DEFAULT_QRP_ENTRY_BITS;
    peer.remoteQrp.table = null;
    peer.remoteQrp.seqSize = 0;
    peer.remoteQrp.parts.clear();
    return;
  }
  if (!peer.remoteQrp.resetSeen) return;
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

export function sendBye(
  node: GnutellaServent,
  peer: Peer,
  code: number,
  message: string,
): void {
  peer.closingAfterBye = true;
  node.sendToPeer(
    peer,
    TYPE.BYE,
    node.randomId16(),
    1,
    0,
    encodeBye(code, message),
  );
}

export function respondPong(
  node: GnutellaServent,
  peer: Peer,
  hdr: Pick<DescriptorHeader, "descriptorId" | "hops">,
): void {
  const ttl = Math.max(1, hdr.hops);
  const own = encodePong(
    node.currentAdvertisedPort(),
    node.currentAdvertisedHost(),
    node.shares.length,
    node.totalSharedKBytes(),
  );
  node.sendToPeer(peer, TYPE.PONG, hdr.descriptorId, ttl, 0, own);
  if (!node.config().enablePongCaching) return;
  let sent = 1;
  const cached = [...node.pongCache.values()].sort((a, b) => b.at - a.at);
  for (const entry of cached) {
    if (sent >= 10) break;
    node.sendToPeer(
      peer,
      TYPE.PONG,
      hdr.descriptorId,
      ttl,
      0,
      entry.payload,
    );
    sent++;
  }
}

export function respondQueryHit(
  node: GnutellaServent,
  peer: Peer,
  hdr: Pick<DescriptorHeader, "descriptorId" | "hops" | "ttl">,
  payloadOrQuery: Buffer | QueryDescriptor,
): void {
  const q = Buffer.isBuffer(payloadOrQuery)
    ? parseQuery(payloadOrQuery)
    : payloadOrQuery;
  const matches = node.isIndexQuery(hdr, q)
    ? node.shares
    : node.shares.filter((share) => shareMatchesQuery(q, share));
  if (!matches.length) return;
  const limit = Math.max(1, node.config().maxResultsPerQuery);
  const batchSize = 16;
  const chosen = matches.slice(0, limit);
  const replyTtl = Math.min(
    node.config().maxTtl,
    Math.max(1, hdr.hops + 2),
  );
  for (let off = 0; off < chosen.length; off += batchSize) {
    const batch = chosen.slice(off, off + batchSize);
    const out = encodeQueryHit(
      node.currentAdvertisedPort(),
      node.currentAdvertisedHost(),
      node.config().advertisedSpeedKBps,
      batch,
      node.serventId,
      {
        vendorCode: node.config().vendorCode,
        push: false,
        busy: false,
        haveUploaded: false,
        measuredSpeed: true,
        ggepHashes: q.ggepHAllowed && !!node.config().enableGgep,
        browseHost: !!node.config().enableGgep,
        privateGgepItems: queryHitRtcGgepItems(node, q, hdr.descriptorId),
      },
    );
    node.sendToPeer(
      peer,
      TYPE.QUERY_HIT,
      hdr.descriptorId,
      replyTtl,
      0,
      out,
    );
  }
}

export function onPong(
  node: GnutellaServent,
  _peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const pong = parsePong(payload);
  node.cachePongPayload(payload);
  node.addKnownPeer(pong.ip, pong.port);
  const route = node.pingRoutes.get(hdr.descriptorIdHex);
  if (!route) return;
  if (route === LOCAL_ROUTE) {
    node.emitEvent({
      type: "PONG",
      at: ts(),
      ip: pong.ip,
      port: pong.port,
      files: pong.files,
      kbytes: pong.kbytes,
    });
    return;
  }
  node.forwardToRoute(
    route,
    TYPE.PONG,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

export function onQueryHit(
  node: GnutellaServent,
  peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): void {
  const qh = parseQueryHit(payload);
  node.pushRoutes.set(qh.serventIdHex, {
    peerKey: peer.key,
    ts: node.now(),
  });
  const route = node.queryRoutes.get(hdr.descriptorIdHex);
  if (!route) return;
  if (route === LOCAL_ROUTE) {
    for (const result of qh.results) {
      const hit: SearchHit = {
        resultNo: node.resultSeq++,
        queryIdHex: hdr.descriptorIdHex,
        queryHops: hdr.hops,
        remoteHost: qh.ip,
        remotePort: qh.port,
        speedKBps: qh.speedKBps,
        fileIndex: result.fileIndex,
        fileName: result.fileName,
        fileSize: result.fileSize,
        serventIdHex: qh.serventIdHex,
        viaPeerKey: peer.key,
        sha1Urn: firstSha1Urn(result.urns),
        urns: result.urns,
        metadata: result.metadata,
        vendorCode: qh.vendorCode,
        needsPush: qh.flagPush,
        busy: qh.flagBusy,
      };
      applyRtcCapabilityToHit(qh, hit);
      node.lastResults.push(hit);
      node.emitEvent({ type: "QUERY_RESULT", at: ts(), hit });
    }
    return;
  }
  if (node.nodeMode() === "leaf") return;
  node.forwardToRoute(
    route,
    TYPE.QUERY_HIT,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

export async function onPush(
  node: GnutellaServent,
  _peer: Peer,
  hdr: RoutedDescriptor,
  payload: Buffer,
): Promise<void> {
  const push = parsePush(payload);
  if (push.serventIdHex === node.serventId.toString("hex")) {
    await node.fulfillPush(push);
    return;
  }
  if (node.nodeMode() === "leaf") return;
  const route = node.pushRoutes.get(push.serventIdHex);
  if (!route) return;
  node.forwardToRoute(
    route,
    TYPE.PUSH,
    hdr.descriptorId,
    hdr.ttl,
    hdr.hops,
    payload,
  );
}

export function onBye(
  _node: GnutellaServent,
  peer: Peer,
  payload: Buffer,
): void {
  try {
    parseBye(payload);
  } catch {
    // ignore parse failure and close anyway
  }
  peer.socket.end();
}

export async function fulfillPush(
  node: GnutellaServent,
  push: ReturnType<typeof parsePush>,
): Promise<void> {
  const share = node.sharesByIndex.get(push.fileIndex);
  if (!share) return;
  node.emitEvent({
    type: "PUSH_REQUESTED",
    at: ts(),
    fileIndex: share.index,
    fileName: share.name,
    ip: push.ip,
    port: push.port,
  });
  const socket = node.createConnection({ host: push.ip, port: push.port });
  socket.setNoDelay(true);
  socket.setTimeout(node.config().downloadTimeoutMs, () =>
    socket.destroy(new Error("push connect timeout")),
  );
  socket.on("error", (error) =>
    node.emitEvent({
      type: "PUSH_CALLBACK_FAILED",
      at: ts(),
      message: errMsg(error),
    }),
  );
  socket.on("connect", () => {
    socket.write(
      `GIV ${share.index}:${node.serventId.toString("hex")}/${share.name}\n\n`,
    );
  });

  let buf = Buffer.alloc(0);
  const onData = (chunk: string | Buffer) => {
    buf = Buffer.concat([buf, toBuffer(chunk)]);
    const raw = buf.toString("latin1");
    const cut = findHeaderEnd(raw);
    if (cut === -1) return;
    const head = raw.slice(0, cut);
    const rest = buf.subarray(cut);
    socket.off("data", onData);
    node.startHttpSession(socket, head, rest);
  };
  socket.on("data", onData);
}
