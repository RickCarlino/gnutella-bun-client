import { EventEmitter } from "events";
import { GnutellaServer } from "../GnutellaServer";
import { SettingStore } from "../SettingStore";
import { GWebCacheClient } from "../cache-client";
import { Connection, Peer } from "../types";

interface ConnectionManagerConfig {
  targetConnections: number;
  maxRetries: number;
  retryDelayMs: number;
  connectionTimeoutMs: number;
}

interface PeerConnectionAttempt {
  peer: Peer;
  attempts: number;
  lastAttempt: number;
  nextRetryTime: number;
}

/**
 * Manages peer connections, maintaining a target number of active connections
 */
export class ConnectionManager extends EventEmitter {
  private readonly config: ConnectionManagerConfig;
  private readonly server: GnutellaServer;
  private readonly settingStore: SettingStore;
  private readonly gwcClient: GWebCacheClient;
  private activeConnections: Map<string, Connection> = new Map();
  private connectionAttempts: Map<string, PeerConnectionAttempt> = new Map();
  private maintenanceInterval: ReturnType<typeof setInterval> | null = null;
  private lastConnectionAttempt: number = 0;
  private readonly CONNECTION_RATE_LIMIT = 1000; // 1 connection per second

  constructor(
    server: GnutellaServer,
    settingStore: SettingStore,
    gwcClient: GWebCacheClient,
    config: Partial<ConnectionManagerConfig> = {},
  ) {
    super();
    this.server = server;
    this.settingStore = settingStore;
    this.gwcClient = gwcClient;
    this.config = {
      targetConnections: 4,
      maxRetries: 3,
      retryDelayMs: 5000,
      connectionTimeoutMs: 10000,
      ...config,
    };
  }

  /**
   * Start monitoring connections
   */
  start(): void {
    // Initial connection attempt
    this.maintainConnections().catch((err) =>
      console.error("Error during initial connection maintenance:", err),
    );

    // Schedule periodic maintenance
    this.maintenanceInterval = setInterval(() => {
      this.maintainConnections().catch((err) =>
        console.error("Error during connection maintenance:", err),
      );
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop monitoring connections
   */
  stop(): void {
    if (this.maintenanceInterval) {
      clearInterval(this.maintenanceInterval);
      this.maintenanceInterval = null;
    }
  }

  /**
   * Handle peer connected event
   */
  onPeerConnected(connectionId: string, connection: Connection): void {
    this.activeConnections.set(connectionId, connection);

    // Clear connection attempts for this peer
    const peerKey = connectionId;
    this.connectionAttempts.delete(peerKey);

    this.emit("peer:connected", connectionId);
  }

  /**
   * Handle peer disconnected event
   */
  onPeerDisconnected(connectionId: string): void {
    this.activeConnections.delete(connectionId);
    this.emit("peer:disconnected", connectionId);

    // Schedule maintenance check after a short delay
    setTimeout(() => {
      this.maintainConnections().catch((err) =>
        console.error("Error during post-disconnect maintenance:", err),
      );
    }, 2000); // 2 second delay
  }

  /**
   * Check and maintain target connection count
   */
  async maintainConnections(): Promise<void> {
    const currentCount = this.activeConnections.size;
    const needed = this.config.targetConnections - currentCount;

    if (needed <= 0) {
      return; // Already at or above target
    }

    console.log(`Currently ${currentCount} connections, need ${needed} more`);

    // Get peers to connect to
    const peers = await this.discoverPeers(needed * 2); // Get extra in case some fail

    // Attempt connections
    for (const peer of peers) {
      if (this.activeConnections.size >= this.config.targetConnections) {
        break; // Target reached
      }

      const peerKey = `${peer.ip}:${peer.port}`;

      // Skip if already connected
      if (this.activeConnections.has(peerKey)) {
        continue;
      }

      // Skip if recently attempted
      const attempt = this.connectionAttempts.get(peerKey);
      if (attempt && Date.now() < attempt.nextRetryTime) {
        continue;
      }

      // Rate limit connection attempts
      const timeSinceLastAttempt = Date.now() - this.lastConnectionAttempt;
      if (timeSinceLastAttempt < this.CONNECTION_RATE_LIMIT) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            this.CONNECTION_RATE_LIMIT - timeSinceLastAttempt,
          ),
        );
      }

      await this.connectToPeer(peer.ip, peer.port);
    }
  }

