import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ADVERTISED_SPEED_KBPS,
  CONNECT_TIMEOUT_MS,
  DATA_DOWNLOADS_DIRNAME,
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
  MAX_CONNECTIONS,
  MAX_LEAF_CONNECTIONS,
  MAX_PAYLOAD_BYTES,
  MAX_RESULTS_PER_QUERY,
  MAX_TRACKED_PEERS,
  MAX_TTL,
  MAX_ULTRAPEER_CONNECTIONS,
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
import type { ConfigDoc, PeerState, RuntimeConfig } from "../types";

type PersistedConfig = {
  listen_host?: unknown;
  listen_port?: unknown;
  advertised_host?: unknown;
  advertised_port?: unknown;
  ultrapeer?: unknown;
  max_connections?: unknown;
  max_ultrapeer_connections?: unknown;
  max_leaf_connections?: unknown;
  log_ignore?: unknown;
  data_dir?: unknown;
};

type PersistedState = {
  servent_id_hex?: unknown;
  peers?: unknown;
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

function resolveConfiguredPath(
  baseDir: string,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(baseDir, trimmed);
}

function resolveDataDir(
  configPath: string,
  config: {
    data_dir?: unknown;
  },
): string {
  const base = path.dirname(path.resolve(configPath));
  const explicit = resolveConfiguredPath(base, config.data_dir);
  return explicit || base;
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
  const dataDir = resolveDataDir(configPath, {
    data_dir: doc.config.dataDir,
  });
  const monitorIgnoreEvents =
    normalizedMonitorIgnoreEvents(doc.config.monitorIgnoreEvents) || [];
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
    ultrapeer: doc.config.ultrapeer === true,
    monitorIgnoreEvents,
    nodeMode: doc.config.ultrapeer === true ? "ultrapeer" : "leaf",
    dataDir,
    downloadsDir: path.join(dataDir, DATA_DOWNLOADS_DIRNAME),
    peerSeenThresholdSec: PEER_SEEN_THRESHOLD_SEC,
    maxConnections:
      positiveIntegerOrUndefined(doc.config.maxConnections) ||
      MAX_CONNECTIONS,
    maxUltrapeerConnections:
      positiveIntegerOrUndefined(doc.config.maxUltrapeerConnections) ||
      MAX_ULTRAPEER_CONNECTIONS,
    maxLeafConnections:
      positiveIntegerOrUndefined(doc.config.maxLeafConnections) ||
      MAX_LEAF_CONNECTIONS,
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

export function applyRuntimeConfigPatch(
  config: RuntimeConfig,
  patch: Partial<RuntimeConfig>,
): RuntimeConfig {
  const next = {
    ...config,
    ...patch,
  };
  if (patch.nodeMode && patch.ultrapeer == null) {
    next.ultrapeer = patch.nodeMode === "ultrapeer";
  } else if (patch.ultrapeer != null && patch.nodeMode == null) {
    next.nodeMode = patch.ultrapeer ? "ultrapeer" : "leaf";
  }
  return next;
}

export function configDocForRuntime(
  config: RuntimeConfig,
): ConfigDoc["config"] {
  return {
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    advertisedHost: config.advertisedHost,
    advertisedPort: config.advertisedPort,
    ultrapeer: config.ultrapeer,
    maxConnections: config.maxConnections,
    maxUltrapeerConnections: config.maxUltrapeerConnections,
    maxLeafConnections: config.maxLeafConnections,
    monitorIgnoreEvents: config.monitorIgnoreEvents.length
      ? [...config.monitorIgnoreEvents]
      : undefined,
    dataDir: config.dataDir,
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

function normalizedMonitorIgnoreEvents(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = unique(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => entry.length > 0),
  );
  return normalized.length ? normalized : undefined;
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
      ultrapeer: false,
      maxConnections: MAX_CONNECTIONS,
      maxUltrapeerConnections: MAX_ULTRAPEER_CONNECTIONS,
      maxLeafConnections: MAX_LEAF_CONNECTIONS,
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

function applyOptionalLoadedConfig(
  doc: ConfigDoc,
  config: PersistedConfig,
): void {
  const advertisedHost = optionalNonEmptyString(config.advertised_host);
  if (advertisedHost) doc.config.advertisedHost = advertisedHost;
  const advertisedPort = positiveIntegerOrUndefined(
    config.advertised_port,
  );
  if (advertisedPort) doc.config.advertisedPort = advertisedPort;
  doc.config.ultrapeer = config.ultrapeer === true;
  const maxConnections = positiveIntegerOrUndefined(
    config.max_connections,
  );
  if (maxConnections) doc.config.maxConnections = maxConnections;
  const maxUltrapeerConnections = positiveIntegerOrUndefined(
    config.max_ultrapeer_connections,
  );
  if (maxUltrapeerConnections)
    doc.config.maxUltrapeerConnections = maxUltrapeerConnections;
  const maxLeafConnections = positiveIntegerOrUndefined(
    config.max_leaf_connections,
  );
  if (maxLeafConnections)
    doc.config.maxLeafConnections = maxLeafConnections;
  const monitorIgnoreEvents = normalizedMonitorIgnoreEvents(
    config.log_ignore,
  );
  if (monitorIgnoreEvents)
    doc.config.monitorIgnoreEvents = monitorIgnoreEvents;
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
        optionalNonEmptyString(config.listen_host) ||
        defaults.config.listenHost,
      listenPort:
        positiveIntegerOrUndefined(config.listen_port) ||
        defaults.config.listenPort,
      ultrapeer: config.ultrapeer === true,
      maxConnections: defaults.config.maxConnections,
      maxUltrapeerConnections: defaults.config.maxUltrapeerConnections,
      maxLeafConnections: defaults.config.maxLeafConnections,
      dataDir: resolveDataDir(configPath, config),
    },
    state: {
      serventIdHex:
        normalizedServentIdHex(state.servent_id_hex) ||
        defaults.state.serventIdHex,
      peers: normalizePeerState(state.peers),
    },
  };
  applyOptionalLoadedConfig(doc, config);
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
  const cleanConfig: PersistedConfig = {
    listen_host: runtime.listenHost,
    listen_port: runtime.listenPort,
    ultrapeer: runtime.ultrapeer,
    max_connections: runtime.maxConnections,
    max_ultrapeer_connections: runtime.maxUltrapeerConnections,
    max_leaf_connections: runtime.maxLeafConnections,
    data_dir: runtime.dataDir,
  };
  const cleanState: PersistedState = {
    servent_id_hex:
      typeof doc.state.serventIdHex === "string" &&
      /^[0-9a-f]{32}$/i.test(doc.state.serventIdHex)
        ? doc.state.serventIdHex.toLowerCase()
        : randomDocServentId(),
    peers: trimPeerState(doc.state.peers),
  };
  if (runtime.advertisedHost)
    cleanConfig.advertised_host = runtime.advertisedHost;
  if (
    runtime.advertisedPort != null &&
    runtime.advertisedPort !== runtime.listenPort
  ) {
    cleanConfig.advertised_port = runtime.advertisedPort;
  }
  if (runtime.monitorIgnoreEvents.length)
    cleanConfig.log_ignore = runtime.monitorIgnoreEvents;
  const clean: PersistedDoc = {
    config: cleanConfig,
    state: cleanState,
  };
  await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, full);
}
