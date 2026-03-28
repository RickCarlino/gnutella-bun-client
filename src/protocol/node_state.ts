import fsp from "node:fs/promises";
import path from "node:path";

import {
  GWEBCACHE_REPORT_DELAY_SEC,
  LOCAL_ROUTE,
  MAX_PEER_AGE_SEC,
} from "../const";
import {
  ensureDir,
  errMsg,
  fileExists,
  isRoutableIpv4,
  isUnspecifiedIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
  safeFileName,
  ts,
  unique,
  walkFiles,
} from "../shared";
import { reportSelfToGWebCaches } from "../gwebcache_client";
import type {
  ConnectPeerResult,
  DownloadRecord,
  GnutellaEvent,
  GnutellaEventListener,
  NodeStatus,
  PeerInfo,
  PeerState,
  Route,
  RuntimeConfig,
  SearchHit,
  ShareFile,
} from "../types";
import { observedAdvertisedHostCandidate } from "./handshake";
import {
  appendPathSuffix,
  detectLocalAdvertisedIpv4,
  peerStateEquals,
  peerStateTargets,
  rememberPeerInState,
  runtimeConfigFor,
  sortPeerStateEntries,
  trimPeerState,
  writeDoc,
} from "./peer_state";
import { sha1File, sha1ToUrn, tokenizeKeywords } from "./qrp";
import { seenKey } from "./core_utils";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";

export type MaintenanceOperation =
  | "SHARE_RESCAN"
  | "RECONNECT"
  | "SAVE"
  | "GWEBCACHE_UPDATE";

export function subscribe(
  node: GnutellaServent,
  listener: GnutellaEventListener,
): () => void {
  node.listeners.add(listener);
  return () => node.listeners.delete(listener);
}

export function emitEvent(
  node: GnutellaServent,
  event: GnutellaEvent,
): void {
  for (const listener of node.listeners) listener(event);
}

export function emitMaintenanceError(
  node: GnutellaServent,
  operation: MaintenanceOperation,
  e: unknown,
): void {
  emitEvent(node, {
    type: "MAINTENANCE_ERROR",
    at: ts(),
    operation,
    message: errMsg(e),
  });
}

export function schedule(
  node: GnutellaServent,
  ms: number,
  fn: () => void,
): void {
  node.timers.push(setInterval(fn, ms));
}

export function scheduleOnce(
  node: GnutellaServent,
  ms: number,
  fn: () => void,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    node.timeouts = node.timeouts.filter(
      (candidate) => candidate !== timer,
    );
    fn();
  }, ms);
  node.timeouts.push(timer);
  return timer;
}

export function cancelTimeout(
  node: GnutellaServent,
  timer: NodeJS.Timeout | undefined,
): void {
  if (!timer) return;
  clearTimeout(timer);
  node.timeouts = node.timeouts.filter((candidate) => candidate !== timer);
}

export function peerInfo(node: GnutellaServent, peer: Peer): PeerInfo {
  const info: PeerInfo = {
    key: peer.key,
    remoteLabel: peer.remoteLabel,
    outbound: peer.outbound,
    dialTarget: peer.dialTarget,
    compression:
      !!peer.capabilities.compressIn || !!peer.capabilities.compressOut,
    tls: node.socketUsesTls(peer.socket),
  };
  if (peer.capabilities.userAgent)
    info.userAgent = peer.capabilities.userAgent;
  return info;
}

export function peerCount(node: GnutellaServent): number {
  return node.peers.size;
}

export function config(node: GnutellaServent): RuntimeConfig {
  return runtimeConfigFor(node.configPath, node.doc);
}

export function configuredAdvertisedHost(
  node: GnutellaServent,
): string | undefined {
  const raw = node.config().advertisedHost;
  if (typeof raw !== "string") return undefined;
  const host = raw.trim();
  return host || undefined;
}

export function currentAdvertisedPort(node: GnutellaServent): number {
  const configured = node.config().advertisedPort;
  return Number.isInteger(configured) && (configured || 0) > 0
    ? (configured as number)
    : node.config().listenPort;
}

export function currentAdvertisedHost(node: GnutellaServent): string {
  return (
    node.configuredAdvertisedHost() ||
    node.learnedAdvertisedHost ||
    detectLocalAdvertisedIpv4(node.config().listenHost)
  );
}

export function selfHosts(node: GnutellaServent): Set<string> {
  const out = new Set<string>();
  const push = (host: string | undefined) => {
    const normalized = normalizeIpv4(host);
    if (normalized && !isUnspecifiedIpv4(normalized)) out.add(normalized);
  };
  push(node.configuredAdvertisedHost());
  push(node.learnedAdvertisedHost);
  push(node.config().listenHost);
  push(detectLocalAdvertisedIpv4(node.config().listenHost));
  return out;
}

