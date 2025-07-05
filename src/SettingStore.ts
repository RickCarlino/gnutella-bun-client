import { readFile, writeFile } from "fs/promises";
import { HOUR } from "./const";
import { Peer, GnutellaConfig } from "./types";

export class SettingStore {
  private peers: Map<string, Peer>;
  private filename: string;

  constructor(filename: string = "settings.json") {
    this.peers = new Map();
    this.filename = filename;
  }

  async load(): Promise<void> {
    try {
      const data = await readFile(this.filename, "utf8");
      const parsed: GnutellaConfig = JSON.parse(data);
      if (parsed.peers) {
        Object.keys(parsed.peers).forEach((key) => {
          const p = parsed.peers[key];
          this.addPeer(p.ip, p.port, p.lastSeen);
        });
      }
    } catch {}
  }

  async save(): Promise<void> {
    try {
      const content = await readFile(this.filename, "utf8");
      const existingData: GnutellaConfig = JSON.parse(content);
      const prevPeers = existingData.peers || {};
      const nextPeers: Record<string, Peer> = {};
      Array.from(this.peers.values()).forEach((peer) => {
        nextPeers[`${peer.ip}:${peer.port}`] = {
          ip: peer.ip,
          port: peer.port,
          lastSeen: peer.lastSeen,
        };
      });
      existingData.peers = { ...prevPeers, ...nextPeers };
      await writeFile(this.filename, JSON.stringify(existingData, null, 2));
    } catch {}
  }

  addPeer(ip: string, port: number, lastSeen: number = Date.now()): void {
    this.peers.set(`${ip}:${port}`, { ip, port, lastSeen });
  }

  removePeer(ip: string, port: number): void {
    this.peers.delete(`${ip}:${port}`);
  }

  getNPeers(count: number): Peer[] {
    return Array.from(this.peers.values())
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, count);
  }

  prune(maxAge: number = HOUR): void {
    const cutoff = Date.now() - maxAge;
    Array.from(this.peers.entries()).forEach(([key, peer]) => {
      if (peer.lastSeen < cutoff) {
        this.peers.delete(key);
      }
    });
  }
}
