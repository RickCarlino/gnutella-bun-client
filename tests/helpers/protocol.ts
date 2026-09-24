import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultDoc, type Peer } from "../../src/protocol";
import type {
  GnutellaServentCollaboratorOverrides,
  RuntimeConfig,
  ShareFile,
} from "../../src/types";
import { TestServent as GnutellaServent } from "./servent";

/** Run a test in a temporary directory, then remove it. */
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

/** Run a test with only a loopback network interface. */
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

/** Records socket writes and emits controllable test events. */
export class MockSocket extends EventEmitter {
  remoteAddress?: string;
  remotePort?: number;
  writes: Buffer[] = [];
  ended = false;
  destroyed = false;

  /** Set the simulated remote endpoint. */
  constructor(remoteAddress = "127.0.0.1", remotePort = 6346) {
    super();
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
  }

  /** Accept the socket option without changing test behavior. */
  setNoDelay(_noDelay: boolean): this {
    return this;
  }

  /** Register a callback for manually emitted timeouts. */
  setTimeout(_timeoutMs: number, callback?: () => void): this {
    if (callback) this.on("timeout", callback);
    return this;
  }

  /** Record bytes written by the code under test. */
  write(chunk: string | Uint8Array<ArrayBufferLike>): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }

  /** Record optional bytes and emit the simulated end event. */
  end(chunk?: string | Uint8Array<ArrayBufferLike>): this {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
    this.emit("end");
    return this;
  }

  /** Mark the socket destroyed and emit its close event. */
  destroy(_error?: Error): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

/** Build a deterministic shared-file fixture. */
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
    mtimeMs: index,
    sha1: Buffer.alloc(20, index),
    sha1Urn: `urn:sha1:${suffix}`,
    keywords: stem,
  };
}

/** Create a test servent with default settings and overrides. */
export function makeNode(
  configPath: string,
  options: {
    runtimeConfig?: Partial<RuntimeConfig>;
    collaborators?: GnutellaServentCollaboratorOverrides;
  } = {},
): GnutellaServent {
  const doc = defaultDoc(configPath);
  doc.config.dataDir = path.dirname(configPath);
  return new GnutellaServent(configPath, doc, options);
}

/** Apply runtime settings to a test node. */
export function overrideRuntimeConfig(
  node: GnutellaServent,
  patch: Partial<RuntimeConfig>,
): void {
  node.updateRuntimeConfig(patch);
}

/** Build saved peer timestamps from endpoint entries. */
export function peerState(
  entries: Array<[string, number]>,
): Record<string, number> {
  return Object.fromEntries(entries);
}

/** Build a leaf peer fixture backed by a mock socket. */
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

/** Build a descriptor header with a deterministic ID. */
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
