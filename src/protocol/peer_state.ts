import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os, { type NetworkInterfaceInfo } from "node:os";
import path from "node:path";

import {
  ADVERTISED_SPEED_KBPS,
  CONNECT_TIMEOUT_MS,
  DATA_DOWNLOADS_DIRNAME,
  DEFAULT_LISTEN_HOST,
  DEFAULT_LISTEN_PORT_MAX,
  DEFAULT_LISTEN_PORT_MIN,
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
  ENABLE_TLS,
  MAX_LEAF_CONNECTIONS,
  MAX_PAYLOAD_BYTES,
  MAX_RESULTS_PER_QUERY,
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
  unique,
} from "../shared";
import type { ConfigDoc, RuntimeConfig } from "../types";
import { normalizeCacheUrl } from "../gwebcache/shared";
import {
  filterBlockedPeerState,
  normalizePeerState,
  persistedDocForRuntime,
} from "../persistence";
import type { PersistedConfig, PersistedDoc } from "../persistence/types";

export {
  filterBlockedPeerState,
  peerStateEquals,
  peerStateTargets,
  rememberPeerInState,
  sortPeerStateEntries,
  trimPeerState,
} from "../persistence";

type LocalIpv4Candidates = {
  routable?: string;
  privateAddr?: string;
  loopback: string;
};

type DataDirConfig = Pick<PersistedConfig, "data_dir">;

type ConnectionLimitConfig = Pick<
  RuntimeConfig,
  "nodeMode" | "maxUltrapeerConnections" | "maxLeafConnections"
>;

function interfaceIpv4Host(
  addr: Pick<NetworkInterfaceInfo, "address" | "family">,
): string | undefined {
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
  config: DataDirConfig,
): string {
  const base = path.dirname(path.resolve(configPath));
  const explicit = resolveConfiguredPath(base, config.data_dir);
  return explicit || base;
}

function normalizedListenHost(value: unknown): string {
  return (
    normalizeIpv4(typeof value === "string" ? value : undefined) ||
    DEFAULT_LISTEN_HOST
  );
}

function normalizedPositivePort(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0
    ? (value as number)
    : undefined;
}

function defaultListenPortForServentId(serventIdHex: string): number {
  const span = DEFAULT_LISTEN_PORT_MAX - DEFAULT_LISTEN_PORT_MIN + 1;
  if (!/^[0-9a-f]{32}$/i.test(serventIdHex)) {
    return DEFAULT_LISTEN_PORT_MIN;
  }
  const seed = Number.parseInt(serventIdHex.slice(0, 8), 16);
  return DEFAULT_LISTEN_PORT_MIN + (seed % span);
}

function normalizedAdvertisedHost(value: unknown): string | undefined {
  return normalizeIpv4(typeof value === "string" ? value : undefined);
}

function runtimeGWebCacheUrls(value: unknown): string[] {
  return normalizedGWebCacheUrls(value) || [];
}

function derivedMaxConnections(config: ConnectionLimitConfig): number {
  return config.nodeMode === "ultrapeer"
    ? config.maxUltrapeerConnections + config.maxLeafConnections
    : config.maxUltrapeerConnections;
}

