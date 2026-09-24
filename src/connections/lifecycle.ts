import { BYE_DEFAULT_CODE } from "../const";
import { normalizePeer } from "../shared";
import type { PeerConnections } from "./connections";
import type { PeerConnection as Peer } from "./types";

function sendShutdownByes(connections: PeerConnections): void {
  if (!connections.config().enableBye) return;
  for (const peer of connections.peers.values()) {
    try {
      if (peer.capabilities.supportsBye)
        connections.deps.routing.bye(
          peer,
          BYE_DEFAULT_CODE,
          "normal shutdown",
        );
    } catch {}
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

async function waitForByeAcks(
  connections: PeerConnections,
): Promise<void> {
  if (!connections.config().enableBye) return;
  const closingPeers = [...connections.peers.values()].filter(
    (peer) => peer.closingAfterBye,
  );
  if (!closingPeers.length) return;
  await Promise.race([
    Promise.allSettled(closingPeers.map((peer) => waitForPeerClose(peer))),
    connections.sleep(2000),
  ]);
}

async function closeServer(connections: PeerConnections): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!connections.server) return resolve();
    connections.server.close(() => resolve());
  });
}

/** Listen for incoming protocol and transfer connections. */
export async function startServer(
  connections: PeerConnections,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = connections.createServer((socket) =>
      connections.handleProbe(socket),
    );
    server.on("error", reject);
    server.listen(
      connections.config().listenPort,
      connections.config().listenHost,
      () => {
        connections.server = server;
        resolve();
      },
    );
  });
}

/** Dial an unblocked peer unless already connected or dialing. */
export async function connectPeer(
  connections: PeerConnections,
  host: string,
  port: number,
  timeoutMs?: number,
): Promise<void> {
  const connectTimeoutMs =
    timeoutMs ?? connections.config().connectTimeoutMs;
  const target = normalizePeer(host, port);
  if (connections.isBlockedHost(host))
    throw new Error(`peer ${target} is blocked`);
  if (connections.dialing.has(target)) return;
  for (const peer of connections.peers.values()) {
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
  connections.dialing.add(target);
  try {
    await connections.connectPeer06(host, port, connectTimeoutMs);
    connections.deps.discovery.addKnownPeer(host, port);
  } finally {
    connections.dialing.delete(target);
  }
}
/** Send shutdown notices and close peer sockets and listener. */
export async function closeConnections(
  connections: PeerConnections,
): Promise<void> {
  sendShutdownByes(connections);
  await waitForByeAcks(connections);
  for (const peer of connections.peers.values()) peer.socket.destroy();
  connections.peers.clear();
  connections.closeSockets();
  await closeServer(connections);
}
