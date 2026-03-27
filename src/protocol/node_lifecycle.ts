import net from "node:net";

import {
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  BYE_DEFAULT_CODE,
} from "../const";
import { connectBootstrapPeers } from "../gwebcache_client";
import { normalizePeer, parsePeer, sleep, ts } from "../shared";
import type { GnutellaServent } from "./node";
import type { Peer } from "./node_types";
import type { MaintenanceOperation } from "./node_state";

function scheduleRecurringTask(
  node: GnutellaServent,
  ms: number,
  task: () => Promise<void>,
  operation: MaintenanceOperation,
): void {
  node.schedule(
    ms,
    () =>
      void task().catch((e) => node.emitMaintenanceError(operation, e)),
  );
}

export async function start(node: GnutellaServent): Promise<void> {
  const c = node.config();
  await node.refreshShares();
  await node.startServer();
  scheduleRecurringTask(
    node,
    c.rescanSharesSec * 1000,
    () => node.refreshShares(),
    "SHARE_RESCAN",
  );
  node.schedule(5000, () => node.pruneMaps());
  scheduleRecurringTask(
    node,
    c.reconnectIntervalSec * 1000,
    () => node.connectKnownPeers(),
    "RECONNECT",
  );
  node.schedule(c.pingIntervalSec * 1000, () =>
    node.sendPing(c.defaultPingTtl),
  );
  scheduleRecurringTask(node, 15000, () => node.save(), "SAVE");
  node.emitEvent({
    type: "STARTED",
    at: ts(),
    listenHost: c.listenHost,
    listenPort: c.listenPort,
    advertisedHost: node.currentAdvertisedHost(),
    advertisedPort: node.currentAdvertisedPort(),
  });
  node.emitEvent({
    type: "IDENTITY",
    at: ts(),
    serventIdHex: node.serventId.toString("hex"),
  });
  void node
    .connectKnownPeers()
    .catch((e) => node.emitMaintenanceError("RECONNECT", e));
}

function clearTimers(node: GnutellaServent): void {
  for (const t of node.timers) clearInterval(t);
  for (const t of node.timeouts) clearTimeout(t);
  node.gwebCacheReportTimer = undefined;
}

function sendShutdownByes(node: GnutellaServent): void {
  if (!node.config().enableBye) return;
  for (const peer of node.peers.values()) {
    try {
      if (peer.capabilities.supportsBye)
        node.sendBye(peer, BYE_DEFAULT_CODE, "normal shutdown");
    } catch {
      // ignore
    }
  }
}

function waitForPeerClose(peer: Peer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (peer.socket.destroyed) return resolve();
    const done = () => {
      peer.socket.off("close", done);
      peer.socket.off("end", done);
      resolve();
    };
    peer.socket.once("close", done);
    peer.socket.once("end", done);
  });
}

async function waitForByeAcks(node: GnutellaServent): Promise<void> {
  if (!node.config().enableBye) return;
  const closingPeers = [...node.peers.values()].filter(
    (peer) => peer.closingAfterBye,
  );
  if (!closingPeers.length) return;
  await Promise.race([
    Promise.allSettled(closingPeers.map((peer) => waitForPeerClose(peer))),
    sleep(2000),
  ]);
}

async function closeServer(node: GnutellaServent): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!node.server) return resolve();
    node.server.close(() => resolve());
  });
}

export async function stop(node: GnutellaServent): Promise<void> {
  if (node.stopped) return;
  node.stopped = true;
  clearTimers(node);
  sendShutdownByes(node);
  await waitForByeAcks(node);
  for (const peer of node.peers.values()) peer.socket.destroy();
  node.peers.clear();
  await closeServer(node);
  await node.save();
}

export async function startServer(node: GnutellaServent): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer((socket) => node.handleProbe(socket));
    server.on("error", reject);
    server.listen(
      node.config().listenPort,
      node.config().listenHost,
      () => {
        node.server = server;
        resolve();
      },
    );
  });
}

export async function connectKnownPeers(
  node: GnutellaServent,
): Promise<void> {
  node.pruneExpiredKnownPeers();
  const bootstrapFreshPeers = node.shouldBootstrapFreshPeers();
  if (bootstrapFreshPeers) {
    node.gwebCacheBootstrapState.lastExhaustedPeerSet = undefined;
  }
  const c = node.config();
  const peers = bootstrapFreshPeers ? [] : c.peers;
  const bootstrapTimeoutMs = Math.max(
    1,
    Math.floor(c.connectTimeoutMs / BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR),
  );
  await connectBootstrapPeers({
    peers,
    client: c.vendorCode,
    version: c.userAgent,
    connectTimeoutMs: bootstrapTimeoutMs,
    connectConcurrency: BOOTSTRAP_CONNECT_CONCURRENCY,
    connectedCount: () => node.peerCount(),
    availableSlots: () =>
      Math.max(0, c.maxConnections - node.peerCount() - node.dialing.size),
    connectPeer: (host, port, timeoutMs) =>
      node.connectPeer(host, port, timeoutMs),
    addPeer: (peer) => {
      const addr = parsePeer(peer);
      if (!addr) return;
      node.addKnownPeer(addr.host, addr.port);
    },
    isSelfPeer: (host, port) => node.isSelfPeer(host, port),
    state: node.gwebCacheBootstrapState,
  });
}

export async function connectPeer(
  node: GnutellaServent,
  host: string,
  port: number,
  timeoutMs?: number,
): Promise<void> {
  const connectTimeoutMs = timeoutMs ?? node.config().connectTimeoutMs;
  const target = normalizePeer(host, port);
  if (node.dialing.has(target)) return;
  for (const peer of node.peers.values()) {
    if (peer.dialTarget === target) return;
    if (
      peer.capabilities.listenIp &&
      normalizePeer(
        peer.capabilities.listenIp.host,
        peer.capabilities.listenIp.port,
      ) === target
    )
      return;
  }
  node.dialing.add(target);
  try {
    await node.connectPeer06(host, port, connectTimeoutMs);
    node.addKnownPeer(host, port);
  } finally {
    node.dialing.delete(target);
  }
}