export function isSelfPeer(
  node: GnutellaServent,
  host: string,
  port: number,
): boolean {
  const normalizedHost = normalizeIpv4(host);
  if (!normalizedHost || !port) return false;
  const ports = new Set([
    node.config().listenPort,
    node.currentAdvertisedPort(),
  ]);
  return ports.has(port) && node.selfHosts().has(normalizedHost);
}

export function maybeObserveAdvertisedHost(
  node: GnutellaServent,
  headers: Record<string, string>,
  reporterHost?: string,
): void {
  if (node.configuredAdvertisedHost()) return;
  const observed = observedAdvertisedHostCandidate(headers, reporterHost);
  if (!observed) return;
  const { observedHost, subnet } = observed;
  if (observedHost === node.learnedAdvertisedHost) return;
  node.trackPendingAdvertisedHost(observedHost, subnet);
}

export function trackPendingAdvertisedHost(
  node: GnutellaServent,
  observedHost: string,
  subnet: string,
): void {
  if (node.pendingAdvertisedHost !== observedHost) {
    node.pendingAdvertisedHost = observedHost;
    node.pendingAdvertisedSubnets.clear();
  }
  node.pendingAdvertisedSubnets.add(subnet);
  if (node.pendingAdvertisedSubnets.size < 3) return;

  node.learnedAdvertisedHost = observedHost;
  node.pendingAdvertisedHost = undefined;
  node.pendingAdvertisedSubnets.clear();
}

export function absorbHandshakeHeaders(
  node: GnutellaServent,
  headers: Record<string, string>,
  reporterHost?: string,
): void {
  node.maybeAbsorbTryHeaders(headers);
  node.maybeObserveAdvertisedHost(headers, reporterHost);
}

export async function save(node: GnutellaServent): Promise<void> {
  const c = node.config();
  for (const peer of node.peers.values()) node.markPeerSeenIfStable(peer);
  node.pruneExpiredKnownPeers();
  node.doc.state.peers = trimPeerState(node.doc.state.peers);
  node.doc.state.serventIdHex = node.serventId.toString("hex");
  await ensureDir(path.dirname(node.configPath));
  await ensureDir(c.downloadsDir);
  await writeDoc(node.configPath, node.doc);
}

export async function refreshShares(node: GnutellaServent): Promise<void> {
  const downloadsDir = node.config().downloadsDir;
  const files = await walkFiles(downloadsDir);
  const shares: ShareFile[] = [];
  let idx = 1;
  for (const abs of files) {
    const st = await fsp.stat(abs);
    const rel = path.relative(downloadsDir, abs).replace(/\\/g, "/");
    const sha1 = await sha1File(abs);
    const sha1Urn = sha1ToUrn(sha1);
    const keywords = unique([
      ...tokenizeKeywords(path.basename(abs)),
      ...tokenizeKeywords(rel),
      ...tokenizeKeywords(path.parse(abs).name),
    ]);
    shares.push({
      index: idx++,
      name: path.basename(abs),
      rel,
      abs,
      size: st.size,
      sha1,
      sha1Urn,
      keywords,
    });
  }
  node.shares = shares;
  node.sharesByIndex = new Map(shares.map((x) => [x.index, x]));
  node.sharesByUrn = new Map(
    shares.map((x) => [x.sha1Urn.toLowerCase(), x]),
  );
  node.qrpTable.rebuildFromShares(shares);
  node.emitEvent({
    type: "SHARES_REFRESHED",
    at: ts(),
    count: node.shares.length,
    totalKBytes: node.totalSharedKBytes(),
  });
  if (node.config().enableQrp) {
    for (const peer of node.peers.values()) {
      void node.sendQrpTable(peer).catch(() => void 0);
    }
  }
}

export function totalSharedKBytes(node: GnutellaServent): number {
  return Math.ceil(node.shares.reduce((a, x) => a + x.size, 0) / 1024);
}

function rememberKnownPeer(
  node: GnutellaServent,
  host: string,
  port: number,
  timestamp: number,
): void {
  if (!host || !port || node.isSelfPeer(host, port)) return;
  node.doc.state.peers = rememberPeerInState(
    node.doc.state.peers,
    normalizePeer(host, port),
    timestamp,
  );
}

export function addKnownPeer(
  node: GnutellaServent,
  host: string,
  port: number,
): void {
  rememberKnownPeer(node, host, port, 0);
}

