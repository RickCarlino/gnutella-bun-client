import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ADVERTISED_SPEED_KBPS,
  CONNECT_TIMEOUT_MS,
  DATA_DOWNLOADS_DIRNAME,
  DATA_SHARED_DIRNAME,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT,
  DEFAULT_PING_TTL,
  DEFAULT_QUERY_ROUTING_VERSION,
  DEFAULT_QUERY_TTL,
  DEFAULT_USER_AGENT,
  DEFAULT_VENDOR_CODE,
  DOWNLOAD_TIMEOUT_MS,
  ENABLE_BYE,
  ENABLE_COMPRESSION,
  ENABLE_GGEP,
  ENABLE_PONG_CACHING,
  ENABLE_QRP,
  MAX_PAYLOAD_BYTES,
  MAX_CONNECTIONS,
  MAX_RESULTS_PER_QUERY,
  MAX_TRACKED_PEERS,
  MAX_TTL,
  PEER_SEEN_THRESHOLD_SEC,
  PING_INTERVAL_SEC,
  PUSH_WAIT_MS,
  RECONNECT_INTERVAL_SEC,
  RESCAN_SHARES_SEC,
  ROUTE_TTL_SEC,
  SEEN_TTL_SEC,
  SERVE_URI_RES,
} from "../const";
import {
  ensureDir,
  fileExists,
  isRoutableIpv4,
  isUnspecifiedIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
  unique,
} from "../shared";
import type {
  ConfigDoc,
  DownloadRecord,
  PeerState,
  RuntimeConfig,
} from "../types";

type PersistedConfig = Partial<ConfigDoc["config"]> & {
  peers?: string[];
  seedPeers?: string[];
  sharedDir?: string;
  downloadsDir?: string;
};

type PersistedState = Partial<ConfigDoc["state"]> & {
  goodPeers?: string[];
  knownPeers?: string[];
  downloads?: DownloadRecord[];
};

type PersistedDoc = {
  config?: PersistedConfig;
  state?: PersistedState;
};

type LocalIpv4Candidates = {
  routable?: string;
  privateAddr?: string;
  loopback: string;
};

function interfaceIpv4Host(addr: {
  address: string;
  family?: string | number;
}): string | undefined {
  const family = String(addr.family || "");
  if (family !== "IPv4" && family !== "4") return undefined;
  const host = normalizeIpv4(addr.address);
  if (!host || isUnspecifiedIpv4(host)) return undefined;
  return host;
}

function recordLocalIpv4Candidate(
  candidates: LocalIpv4Candidates,
  host: string,
  internal: boolean | undefined,
): void {
  if (internal) {
    if (!candidates.loopback) candidates.loopback = host;
    return;
  }
  if (isRoutableIpv4(host)) {
    candidates.routable = host;
    return;
  }
  if (!candidates.privateAddr) candidates.privateAddr = host;
}

export function detectLocalAdvertisedIpv4(listenHost: string): string {
  const listen = normalizeIpv4(listenHost);
  if (listen && !isUnspecifiedIpv4(listen)) return listen;

  const candidates: LocalIpv4Candidates = {
    loopback: "127.0.0.1",
  };
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      const host = interfaceIpv4Host(addr);
      if (!host) continue;
      recordLocalIpv4Candidate(candidates, host, addr.internal);
      if (candidates.routable) return candidates.routable;
    }
  }
  return candidates.privateAddr || candidates.loopback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(
    value
      .map((item) => String(item || "").trim())
      .filter((item) => item.length > 0),
  );
}

function normalizePeerTimestamp(value: unknown): number {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor(ts));
}

function normalizePeerState(value: unknown): PeerState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {};

  const out = new Map<string, number>();
  for (const [peerSpec, rawTimestamp] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const addr = parsePeer(peerSpec);
    if (!addr) continue;
    const peer = normalizePeer(addr.host, addr.port);
    const timestamp = normalizePeerTimestamp(rawTimestamp);
    const current = out.get(peer) ?? 0;
    if (!out.has(peer) || timestamp > current) out.set(peer, timestamp);
  }

  return Object.fromEntries(out);
}

export function sortPeerStateEntries(
  peers: PeerState,
): Array<[peer: string, lastSeen: number]> {
  const entries = Object.entries(normalizePeerState(peers)) as Array<
    [string, number]
  >;
  entries.sort((a, b) => b[1] - a[1]);
  return entries;
}

export function trimPeerState(
  peers: PeerState,
  limit = MAX_TRACKED_PEERS,
): PeerState {
  if (limit <= 0) return {};
  return Object.fromEntries(sortPeerStateEntries(peers).slice(0, limit));
}

