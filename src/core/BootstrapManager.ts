import { GnutellaServer } from "../GnutellaServer";
import { SettingStore } from "../SettingStore";
import { GWebCacheClient } from "../cache-client";
import { ConnectionManager } from "./ConnectionManager";
import { getPublicIP } from "../utils/network";

interface BootstrapConfig {
  maxCachesPerQuery: number;
  announceIntervalHours: number;
  minConnectionsToAnnounce: number;
}

/**
 * Manages the bootstrap process for joining the Gnutella network
 */
export class BootstrapManager {
  private readonly settingStore: SettingStore;
  private readonly gwcClient: GWebCacheClient;
  private readonly connectionManager: ConnectionManager;
  private readonly config: BootstrapConfig;
  private readonly localPort: number;
  private announceInterval: ReturnType<typeof setInterval> | null = null;
  private publicIp: string | null = null;

  constructor(
    _server: GnutellaServer,
    settingStore: SettingStore,
    gwcClient: GWebCacheClient,
    connectionManager: ConnectionManager,
    localPort: number,
    config: Partial<BootstrapConfig> = {},
  ) {
    this.settingStore = settingStore;
    this.gwcClient = gwcClient;
    this.connectionManager = connectionManager;
    this.localPort = localPort;
    this.config = {
      maxCachesPerQuery: 3,
      announceIntervalHours: 1,
      minConnectionsToAnnounce: 1,
      ...config,
    };
  }

  /**
   * Bootstrap the node into the network
   */
  async bootstrap(): Promise<void> {
    console.log("Starting bootstrap process...");

    // Load settings
    await this.settingStore.load();

    // Try to get our public IP
    this.publicIp = await getPublicIP();
    console.log(`Detected public IP: ${this.publicIp}`);

    // Start connection manager
    this.connectionManager.start();

    // Initial connection attempt with saved peers
    await this.attemptSavedPeerConnections();

    // If we don't have enough connections, query GWebCaches
    if (this.connectionManager.getConnectionCount() < 4) {
      await this.queryGWebCaches();
    }

    // If we have connections and a public IP, announce ourselves
    if (
      this.connectionManager.getConnectionCount() >=
        this.config.minConnectionsToAnnounce &&
      this.publicIp
    ) {
      await this.announceToGWebCaches();
    }

    // Schedule periodic announcements
    this.scheduleAnnouncements();

    // Save any new peers/caches we discovered
    await this.settingStore.save();

    console.log(
      `Bootstrap complete. Connected to ${this.connectionManager.getConnectionCount()} peers.`,
    );
  }

  /**
   * Stop the bootstrap manager
   */
  stop(): void {
    if (this.announceInterval) {
      clearInterval(this.announceInterval);
      this.announceInterval = null;
    }
    this.connectionManager.stop();
  }

  /**
   * Attempt connections to saved peers
   */
  private async attemptSavedPeerConnections(): Promise<void> {
    const savedPeers = this.settingStore.getNPeers(10); // Get top 10 saved peers

    if (savedPeers.length === 0) {
      console.log("No saved peers found");
      return;
    }

    console.log(`Attempting to connect to ${savedPeers.length} saved peers...`);

    // Let ConnectionManager handle the actual connections
    await this.connectionManager.maintainConnections();

    // Wait a bit for connections to establish
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  /**
   * Query GWebCaches for initial peers
   */
  private async queryGWebCaches(): Promise<void> {
    const caches = this.settingStore.getCaches();
    const availableCaches = caches.filter((cache) =>
      this.settingStore.canQueryCache(cache.url),
    );

    if (availableCaches.length === 0) {
      console.log("No available GWebCaches to query (rate limited)");
      return;
    }

    const cachesToQuery = availableCaches.slice(
      0,
      this.config.maxCachesPerQuery,
    );
    console.log(`Querying ${cachesToQuery.length} GWebCaches for peers...`);

    const queryPromises = cachesToQuery.map(async (cache) => {
      console.log(`Querying ${cache.url}...`);
      const result = await this.gwcClient.fetchPeersAndCaches(cache.url);

      // Update timestamp
      this.settingStore.updateCacheTimestamp(cache.url, "pull");

      // Add discovered peers
      for (const peer of result.peers) {
        this.settingStore.addPeer(peer.ip, peer.port, "gwc");
      }

      // Add new cache URLs
      for (const cacheUrl of result.caches) {
        // Check if we already know this cache
        const existing = caches.find((c) => c.url === cacheUrl);
        if (!existing) {
          console.log(`Discovered new cache: ${cacheUrl}`);
          this.settingStore.updateCacheTimestamp(cacheUrl, "pull");
        }
      }

      console.log(
        `Found ${result.peers.length} peers and ${result.caches.length} caches from ${cache.url}`,
      );
      return result;
    });

    await Promise.all(queryPromises);

    // Save discovered peers and caches
    await this.settingStore.save();

    // Try to connect to discovered peers
    await this.connectionManager.maintainConnections();
  }

  /**
   * Submit our node to GWebCaches
   */
  private async announceToGWebCaches(): Promise<void> {
    if (!this.publicIp) {
      console.log("Cannot announce to GWebCaches without public IP");
      return;
    }

    const caches = this.settingStore.getCaches();
    const availableCaches = caches.filter((cache) =>
      this.settingStore.canPushToCache(cache.url),
    );

    if (availableCaches.length === 0) {
      console.log("No available GWebCaches to announce to (rate limited)");
      return;
    }

    // Select different caches than those we queried from
    const cachesToAnnounce = availableCaches
      .sort(() => Math.random() - 0.5) // Randomize
      .slice(0, this.config.maxCachesPerQuery);

    console.log(`Announcing to ${cachesToAnnounce.length} GWebCaches...`);

    const announcePromises = cachesToAnnounce.map(async (cache) => {
      console.log(`Announcing to ${cache.url}...`);
      const success = await this.gwcClient.submitHost(
        cache.url,
        this.publicIp as string,
        this.localPort,
      );

      if (success) {
        // Update timestamp
        this.settingStore.updateCacheTimestamp(cache.url, "push");
        console.log(`Successfully announced to ${cache.url}`);
      } else {
        console.warn(`Failed to announce to ${cache.url}`);
      }

      return success;
    });

    const results = await Promise.all(announcePromises);
    const successCount = results.filter((r) => r).length;
    console.log(
      `Announced to ${successCount}/${cachesToAnnounce.length} caches successfully`,
    );

    // Save updated timestamps
    await this.settingStore.save();
  }

  /**
   * Schedule periodic GWC announcements
   */
  private scheduleAnnouncements(): void {
    const intervalMs = this.config.announceIntervalHours * 60 * 60 * 1000;

    this.announceInterval = setInterval(async () => {
      // Only announce if we have connections and a public IP
      if (
        this.connectionManager.getConnectionCount() >=
          this.config.minConnectionsToAnnounce &&
        this.publicIp
      ) {
        await this.announceToGWebCaches();
      }
    }, intervalMs);
  }
}