export function updateKnownPeerLastSeen(
  node: GnutellaServent,
  host: string,
  port: number,
  timestamp?: number,
): void {
  rememberKnownPeer(
    node,
    host,
    port,
    timestamp ?? node.peerSeenTimestamp(),
  );
}

export function peerSeenTimestamp(
  _node: GnutellaServent,
  nowMs = Date.now(),
): number {
  return Math.max(0, Math.floor(nowMs / 1000));
}

export function pruneExpiredKnownPeers(
  node: GnutellaServent,
  nowSec?: number,
): boolean {
  const timestamp = nowSec ?? node.peerSeenTimestamp();
  const current = trimPeerState(node.doc.state.peers);
  const filtered = Object.fromEntries(
    sortPeerStateEntries(current).filter(
      ([, lastSeen]) =>
        lastSeen === 0 || timestamp - lastSeen <= MAX_PEER_AGE_SEC,
    ),
  ) as PeerState;
  if (peerStateEquals(current, filtered)) return false;
  node.doc.state.peers = filtered;
  node.gwebCacheBootstrapState.lastExhaustedPeerSet = undefined;
  return true;
}

export function shouldBootstrapFreshPeers(node: GnutellaServent): boolean {
  const peers = trimPeerState(node.doc.state.peers);
  const timestamps = Object.values(peers);
  return timestamps.length > 0 && timestamps.every((value) => value === 0);
}

export function rememberPeerAddresses(
  node: GnutellaServent,
  peer: Peer,
  timestamp = 0,
): void {
  const remembered = new Set<string>();
  const push = (host: string, port: number) => {
    const target = normalizePeer(host, port);
    if (remembered.has(target)) return;
    remembered.add(target);
    if (timestamp > 0) node.updateKnownPeerLastSeen(host, port, timestamp);
    else node.addKnownPeer(host, port);
  };

  if (peer.dialTarget) {
    const addr = parsePeer(peer.dialTarget);
    if (addr) push(addr.host, addr.port);
  }
  if (peer.capabilities.listenIp) {
    push(peer.capabilities.listenIp.host, peer.capabilities.listenIp.port);
  }
}

export function markPeerSeenIfStable(
  node: GnutellaServent,
  peer: Peer,
  nowMs = Date.now(),
): void {
  if (nowMs - peer.connectedAt < node.config().peerSeenThresholdSec * 1000)
    return;
  node.rememberPeerAddresses(peer, node.peerSeenTimestamp(nowMs));
}

export function scheduleGWebCacheReport(node: GnutellaServent): void {
  if (
    node.gwebCacheReportAttempted ||
    node.gwebCacheReported ||
    node.gwebCacheReportTimer ||
    node.peerCount() === 0
  )
    return;

  node.gwebCacheReportTimer = node.scheduleOnce(
    GWEBCACHE_REPORT_DELAY_SEC * 1000,
    () => {
      node.gwebCacheReportTimer = undefined;
      if (node.stopped || node.gwebCacheReported || node.peerCount() === 0)
        return;
      node.gwebCacheReportAttempted = true;
      void node
        .announceSelfToGWebCaches()
        .catch((e) => node.emitMaintenanceError("GWEBCACHE_UPDATE", e));
    },
  );
}

export function refreshGWebCacheReport(node: GnutellaServent): void {
  if (node.peerCount() > 0) {
    node.scheduleGWebCacheReport();
    return;
  }
  node.cancelTimeout(node.gwebCacheReportTimer);
  node.gwebCacheReportTimer = undefined;
}

export async function announceSelfToGWebCaches(
  node: GnutellaServent,
): Promise<void> {
  const host = normalizeIpv4(node.currentAdvertisedHost());
  const port = node.currentAdvertisedPort();
  if (!host || !isRoutableIpv4(host) || !port) return;

  const result = await reportSelfToGWebCaches({
    client: node.config().vendorCode,
    version: node.config().userAgent,
    ip: normalizePeer(host, port),
    state: node.gwebCacheBootstrapState,
  });
  if (result.reportedCaches.length > 0) node.gwebCacheReported = true;
}

export function peerDialState(
  node: GnutellaServent,
  host: string,
  port: number,
): "connected" | "dialing" | "none" {
  const target = normalizePeer(host, port);
  if (node.dialing.has(target)) return "dialing";
  for (const peer of node.peers.values()) {
    if (peer.dialTarget === target) return "connected";
    if (
      peer.capabilities.listenIp &&
      normalizePeer(
        peer.capabilities.listenIp.host,
        peer.capabilities.listenIp.port,
      ) === target
    )
      return "connected";
  }
  return "none";
}

