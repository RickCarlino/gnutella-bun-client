export interface Cache {
  url: string;
  network: string;
  addedAt: number;
}

export interface FileEntry {
  filename: string;
  size: number;
  index: number;
  sha1?: Buffer;
}

export interface Host {
  ip: string;
  port: number;
  network: string;
  addedAt: number;
  cluster?: string;
}

export interface RateLimit {
  lastAccess: number;
  count: number;
}

export interface Peer {
  ip: string;
  port: number;
  lastSeen: number;
  firstSeen?: number;
  source?: "manual" | "gwc" | "pong";
  failureCount?: number;
}

export interface GnutellaConfig {
  httpPort: number;
  peers: Record<string, Peer>;
  caches: Record<string, { lastPush: number; lastPull: number }>;
}
