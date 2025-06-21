import { log } from "node:console";
import { Peer } from "./interfaces";

export class PeerStore {
  private peers: Map<string, Peer> = new Map();
  private filename: string = "settings.json";

  async load(): Promise<void> {
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(this.filename, "utf8");
      const parsed = JSON.parse(data);
      parsed.peers?.forEach((p: Peer) => this.add(p.ip, p.port, p.lastSeen));
      log(
        `[PEERSTORE] Loaded ${parsed.peers?.length || 0} peers from ${
          this.filename
        }`,
      );
    } catch (error) {
      log(`[PEERSTORE] Failed to load peers:`, error);
    }
  }

  async save(): Promise<void> {
    try {
      const { readFile, writeFile } = await import("node:fs/promises");

      // Read existing data to preserve caches
      let existingData: any = {};
      try {
        const fileContent = await readFile(this.filename, "utf8");
        existingData = JSON.parse(fileContent);
      } catch {
        // File might not exist yet
      }

      // Update only the peers section
      existingData.peers = Array.from(this.peers.values());

      await writeFile(this.filename, JSON.stringify(existingData, null, 2));
      log(`[PEERSTORE] Saved ${this.peers.size} peers to ${this.filename}`);
    } catch (error) {
      log(`[PEERSTORE] Failed to save peers:`, error);
    }
  }

  add(ip: string, port: number, lastSeen: number = Date.now()): void {
    this.peers.set(`${ip}:${port}`, { ip, port, lastSeen });
  }

  remove(ip: string, port: number): void {
    this.peers.delete(`${ip}:${port}`);
  }

  get(count: number): Peer[] {
    return Array.from(this.peers.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, count);
  }

  prune(maxAge: number = 3600000): void {
    const cutoff = Date.now() - maxAge;
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(key);
      }
    });
  }
}