export function runtimeConfigFor(
  configPath: string,
  doc: Pick<ConfigDoc, "config" | "state">,
): RuntimeConfig {
  const dataDir = resolveDataDir(configPath, {
    data_dir: doc.config.dataDir,
  });
  const defaultListenPort = defaultListenPortForServentId(
    doc.state.serventIdHex,
  );
  const monitorIgnoreEvents =
    normalizedMonitorIgnoreEvents(doc.config.monitorIgnoreEvents) || [];
  const nodeMode = doc.config.ultrapeer === true ? "ultrapeer" : "leaf";
  const maxUltrapeerConnections =
    positiveIntegerOrUndefined(doc.config.maxUltrapeerConnections) ||
    MAX_ULTRAPEER_CONNECTIONS;
  const maxLeafConnections =
    positiveIntegerOrUndefined(doc.config.maxLeafConnections) ||
    MAX_LEAF_CONNECTIONS;
  return {
    listenHost: normalizedListenHost(doc.config.listenHost),
    listenPort:
      normalizedPositivePort(doc.config.listenPort) || defaultListenPort,
    advertisedHost: normalizedAdvertisedHost(doc.config.advertisedHost),
    advertisedPort: normalizedPositivePort(doc.config.advertisedPort),
    blockedIps: normalizedBlockedIps(doc.config.blockedIps) || [],
    gwebCacheUrls: runtimeGWebCacheUrls(doc.config.gwebCacheUrls),
    ultrapeer: doc.config.ultrapeer === true,
    monitorIgnoreEvents,
    nodeMode,
    dataDir,
    downloadsDir: path.join(dataDir, DATA_DOWNLOADS_DIRNAME),
    peerSeenThresholdSec: PEER_SEEN_THRESHOLD_SEC,
    maxConnections: derivedMaxConnections({
      nodeMode,
      maxUltrapeerConnections,
      maxLeafConnections,
    }),
    maxUltrapeerConnections,
    maxLeafConnections,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    pingIntervalSec: PING_INTERVAL_SEC,
    reconnectIntervalSec: RECONNECT_INTERVAL_SEC,
    rescanSharesSec: RESCAN_SHARES_SEC,
    routeTtlSec: ROUTE_TTL_SEC,
    seenTtlSec: SEEN_TTL_SEC,
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    maxTtl: positiveIntegerOrUndefined(doc.config.maxTtl) || MAX_TTL,
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
    enableTls:
      typeof doc.config.enableTls === "boolean"
        ? doc.config.enableTls
        : ENABLE_TLS,
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
  if (
    patch.maxConnections != null &&
    patch.maxUltrapeerConnections == null
  ) {
    next.maxUltrapeerConnections = patch.maxConnections;
  }
  if (patch.nodeMode && patch.ultrapeer == null) {
    next.ultrapeer = patch.nodeMode === "ultrapeer";
  } else if (patch.ultrapeer != null && patch.nodeMode == null) {
    next.nodeMode = patch.ultrapeer ? "ultrapeer" : "leaf";
  }
  next.maxConnections = derivedMaxConnections(next);
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
    blockedIps: config.blockedIps.length
      ? [...config.blockedIps]
      : undefined,
    gwebCacheUrls: config.gwebCacheUrls.length
      ? [...config.gwebCacheUrls]
      : undefined,
    ultrapeer: config.ultrapeer,
    maxUltrapeerConnections: config.maxUltrapeerConnections,
    maxLeafConnections: config.maxLeafConnections,
    maxTtl: config.maxTtl,
    enableTls: config.enableTls,
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

function normalizedStringArray(
  value: unknown,
  normalize: (value: string) => string | undefined,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = unique(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalize(entry))
      .filter((entry): entry is string => !!entry),
  );
  return normalized.length ? normalized : undefined;
}

function normalizedMonitorIgnoreEvents(
  value: unknown,
): string[] | undefined {
  return normalizedStringArray(value, (entry) => {
    const normalized = entry.trim().toUpperCase();
    return normalized || undefined;
  });
}

function normalizedBlockedIps(value: unknown): string[] | undefined {
  return normalizedStringArray(value, (entry) => normalizeIpv4(entry));
}

function normalizedGWebCacheUrls(value: unknown): string[] | undefined {
  return normalizedStringArray(value, (entry) => normalizeCacheUrl(entry));
}

function normalizedServentIdHex(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value))
    return undefined;
  return value.toLowerCase();
}