export function rememberPeerInState(
  peers: PeerState,
  peerSpec: string,
  timestamp = 0,
): PeerState {
  const addr = parsePeer(peerSpec);
  if (!addr) return trimPeerState(peers);

  const peer = normalizePeer(addr.host, addr.port);
  const current = normalizePeerState(peers);
  const existing = current[peer];
  const nextTimestamp = Math.max(
    existing ?? 0,
    normalizePeerTimestamp(timestamp),
  );
  const shouldPromote =
    existing == null ||
    nextTimestamp > existing ||
    (existing === 0 && nextTimestamp === 0);

  if (!shouldPromote) return trimPeerState(current);

  return trimPeerState(
    Object.fromEntries([
      [peer, nextTimestamp],
      ...Object.entries(current).filter(
        ([candidate]) => candidate !== peer,
      ),
    ]),
  );
}

function migratePeerState(
  value: {
    peers?: unknown;
    configPeers?: unknown;
    seedPeers?: unknown;
    knownPeers?: unknown;
    goodPeers?: unknown;
  } = {},
): PeerState {
  let peers = normalizePeerState(value.peers);
  for (const peer of normalizeStringArray(value.configPeers))
    peers = rememberPeerInState(peers, peer, 0);
  for (const peer of normalizeStringArray(value.seedPeers))
    peers = rememberPeerInState(peers, peer, 0);
  for (const peer of normalizeStringArray(value.knownPeers))
    peers = rememberPeerInState(peers, peer, 0);
  for (const peer of normalizeStringArray(value.goodPeers))
    peers = rememberPeerInState(peers, peer, 0);
  return peers;
}

export function peerStateTargets(peers: PeerState): string[] {
  return sortPeerStateEntries(peers).map(([peer]) => peer);
}

export function peerStateEquals(a: PeerState, b: PeerState): boolean {
  const aEntries = sortPeerStateEntries(a);
  const bEntries = sortPeerStateEntries(b);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(
    ([peer, lastSeen], index) =>
      bEntries[index]?.[0] === peer && bEntries[index]?.[1] === lastSeen,
  );
}

export function appendPathSuffix(
  filePath: string,
  suffixNo: number,
): string {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return path.join(dir, `${base} (${suffixNo})${ext}`);
}

function resolveDataDir(
  configPath: string,
  config: {
    dataDir?: unknown;
    sharedDir?: unknown;
    downloadsDir?: unknown;
  },
): string {
  const base = path.dirname(path.resolve(configPath));
  const resolvePath = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : path.resolve(base, trimmed);
  };

  const explicit = resolvePath(config.dataDir);
  if (explicit) return explicit;

  const sharedDir = resolvePath(config.sharedDir);
  const downloadsDir = resolvePath(config.downloadsDir);
  if (
    sharedDir &&
    downloadsDir &&
    path.dirname(sharedDir) === path.dirname(downloadsDir)
  ) {
    return path.dirname(sharedDir);
  }
  if (sharedDir && path.basename(sharedDir) === DATA_SHARED_DIRNAME)
    return path.dirname(sharedDir);
  if (
    downloadsDir &&
    path.basename(downloadsDir) === DATA_DOWNLOADS_DIRNAME
  )
    return path.dirname(downloadsDir);
  return base;
}

function normalizedListenHost(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_LISTEN_HOST;
}

function normalizedPositivePort(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

export function runtimeConfigFor(
  configPath: string,
  doc: Pick<ConfigDoc, "config" | "state">,
): RuntimeConfig {
  const dataDir = resolveDataDir(configPath, doc.config);
  const peers = trimPeerState(doc.state.peers);
  return {
    listenHost: normalizedListenHost(doc.config.listenHost),
    listenPort:
      normalizedPositivePort(doc.config.listenPort) || DEFAULT_LISTEN_PORT,
    advertisedHost:
      typeof doc.config.advertisedHost === "string" &&
      doc.config.advertisedHost.trim()
        ? doc.config.advertisedHost.trim()
        : undefined,
    advertisedPort: normalizedPositivePort(doc.config.advertisedPort),
    dataDir,
    downloadsDir: path.join(dataDir, DATA_DOWNLOADS_DIRNAME),
    peers: peerStateTargets(peers),
    peerSeenThresholdSec: PEER_SEEN_THRESHOLD_SEC,
    maxConnections: MAX_CONNECTIONS,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    pingIntervalSec: PING_INTERVAL_SEC,
    reconnectIntervalSec: RECONNECT_INTERVAL_SEC,
    rescanSharesSec: RESCAN_SHARES_SEC,
    routeTtlSec: ROUTE_TTL_SEC,
    seenTtlSec: SEEN_TTL_SEC,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    maxTtl: MAX_TTL,
    defaultPingTtl: DEFAULT_PING_TTL,
    defaultQueryTtl: DEFAULT_QUERY_TTL,
    advertisedSpeedKBps: ADVERTISED_SPEED_KBPS,
    downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
    pushWaitMs: PUSH_WAIT_MS,
    maxResultsPerQuery: MAX_RESULTS_PER_QUERY,
    userAgent: DEFAULT_USER_AGENT,
    queryRoutingVersion: DEFAULT_QUERY_ROUTING_VERSION,
    enableCompression: ENABLE_COMPRESSION,
    enableQrp: ENABLE_QRP,
    enableBye: ENABLE_BYE,
    enablePongCaching: ENABLE_PONG_CACHING,
    enableGgep: ENABLE_GGEP,
    serveUriRes: SERVE_URI_RES,
    vendorCode: DEFAULT_VENDOR_CODE,
  };
}

function randomDocServentId(): string {
  const id = crypto.randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id.toString("hex");
}

function optionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function normalizedServentIdHex(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value))
    return undefined;
  return value.toLowerCase();
}