export async function connectToPeer(
  node: GnutellaServent,
  peerSpec: string,
): Promise<ConnectPeerResult> {
  const addr = parsePeer(peerSpec);
  if (!addr) throw new Error("expected host:port");
  const peer = normalizePeer(addr.host, addr.port);
  if (node.isSelfPeer(addr.host, addr.port))
    throw new Error("cannot add self as peer");

  node.addKnownPeer(addr.host, addr.port);

  const state = node.peerDialState(addr.host, addr.port);
  if (state === "connected") return { peer, status: "already-connected" };
  if (state === "dialing") return { peer, status: "dialing" };

  try {
    await node.connectPeer(addr.host, addr.port);
    return { peer, status: "connected" };
  } catch (e) {
    return { peer, status: "saved", message: errMsg(e) };
  }
}

export function markSeen(
  node: GnutellaServent,
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): void {
  node.seen.set(
    seenKey(payloadType, descriptorIdHex, payload),
    Date.now(),
  );
}

export function hasSeen(
  node: GnutellaServent,
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): boolean {
  return node.seen.has(seenKey(payloadType, descriptorIdHex, payload));
}

export function pruneSeenEntries(
  node: GnutellaServent,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, at] of node.seen) {
    if (now - at > maxAgeMs) node.seen.delete(key);
  }
}

export function pruneRouteEntries(
  _node: GnutellaServent,
  routes: Map<string, Route | typeof LOCAL_ROUTE>,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, route] of routes) {
    if (route !== LOCAL_ROUTE && now - route.ts > maxAgeMs)
      routes.delete(key);
  }
}

export function prunePushRoutes(
  node: GnutellaServent,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, route] of node.pushRoutes) {
    if (now - route.ts > maxAgeMs) node.pushRoutes.delete(key);
  }
}

export function prunePendingPushQueues(
  node: GnutellaServent,
  now: number,
  waitMs: number,
): void {
  for (const [key, queue] of node.pendingPushes) {
    const keep = queue.filter((pending) => {
      if (now - pending.createdAt <= waitMs) return true;
      pending.reject(new Error("push timed out"));
      return false;
    });
    if (keep.length) node.pendingPushes.set(key, keep);
    else node.pendingPushes.delete(key);
  }
}

export function prunePongCache(
  node: GnutellaServent,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, entry] of node.pongCache) {
    if (now - entry.at > maxAgeMs) node.pongCache.delete(key);
  }
}

export function pruneMaps(node: GnutellaServent): void {
  const now = Date.now();
  const seenAge = node.config().seenTtlSec * 1000;
  const routeAge = node.config().routeTtlSec * 1000;
  node.pruneSeenEntries(now, seenAge);
  node.pruneRouteEntries(node.pingRoutes, now, routeAge);
  node.pruneRouteEntries(node.queryRoutes, now, routeAge);
  node.prunePushRoutes(now, routeAge);
  node.prunePendingPushQueues(now, node.config().pushWaitMs);
  node.prunePongCache(now, routeAge);
  if (node.lastResults.length > 1000)
    node.lastResults = node.lastResults.slice(-1000);
}

export function getPeers(node: GnutellaServent): PeerInfo[] {
  return [...node.peers.values()].map((peer) => node.peerInfo(peer));
}

export function getShares(node: GnutellaServent): ShareFile[] {
  return [...node.shares];
}

export function getResults(node: GnutellaServent): SearchHit[] {
  return [...node.lastResults];
}

export function clearResults(node: GnutellaServent): void {
  node.lastResults = [];
  node.resultSeq = 1;
}

export function getKnownPeers(node: GnutellaServent): string[] {
  return peerStateTargets(node.doc.state.peers);
}

export function getDownloads(node: GnutellaServent): DownloadRecord[] {
  return [...node.downloads];
}

export function getServentIdHex(node: GnutellaServent): string {
  return node.serventId.toString("hex");
}

export function getStatus(node: GnutellaServent): NodeStatus {
  return {
    peers: node.peers.size,
    shares: node.shares.length,
    results: node.lastResults.length,
    knownPeers: node.getKnownPeers().length,
  };
}

export function reserveAutoDownloadPath(
  node: GnutellaServent,
  fileName: string,
): Promise<string> {
  const basePath = path.resolve(
    path.join(node.config().downloadsDir, safeFileName(fileName)),
  );
  let suffixNo = 1;
  return (async () => {
    for (;;) {
      const candidate =
        suffixNo === 1 ? basePath : appendPathSuffix(basePath, suffixNo);
      if (node.activeAutoDownloadPaths.has(candidate)) {
        suffixNo++;
        continue;
      }
      if (await fileExists(candidate)) {
        suffixNo++;
        continue;
      }
      node.activeAutoDownloadPaths.add(candidate);
      return candidate;
    }
  })();
}
