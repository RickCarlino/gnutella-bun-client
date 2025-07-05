import { readFile, writeFile } from "fs/promises";
import { HOUR } from "./const";
import { Peer, GnutellaConfig } from "./types";

export class SettingStore {
  private peers: Map<string, Peer>;
  private filename: string;
  private cacheTimestamps: Map<string, { lastPull: number; lastPush: number }>;

  constructor(filename: string = "settings.json") {
    this.peers = new Map();
    this.filename = filename;
    this.cacheTimestamps = new Map();
  }

  async load(): Promise<void> {
    const data = await readFile(this.filename, "utf8");
    const parsed: GnutellaConfig = JSON.parse(data);

    // Load peers with all metadata
    if (parsed.peers) {
      Object.keys(parsed.peers).forEach((key) => {
        const p = parsed.peers[key];
        this.peers.set(key, {
          ip: p.ip,
          port: p.port,
          lastSeen: p.lastSeen,
          firstSeen: p.firstSeen,
          source: p.source,
          failureCount: p.failureCount || 0,
        });
      });
    }

    // Load cache timestamps
    if (parsed.caches) {
      Object.keys(parsed.caches).forEach((url) => {
        this.cacheTimestamps.set(url, {
          lastPull: parsed.caches[url].lastPull || 0,
          lastPush: parsed.caches[url].lastPush || 0,
        });
      });
    }
  }

  async save(): Promise<void> {
    const content = await readFile(this.filename, "utf8");
    const existingData: GnutellaConfig = JSON.parse(content);

    // Save peers with all metadata
    const nextPeers: Record<string, Peer> = {};
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      nextPeers[key] = peer;
    });
    existingData.peers = nextPeers;

    // Save cache timestamps
    const nextCaches: Record<string, { lastPull: number; lastPush: number }> =
      {};
    Array.from(this.cacheTimestamps.entries()).forEach(([url, timestamps]) => {
      nextCaches[url] = timestamps;
    });
    existingData.caches = { ...existingData.caches, ...nextCaches };

    await writeFile(this.filename, JSON.stringify(existingData, null, 2));
  }

  addPeer(
    ip: string,
    port: number,
    source: "manual" | "gwc" | "pong" = "manual",
    lastSeen: number = Date.now(),
  ): void {
    const key = `${ip}:${port}`;
    const existing = this.peers.get(key);

    if (existing) {
      // Update existing peer
      existing.lastSeen = lastSeen;
      existing.failureCount = 0; // Reset on successful sighting
    } else {
      // Add new peer
      this.peers.set(key, {
        ip,
        port,
        lastSeen,
        firstSeen: lastSeen,
        source,
        failureCount: 0,
      });
    }
  }

  /**
   * Record a connection failure for a peer
   */
  recordPeerFailure(ip: string, port: number): void {
    const key = `${ip}:${port}`;
    const peer = this.peers.get(key);
    if (peer) {
      peer.failureCount = (peer.failureCount || 0) + 1;
    }
  }

  removePeer(ip: string, port: number): void {
    this.peers.delete(`${ip}:${port}`);
  }

  /**
   * Get the best N peers based on scoring criteria
   */
  getNPeers(count: number): Peer[] {
    return Array.from(this.peers.values())
      .sort((a, b) => this.scorePeer(b) - this.scorePeer(a))
      .slice(0, count);
  }

  /**
   * Score a peer based on various criteria
   * Higher score = better peer
   */
  private scorePeer(peer: Peer): number {
    let score = 0;

    // Recency bonus (0-100 points based on last seen)
    const hoursSinceLastSeen = (Date.now() - peer.lastSeen) / HOUR;
    if (hoursSinceLastSeen < 1) {
      score += 100;
    } else {
      if (hoursSinceLastSeen < 6) {
        score += 80;
      } else {
        if (hoursSinceLastSeen < 24) {
          score += 60;
        } else {
          if (hoursSinceLastSeen < 72) {
            score += 40;
          } else {
            score += 20;
          }
        }
      }
    }

    // Source bonus
    switch (peer.source) {
      case "gwc":
        score += 30; // GWC peers are likely to be stable ultrapeers
        break;
      case "pong":
        score += 20; // Active peers responding to pings
        break;
      case "manual":
        score += 10; // Manually added peers
        break;
    }

    // Stability bonus (based on how long we've known them)
    if (peer.firstSeen) {
      const daysKnown = (Date.now() - peer.firstSeen) / (24 * HOUR);
      score += Math.min(daysKnown * 5, 50); // Up to 50 points for longevity
    }

    // Failure penalty
    score -= (peer.failureCount || 0) * 20;

    return Math.max(0, score);
  }

  prune(maxAge: number = HOUR): void {
    const cutoff = Date.now() - maxAge;
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(key);
      }
    });
  }

  /**
   * Update cache timestamp for rate limiting
   */
  updateCacheTimestamp(cacheUrl: string, action: "pull" | "push"): void {
    const timestamps = this.cacheTimestamps.get(cacheUrl) || {
      lastPull: 0,
      lastPush: 0,
    };
    if (action === "pull") {
      timestamps.lastPull = Date.now();
    } else {
      timestamps.lastPush = Date.now();
    }
    this.cacheTimestamps.set(cacheUrl, timestamps);
  }

  /**
   * Check if enough time has passed since last cache query
   */
  canQueryCache(cacheUrl: string): boolean {
    const timestamps = this.cacheTimestamps.get(cacheUrl);
    if (!timestamps) {
      return true; // Never queried before
    }
    return Date.now() - timestamps.lastPull >= HOUR;
  }

  /**
   * Check if enough time has passed since last cache push
   */
  canPushToCache(cacheUrl: string): boolean {
    const timestamps = this.cacheTimestamps.get(cacheUrl);
    if (!timestamps) {
      return true; // Never pushed before
    }
    return Date.now() - timestamps.lastPush >= HOUR;
  }

  /**
   * Get all known cache URLs with their timestamps
   */
  getCaches(): Array<{ url: string; lastPull: number; lastPush: number }> {
    return Array.from(this.cacheTimestamps.entries()).map(
      ([url, timestamps]) => ({
        url,
        ...timestamps,
      }),
    );
  }
}
