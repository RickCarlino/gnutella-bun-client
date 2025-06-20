import net from "net";
import { startConnection } from "./gnutella-connection";
import {
  createHandshakeConnect,
  createHandshakeOk,
  GnutellaObject,
} from "./parser";
import { getCache } from "./cache-client";
import { handlePing, extractPeersFromHandshakeError } from "./utils/message-handlers";
import type { ConnectionInfo, Sender } from "./types";

interface ConnectionManagerConfig {
  targetConnections: number;
  checkInterval: number; // milliseconds
  handshakeTimeout: number; // milliseconds
  localIp: string;
  localPort: number;
  headers: Record<string, string>;
  onConnectionsChanged?: (activeConnections: number) => void;
}

const cache = await getCache();

export function createConnectionManager(config: ConnectionManagerConfig) {
  const connections = new Map<string, ConnectionInfo>();
  let intervalId: Timer | null = null;
  let isRunning = false;

  async function connectToPeer(address: string): Promise<void> {
    if (connections.has(address)) {
      return; // Already connected or connecting
    }

    const [ip, portStr] = address.split(":");
    const port = parseInt(portStr, 10);

    if (isNaN(port)) {
      console.error(`Invalid port in address: ${address}`);
      return;
    }

    console.log(`[ConnectionManager] Attempting to connect to ${address}`);

    // Mark as connecting to prevent duplicate attempts
    connections.set(address, {
      socket: null as any, // Temporary placeholder
      handshake: false,
      connectTime: Date.now(),
    });

    try {
      const socket = await startConnection({
        ip,
        port,
        onMessage: (send, msg) => handleMessage(address, send, msg),
        onError: async (_, error) => {
          console.error(
            `[ConnectionManager] Error with ${address}:`,
            error.message
          );
          await removeConnection(address);
        },
        onClose: async () => {
          console.log(`[ConnectionManager] Connection closed: ${address}`);
          await removeConnection(address);
        },
      });

      // Update connection info with actual socket
      const conn = connections.get(address);
      if (conn) {
        conn.socket = socket;
      }

      // Send handshake
      socket.write(createHandshakeConnect(config.headers));

      // Set timeout for handshake
      setTimeout(() => {
        const conn = connections.get(address);
        if (conn && !conn.handshake) {
          console.log(`[ConnectionManager] Handshake timeout for ${address}`);
          conn?.socket?.destroy?.();
          removeConnection(address).catch((err) =>
            console.error(
              `[ConnectionManager] Error removing connection: ${err}`
            )
          );
        }
      }, config.handshakeTimeout);
    } catch (error) {
      console.error(
        `[ConnectionManager] Failed to connect to ${address}:`,
        error
      );
      removeConnection(address);
      // Delete failed peer from cache
      const [ip, portStr] = address.split(":");
      const port = parseInt(portStr, 10);
      if (!isNaN(port)) {
        cache.removePeer(ip, port);
        await cache.store();
        console.log(
          `[ConnectionManager] Removed failed peer ${address} from cache`
        );
      }
    }
  }

  function handleMessage(
    address: string,
    send: (buffer: Buffer) => void,
    msg: GnutellaObject
  ): void {
    const conn = connections.get(address);
    if (!conn) return;

    switch (msg.type) {
      case "handshake_connect":
        // Shouldn't receive this as a client, but respond anyway
        send(createHandshakeOk(config.headers));
        break;

      case "handshake_ok":
        console.log(
          `[ConnectionManager] Handshake OK from ${address} v${msg.version}`
        );
        conn.handshake = true;
        conn.version = msg.version;
        config.onConnectionsChanged?.(getActiveConnectionCount());
        break;

      case "handshake_error":
        console.log(
          `[ConnectionManager] Handshake error from ${address}: ${msg.code} ${msg.message}`
        );

        extractPeersFromHandshakeError(msg, (ip, port) => cache.addPeer(ip, port));

        conn?.socket?.destroy?.();
        removeConnection(address).catch((err) =>
          console.error(`[ConnectionManager] Error removing connection: ${err}`)
        );
        break;

      case "ping":
        handlePing(msg, {
          localPort: config.localPort,
          localIp: config.localIp,
          send,
        }, conn.handshake);
        break;

      case "pong":
        console.log(
          `[ConnectionManager] Pong from ${address}: ${msg.ipAddress}:${msg.port}`
        );
        // Add discovered peer to cache
        cache.addPeer(msg.ipAddress, msg.port);
        cache.store();
        break;

      case "query":
        console.log(
          `[ConnectionManager] Query from ${address}: "${msg.searchCriteria}"`
        );
        break;

      case "queryhits":
        console.log(
          `[ConnectionManager] QueryHits from ${address}: ${msg.numberOfHits} results`
        );
        break;

      case "push":
        console.log(`[ConnectionManager] Push request from ${address}`);
        break;

      case "bye":
        console.log(
          `[ConnectionManager] Bye from ${address}: ${msg.code} ${msg.message}`
        );
        conn?.socket?.destroy?.();
        removeConnection(address).catch((err) =>
          console.error(`[ConnectionManager] Error removing connection: ${err}`)
        );
        break;
    }
  }

  async function removeConnection(address: string): Promise<void> {
    connections.delete(address);
    config.onConnectionsChanged?.(getActiveConnectionCount());

    // Delete the peer from cache when connection is removed due to error
    const [ip, portStr] = address.split(":");
    const port = parseInt(portStr, 10);
    if (!isNaN(port)) {
      cache.removePeer(ip, port);
      await cache.store();
      console.log(`[ConnectionManager] Removed peer ${address} from cache`);
    }
  }

  function getActiveConnectionCount(): number {
    return Array.from(connections.values()).filter((conn) => conn.handshake)
      .length;
  }

  async function checkAndMaintainConnections(): Promise<void> {
    if (!isRunning) return;

    console.log(`[ConnectionManager] Running connection check...`);
    const activeCount = getActiveConnectionCount();
    console.log(
      `[ConnectionManager] Active connections: ${activeCount}/${config.targetConnections}`
    );

    if (activeCount >= config.targetConnections) {
      return; // We have enough connections
    }

    // Need more connections
    const needed = config.targetConnections - activeCount;
    console.log(`[ConnectionManager] Need ${needed} more connections`);

    // Get available peers from cache
    const hosts = cache.getHosts();

    // Filter out already connected peers
    const availablePeers = hosts.filter((host) => {
      const address = `${host.ip}:${host.port}`;
      return !connections.has(address);
    });

    if (availablePeers.length === 0) {
      console.log(
        "[ConnectionManager] No available peers in cache, pulling from GWebCache..."
      );
      await cache.pullHostsFromCache();
      await cache.store();

      // Check again for newly fetched peers
      const newHosts = cache.getHosts();
      const newAvailablePeers = newHosts.filter((host) => {
        const address = `${host.ip}:${host.port}`;
        return !connections.has(address);
      });

      if (newAvailablePeers.length === 0) {
        console.log(
          "[ConnectionManager] Still no available peers after cache update"
        );
        return;
      }

      availablePeers.push(...newAvailablePeers);
    }

    // Sort by last seen (most recent first)
    availablePeers.sort((a, b) => b.lastSeen - a.lastSeen);

    // Connect to needed peers
    const peersToConnect = availablePeers.slice(0, needed);
    for (const peer of peersToConnect) {
      const address = `${peer.ip}:${peer.port}`;
      await connectToPeer(address);
    }
  }

  async function start(): Promise<void> {
    if (isRunning) {
      console.log("[ConnectionManager] Already running");
      return;
    }

    isRunning = true;
    console.log("[ConnectionManager] Starting connection manager");

    // Initial connection check
    await checkAndMaintainConnections();

    // Set up periodic checks
    intervalId = setInterval(() => {
      checkAndMaintainConnections().catch((error) => {
        console.error("[ConnectionManager] Error in connection check:", error);
      });
    }, config.checkInterval);
  }

  function stop(): void {
    if (!isRunning) return;

    isRunning = false;
    console.log("[ConnectionManager] Stopping connection manager");

    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }

    // Close all connections
    for (const [address, conn] of connections) {
      console.log(`[ConnectionManager] Closing connection to ${address}`);
      conn?.socket?.destroy?.();
    }
    connections.clear();
  }

  function getConnections(): Array<{
    address: string;
    handshake: boolean;
    version?: string;
    duration: number;
  }> {
    const now = Date.now();
    return Array.from(connections.entries()).map(([address, conn]) => ({
      address,
      handshake: conn.handshake,
      version: conn.version,
      duration: now - conn.connectTime,
    }));
  }

  return {
    start,
    stop,
    getConnections,
    getActiveConnectionCount,
  };
}
