import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  GnutellaServent,
  defaultDoc,
  type Peer,
} from "../../../../src/protocol";
import type { RuntimeConfig, ShareFile } from "../../../../src/types";

export async function withTempDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "protocol-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function withMockNetworkInterfaces<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const original = os.networkInterfaces;
  (
    os as unknown as { networkInterfaces: typeof os.networkInterfaces }
  ).networkInterfaces = () =>
    ({
      lo: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
        },
      ],
    }) as unknown as ReturnType<typeof os.networkInterfaces>;
  try {
    return await fn();
  } finally {
    (
      os as unknown as { networkInterfaces: typeof os.networkInterfaces }
    ).networkInterfaces = original;
  }
}

export class MockSocket extends EventEmitter {
  remoteAddress?: string;
  remotePort?: number;
  writes: Buffer[] = [];
  ended = false;
  destroyed = false;

  constructor(remoteAddress = "127.0.0.1", remotePort = 6346) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
  }

  setNoDelay(_noDelay: boolean): this {
    return this;
  }

  setTimeout(_timeoutMs: number, callback?: () => void): this {
    if (callback) this.on("timeout", callback);
    return this;
  }

  write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array<ArrayBufferLike>): this {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.emit("end");
    return this;
  }

  destroy(_error?: Error): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

export function makeShare(
  index: number,
  absPath: string,
  name: string,
): ShareFile {
  const stem = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
  const suffix = String.fromCharCode(64 + index).repeat(32);
  return {
    index,
    name,
    rel: name,
    abs: absPath,
    size: 5,
    sha1: Buffer.alloc(20, index),
    sha1Urn: `urn:sha1:${suffix}`,
    keywords: stem,
  };
}

export function makeNode(configPath: string): GnutellaServent {
  const doc = defaultDoc(configPath);
  doc.config.dataDir = path.dirname(configPath);
  return new GnutellaServent(configPath, doc);
}

export function overrideRuntimeConfig(
  node: GnutellaServent,
  patch: Partial<RuntimeConfig>,
): void {
  const original = node.config.bind(node);
  (node as unknown as { config: () => RuntimeConfig }).config = () => ({
    ...original(),
    ...patch,
  });
}

export function peerState(
  entries: Array<[string, number]>,
): Record<string, number> {
  return Object.fromEntries(entries);
}

export function makePeer(label = "1.2.3.4:6346"): Peer {
  const socket = new MockSocket();
  return {
    key: label,
    socket: socket as unknown as net.Socket,
    buf: Buffer.alloc(0),
    outbound: false,
    remoteLabel: label,
    role: "leaf",
    capabilities: {
      version: "0.6",
      headers: {},
      supportsGgep: true,
      supportsPongCaching: false,
      supportsBye: true,
      supportsCompression: false,
      supportsTls: false,
      compressIn: false,
      compressOut: false,
      isUltrapeer: false,
      ultrapeerNeeded: false,
      isCrawler: false,
    },
    remoteQrp: {
      resetSeen: false,
      tableSize: 0,
      infinity: 0,
      entryBits: 0,
      table: null,
      seqSize: 0,
      compressor: 0,
      parts: new Map<number, Buffer>(),
    },
    lastPingAt: 0,
    connectedAt: Date.now(),
  };
}

export function makeHeader(
  payloadType: number,
  ttl: number,
  hops: number,
  fill: number,
) {
  const descriptorId = Buffer.alloc(16, fill);
  return {
    descriptorId,
    descriptorIdHex: descriptorId.toString("hex"),
    payloadType,
    ttl,
    hops,
  };
}