export function defaultDoc(configPath: string): ConfigDoc {
  const base = path.dirname(path.resolve(configPath));
  const serventIdHex = randomDocServentId();
  return {
    config: {
      listenHost: DEFAULT_LISTEN_HOST,
      listenPort: defaultListenPortForServentId(serventIdHex),
      blockedIps: [],
      ultrapeer: false,
      maxUltrapeerConnections: MAX_ULTRAPEER_CONNECTIONS,
      maxLeafConnections: MAX_LEAF_CONNECTIONS,
      maxTtl: MAX_TTL,
      dataDir: base,
    },
    state: {
      serventIdHex,
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

function applyLoadedPeerLimits(
  doc: ConfigDoc,
  config: PersistedConfig,
): void {
  const maxUltrapeerConnections =
    positiveIntegerOrUndefined(config.max_ultrapeer_connections) ||
    positiveIntegerOrUndefined(config.max_connections);
  if (maxUltrapeerConnections)
    doc.config.maxUltrapeerConnections = maxUltrapeerConnections;
  const maxLeafConnections = positiveIntegerOrUndefined(
    config.max_leaf_connections,
  );
  if (maxLeafConnections)
    doc.config.maxLeafConnections = maxLeafConnections;
  const maxTtl = positiveIntegerOrUndefined(config.max_ttl);
  if (maxTtl) doc.config.maxTtl = maxTtl;
}

function applyLoadedMonitorConfig(
  doc: ConfigDoc,
  config: PersistedConfig,
): void {
  const monitorIgnoreEvents = normalizedMonitorIgnoreEvents(
    config.log_ignore,
  );
  if (monitorIgnoreEvents)
    doc.config.monitorIgnoreEvents = monitorIgnoreEvents;
}

function applyOptionalLoadedConfig(
  doc: ConfigDoc,
  config: PersistedConfig,
): void {
  const advertisedHost =
    optionalNonEmptyString(config.advertised_ip) ||
    optionalNonEmptyString(config.advertised_host);
  if (advertisedHost) doc.config.advertisedHost = advertisedHost;
  const advertisedPort = positiveIntegerOrUndefined(
    config.advertised_port,
  );
  if (advertisedPort) doc.config.advertisedPort = advertisedPort;
  const blockedIps = normalizedBlockedIps(config.blocked_ips);
  if (blockedIps) doc.config.blockedIps = blockedIps;
  const gwebCacheUrls = normalizedGWebCacheUrls(config.gwebcache_urls);
  if (gwebCacheUrls) doc.config.gwebCacheUrls = gwebCacheUrls;
  if (typeof config.enable_tls === "boolean")
    doc.config.enableTls = config.enable_tls;
  doc.config.ultrapeer = config.ultrapeer === true;
  applyLoadedPeerLimits(doc, config);
  applyLoadedMonitorConfig(doc, config);
}

function buildLoadedDoc(
  configPath: string,
  parsed: PersistedDoc,
): ConfigDoc {
  const defaults = defaultDoc(configPath);
  const config = parsed.config || {};
  const state = parsed.state || {};
  const serventIdHex =
    normalizedServentIdHex(state.servent_id_hex) ||
    defaults.state.serventIdHex;
  const doc: ConfigDoc = {
    config: {
      listenHost:
        optionalNonEmptyString(config.listen_ip) ||
        optionalNonEmptyString(config.listen_host) ||
        defaults.config.listenHost,
      listenPort:
        positiveIntegerOrUndefined(config.listen_port) ||
        defaultListenPortForServentId(serventIdHex),
      blockedIps: [],
      ultrapeer: config.ultrapeer === true,
      maxUltrapeerConnections: defaults.config.maxUltrapeerConnections,
      maxLeafConnections: defaults.config.maxLeafConnections,
      maxTtl: defaults.config.maxTtl,
      dataDir: resolveDataDir(configPath, config),
    },
    state: {
      serventIdHex,
      peers: normalizePeerState(state.peers),
    },
  };
  applyOptionalLoadedConfig(doc, config);
  doc.state.peers = filterBlockedPeerState(
    doc.state.peers,
    doc.config.blockedIps || [],
  );
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
  const clean = persistedDocForRuntime(runtime, doc, randomDocServentId());
  await fsp.writeFile(tmp, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, full);
}