  /**
   * Try to connect to a peer with retry logic
   */
  async connectToPeer(host: string, port: number): Promise<boolean> {
    const peerKey = `${host}:${port}`;
    this.lastConnectionAttempt = Date.now();

    // Get or create connection attempt record
    let attempt = this.connectionAttempts.get(peerKey);
    if (!attempt) {
      const peer = { ip: host, port, lastSeen: Date.now() } as Peer;
      attempt = {
        peer,
        attempts: 0,
        lastAttempt: 0,
        nextRetryTime: 0,
      };
      this.connectionAttempts.set(peerKey, attempt);
    }

    // Check if we've exceeded max retries
    if (attempt.attempts >= this.config.maxRetries) {
      console.log(`Max retries reached for ${peerKey}`);
      this.settingStore.recordPeerFailure(host, port);
      return false;
    }

    attempt.attempts++;
    attempt.lastAttempt = Date.now();

    try {
      console.log(
        `Attempting connection to ${peerKey} (attempt ${attempt.attempts})`,
      );

      const connection = await Promise.race([
        this.server.connectPeer(host, port),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Connection timeout")),
            this.config.connectionTimeoutMs,
          ),
        ),
      ]);

      console.log(`Begin handshake with ${peerKey}`);
      this.onPeerConnected(peerKey, connection);
      return true;
    } catch (error) {
      console.error(`Failed to connect to ${peerKey}:`, error);
      this.settingStore.recordPeerFailure(host, port);

      // Calculate next retry time with exponential backoff and jitter
      const baseDelay =
        this.config.retryDelayMs * Math.pow(2, attempt.attempts - 1);
      const jitter = Math.random() * 0.3 * baseDelay; // 30% jitter
      attempt.nextRetryTime = Date.now() + baseDelay + jitter;

      return false;
    }
  }

  /**
   * Discover peers from various sources
   */
  async discoverPeers(count: number): Promise<Peer[]> {
    const peers: Peer[] = [];
    const seenPeers = new Set<string>();

    // First, get saved peers from settings
    const savedPeers = this.settingStore.getNPeers(count * 2);
    for (const peer of savedPeers) {
      const key = `${peer.ip}:${peer.port}`;
      if (!seenPeers.has(key)) {
        peers.push(peer);
        seenPeers.add(key);
      }
    }

    // If we need more peers, query GWebCache
    if (peers.length < count) {
      const caches = this.settingStore.getCaches();
      const availableCaches = caches.filter((cache) =>
        this.settingStore.canQueryCache(cache.url),
      );

      for (const cache of availableCaches.slice(0, 3)) {
        // Query up to 3 caches
        if (peers.length >= count) {
          break;
        }

        try {
          console.log(`Querying GWebCache: ${cache.url}`);
          const result = await this.gwcClient.fetchPeersAndCaches(cache.url);

          // Update cache timestamp
          this.settingStore.updateCacheTimestamp(cache.url, "pull");

          // Add discovered peers
          for (const gwcPeer of result.peers) {
            const key = `${gwcPeer.ip}:${gwcPeer.port}`;
            if (!seenPeers.has(key)) {
              // Add to setting store
              this.settingStore.addPeer(gwcPeer.ip, gwcPeer.port, "gwc");

              const peer = {
                ip: gwcPeer.ip,
                port: gwcPeer.port,
                lastSeen: Date.now(),
                source: "gwc" as const,
                failureCount: 0,
              };
              peers.push(peer);
              seenPeers.add(key);
            }
          }

          // Save to persist new peers
          await this.settingStore.save();
        } catch (error) {
          console.error(`Failed to query GWebCache ${cache.url}:`, error);
        }
      }
    }

    // Sort by score and return requested count
    return peers
      .sort((a, b) => this.scorePeer(b) - this.scorePeer(a))
      .slice(0, count);
  }

  /**
   * Score a peer for connection priority
   */
  private scorePeer(peer: Peer): number {
    let score = 100;

    // Penalize failed peers heavily
    score -= (peer.failureCount || 0) * 30;

    // Prefer GWC-discovered peers
    if (peer.source === "gwc") {
      score += 20;
    }

    // Slight penalty for very recent attempts
    const peerKey = `${peer.ip}:${peer.port}`;
    const attempt = this.connectionAttempts.get(peerKey);
    if (attempt && Date.now() - attempt.lastAttempt < 60000) {
      // Within last minute
      score -= 10;
    }

    return score;
  }

  /**
   * Get current connection count
   */
  getConnectionCount(): number {
    return this.activeConnections.size;
  }

  /**
   * Get active connections
   */
  getActiveConnections(): Connection[] {
    return Array.from(this.activeConnections.values());
  }
}