export function defaultDoc(configPath: string): ConfigDoc {
  const base = path.dirname(path.resolve(configPath));
  return {
    config: {
      listenHost: DEFAULT_LISTEN_HOST,
      listenPort: DEFAULT_LISTEN_PORT,
      dataDir: base,
    },
    state: {
      serventIdHex: randomDocServentId(),
      peers: {},
    },
  };
}

async function ensureDocRuntimeDirs(
  configPath: string,
  doc: ConfigDoc,
  ensureConfigDir = false,
): Promise<void> {
  const runtime = runtimeConfigFor(configPath, doc);
  if (ensureConfigDir) await ensureDir(path.dirname(configPath));
  await ensureDir(runtime.downloadsDir);
}

function buildLoadedDoc(
  configPath: string,
  parsed: PersistedDoc,
): ConfigDoc {
  const defaults = defaultDoc(configPath);
  const config = parsed.config || {};
  const state = parsed.state || {};
  const doc: ConfigDoc = {
    config: {
      listenHost:
        optionalNonEmptyString(config.listenHost) ||
        defaults.config.listenHost,
      listenPort:
        positiveIntegerOrUndefined(config.listenPort) ||
        defaults.config.listenPort,
      dataDir: resolveDataDir(configPath, config),
    },
    state: {
      serventIdHex:
        normalizedServentIdHex(state.serventIdHex) ||
        defaults.state.serventIdHex,
      peers: migratePeerState({
        peers: state.peers,
        configPeers: config.peers,
        seedPeers: config.seedPeers,
        knownPeers: state.knownPeers,
        goodPeers: state.goodPeers,
      }),
    },
  };
  const advertisedHost = optionalNonEmptyString(config.advertisedHost);
  if (advertisedHost) doc.config.advertisedHost = advertisedHost;
  const advertisedPort = positiveIntegerOrUndefined(config.advertisedPort);
  if (advertisedPort) doc.config.advertisedPort = advertisedPort;
  return doc;
}

async function createDefaultDocOnDisk(
  configPath: string,
): Promise<ConfigDoc> {
  const doc = defaultDoc(configPath);
  await ensureDocRuntimeDirs(configPath, doc, true);
  await writeDoc(configPath, doc);
  return doc;
}

export async function loadDoc(configPath: string): Promise<ConfigDoc> {
  const full = path.resolve(configPath);
  if (!(await fileExists(full))) return await createDefaultDocOnDisk(full);
  const raw = await fsp.readFile(full, "utf8");
  const doc = buildLoadedDoc(full, JSON.parse(raw) as PersistedDoc);
  await ensureDocRuntimeDirs(full, doc);
  return doc;
}

export async function writeDoc(
  configPath: string,
  doc: ConfigDoc,
): Promise<void> {
  const full = path.resolve(configPath);
  const tmp = `${full}.tmp`;
  const runtime = runtimeConfigFor(full, doc);
  const clean: ConfigDoc = {
    config: {
      listenHost: runtime.listenHost,
      listenPort: runtime.listenPort,
      dataDir: runtime.dataDir,
    },
    state: {
      serventIdHex:
        typeof doc.state.serventIdHex === "string" &&
        /^[0-9a-f]{32}$/i.test(doc.state.serventIdHex)
          ? doc.state.serventIdHex.toLowerCase()
          : randomDocServentId(),
      peers: trimPeerState(doc.state.peers),
    },
  };
  if (runtime.advertisedHost)
    clean.config.advertisedHost = runtime.advertisedHost;
  if (
    runtime.advertisedPort != null &&
    runtime.advertisedPort !== runtime.listenPort
  ) {
    clean.config.advertisedPort = runtime.advertisedPort;
  }
  await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, full);
}
