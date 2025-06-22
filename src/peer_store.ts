import { Peer } from "./core_types";
import { readFile, writeFile } from "fs/promises";

export class PeerStore {
  private peers: Map<string, Peer>;
  private filename: string;

  constructor(filename: string = "settings.json") {
    this.peers = new Map();
    this.filename = filename;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.filename, "utf8");
      const parsed = JSON.parse(data);

      if (parsed.peers) {
        parsed.peers.forEach((p: Peer) => this.add(p.ip, p.port, p.lastSeen));
      }
    } catch {}
  }

  async save(): Promise<void> {
    try {
      let existingData: Record<string, unknown> = {};
      try {
        const content = await readFile(this.filename, "utf8");
        existingData = JSON.parse(content);
      } catch {}

      existingData.peers = Array.from(this.peers.values());
      await writeFile(this.filename, JSON.stringify(existingData, null, 2));
    } catch {}
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
