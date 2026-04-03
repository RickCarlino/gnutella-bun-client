import { DEFAULT_USER_AGENT } from "../const";
import {
  DEFAULT_MAX_CACHES,
  DEFAULT_MAX_PEERS,
  normalizeCacheUrl,
  normalizeGWebCachePeer,
  normalizeNetwork,
  sanitizeClient,
  sanitizeVersion,
} from "./shared";

type SupportedGWebCacheNetwork = "gnutella" | "gnutella2";

type StoredHostEntry = {
  cluster?: string;
  createdAtMs: number;
  leafCount?: number;
  peer: string;
  uptimeSec?: number;
  vendor?: string;
};

type StoredCacheEntry = {
  createdAtMs: number;
  url: string;
};

type GWebCacheServerState = {
  caches: Map<string, StoredCacheEntry>;
  hosts: Record<SupportedGWebCacheNetwork, Map<string, StoredHostEntry>>;
};

type GWebCacheServerReply = {
  body: Buffer;
  headers?: Record<string, string>;
  statusCode: number;
};

type GWebCacheRequestMode = {
  network?: SupportedGWebCacheNetwork;
  wantsCaches: boolean;
  wantsHosts: boolean;
  wantsUpdate: boolean;
};

type UpdateMutationResult = {
  updated: boolean;
  warning?: string;
};

const CACHE_NAME = `GnutellaBun Relay Cache ${DEFAULT_USER_AGENT}`;
const CACHE_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
} as const;
const HOST_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_HOSTS_PER_NETWORK = 500;
const MAX_CACHED_URLS = 32;
const SUPPORTED_NETWORKS = ["gnutella", "gnutella2"] as const;

function enabledSearchParam(target: URL, key: string): boolean {
  const value = target.searchParams.get(key);
  return value != null && value !== "" && value !== "0";
}

function integerSearchParam(target: URL, key: string): number | undefined {
  const value = target.searchParams.get(key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function supportedNetwork(
  target: URL,
): SupportedGWebCacheNetwork | undefined {
  const raw = target.searchParams.get("net");
  if (!raw) return "gnutella";
  try {
    return normalizeNetwork(raw);
  } catch {
    return undefined;
  }
}

function isGWebCacheRequest(target: URL): boolean {
  return [
    "bfile",
    "get",
    "hostfile",
    "ip",
    "ping",
    "update",
    "url",
    "urlfile",
  ].some((key) => target.searchParams.has(key));
}

function allowsGWebCacheMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function ageSec(createdAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
}

function trimOldestEntries<T extends { createdAtMs: number }>(
  entries: Map<string, T>,
  maxEntries: number,
): void {
  while (entries.size > maxEntries) {
    let oldestKey: string | undefined;
    let oldestCreatedAtMs = Number.POSITIVE_INFINITY;
    for (const [key, value] of entries) {
      if (value.createdAtMs >= oldestCreatedAtMs) continue;
      oldestCreatedAtMs = value.createdAtMs;
      oldestKey = key;
    }
    if (!oldestKey) return;
    entries.delete(oldestKey);
  }
}

function latestEntries<T extends { createdAtMs: number }>(
  entries: Iterable<T>,
  limit: number,
): T[] {
  return [...entries]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit);
}

function upsertHost(
  state: GWebCacheServerState,
  network: SupportedGWebCacheNetwork,
  entry: StoredHostEntry,
): void {
  const hosts = state.hosts[network];
  hosts.set(entry.peer, entry);
  trimOldestEntries(hosts, MAX_HOSTS_PER_NETWORK);
}

function upsertCache(
  state: GWebCacheServerState,
  entry: StoredCacheEntry,
): void {
  state.caches.set(entry.url, entry);
  trimOldestEntries(state.caches, MAX_CACHED_URLS);
}

function supportedNetworksValue(): string {
  return SUPPORTED_NETWORKS.join("-");
}

function pongLine(): string {
  return `I|pong|${CACHE_NAME}|${supportedNetworksValue()}`;
}

function updateLine(ok: boolean, warning?: string): string {
  if (!warning) return `I|update|${ok ? "OK" : "WARNING"}`;
  return `I|update|${ok ? "OK" : "WARNING"}|${warning}`;
}

function stringField(
  enabled: boolean,
  value: number | string | undefined,
): string | undefined {
  if (!enabled) return undefined;
  return value == null ? "" : String(value);
}

function lastDefinedIndex(values: Array<string | undefined>): number {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] !== undefined) return index;
  }
  return -1;
}

function buildVendor(target: URL): string {
  const client = sanitizeClient(
    target.searchParams.get("client") || undefined,
  );
  const version = sanitizeVersion(
    target.searchParams.get("version") || undefined,
  );
  return `${client}/${version}`;
}

function hostExtraFields(entry: StoredHostEntry, target: URL): string[] {
  const extras = [
    stringField(enabledSearchParam(target, "getclusters"), entry.cluster),
    stringField(enabledSearchParam(target, "getleaves"), entry.leafCount),
    stringField(enabledSearchParam(target, "getvendors"), entry.vendor),
    stringField(enabledSearchParam(target, "getuptime"), entry.uptimeSec),
  ];
  const lastIncludedIndex = lastDefinedIndex(extras);
  if (lastIncludedIndex < 0) return [];
  return extras
    .slice(0, lastIncludedIndex + 1)
    .map((value) => value || "");
}

function hostLine(
  entry: StoredHostEntry,
  target: URL,
  nowMs: number,
): string {
  const fields = [`H|${entry.peer}|${ageSec(entry.createdAtMs, nowMs)}`];
  fields.push(...hostExtraFields(entry, target));
  return fields.join("|");
}

function cacheLine(entry: StoredCacheEntry, nowMs: number): string {
  return `U|${entry.url}|${ageSec(entry.createdAtMs, nowMs)}`;
}

function cleanupGWebCacheState(
  state: GWebCacheServerState,
  nowMs = Date.now(),
): void {
  for (const network of SUPPORTED_NETWORKS) {
    for (const [peer, entry] of state.hosts[network]) {
      if (nowMs - entry.createdAtMs <= HOST_TTL_MS) continue;
      state.hosts[network].delete(peer);
    }
  }

  for (const [url, entry] of state.caches) {
    if (nowMs - entry.createdAtMs <= CACHE_TTL_MS) continue;
    state.caches.delete(url);
  }
}

function queryHosts(
  state: GWebCacheServerState,
  network: SupportedGWebCacheNetwork,
  target: URL,
  nowMs: number,
): string[] {
  return latestEntries(
    state.hosts[network].values(),
    DEFAULT_MAX_PEERS,
  ).map((entry) => hostLine(entry, target, nowMs));
}

function queryCaches(
  state: GWebCacheServerState,
  nowMs: number,
): string[] {
  return latestEntries(state.caches.values(), DEFAULT_MAX_CACHES).map(
    (entry) => cacheLine(entry, nowMs),
  );
}

function peerUpdateResult(
  target: URL,
  state: GWebCacheServerState,
  network: SupportedGWebCacheNetwork,
  nowMs: number,
): UpdateMutationResult {
  const peer = target.searchParams.get("ip");
  if (!peer) return { updated: false };

  const normalizedPeer = normalizeGWebCachePeer(peer);
  if (!normalizedPeer) {
    return { updated: false, warning: `invalid peer: ${peer}` };
  }

  upsertHost(state, network, {
    cluster: target.searchParams.get("cluster")?.trim() || undefined,
    createdAtMs: nowMs,
    leafCount: integerSearchParam(target, "x_leaves"),
    peer: normalizedPeer,
    uptimeSec: integerSearchParam(target, "uptime"),
    vendor: buildVendor(target),
  });
  return { updated: true };
}

function cacheUpdateResult(
  target: URL,
  state: GWebCacheServerState,
  nowMs: number,
): UpdateMutationResult {
  const cacheUrl = target.searchParams.get("url");
  if (!cacheUrl) return { updated: false };

  const normalizedCacheUrl = normalizeCacheUrl(cacheUrl);
  if (!normalizedCacheUrl) {
    return {
      updated: false,
      warning: `invalid cache url: ${cacheUrl}`,
    };
  }

  upsertCache(state, {
    createdAtMs: nowMs,
    url: normalizedCacheUrl,
  });
  return { updated: true };
}

function updateWarning(
  target: URL,
  state: GWebCacheServerState,
  network: SupportedGWebCacheNetwork,
  nowMs: number,
): { ok: boolean; warning?: string } {
  const peerResult = peerUpdateResult(target, state, network, nowMs);
  const cacheResult = cacheUpdateResult(target, state, nowMs);
  const warnings = [peerResult.warning, cacheResult.warning].filter(
    (warning): warning is string => !!warning,
  );
  const updated = peerResult.updated || cacheResult.updated;
  if (!updated && warnings.length === 0) {
    warnings.push("missing ip or url");
  }

  return {
    ok: updated,
    warning: warnings.length ? warnings.join("; ") : undefined,
  };
}

function linesBuffer(lines: string[]): Buffer {
  return Buffer.from(
    lines.join("\n") + (lines.length ? "\n" : ""),
    "utf8",
  );
}

function methodNotAllowedReply(): GWebCacheServerReply {
  return {
    body: Buffer.alloc(0),
    headers: {
      ...CACHE_HEADERS,
      Allow: "GET, HEAD",
    },
    statusCode: 405,
  };
}

function invalidNetworkReply(method: string): GWebCacheServerReply {
  return {
    body:
      method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from("Required network not accepted", "utf8"),
    headers: { ...CACHE_HEADERS },
    statusCode: 503,
  };
}

function requestMode(target: URL): GWebCacheRequestMode {
  return {
    network: supportedNetwork(target),
    wantsCaches:
      enabledSearchParam(target, "get") ||
      enabledSearchParam(target, "urlfile") ||
      enabledSearchParam(target, "bfile"),
    wantsHosts:
      enabledSearchParam(target, "get") ||
      enabledSearchParam(target, "hostfile") ||
      enabledSearchParam(target, "bfile"),
    wantsUpdate:
      enabledSearchParam(target, "update") ||
      target.searchParams.has("ip") ||
      target.searchParams.has("url"),
  };
}

function requestNetwork(
  mode: GWebCacheRequestMode,
): SupportedGWebCacheNetwork {
  return mode.network || "gnutella";
}

function responseLines(
  state: GWebCacheServerState,
  mode: GWebCacheRequestMode,
  target: URL,
  nowMs: number,
): string[] {
  const network = requestNetwork(mode);
  const lines = [pongLine()];
  if (mode.wantsUpdate) {
    const result = updateWarning(target, state, network, nowMs);
    lines.push(updateLine(result.ok, result.warning));
  }
  if (mode.wantsHosts) {
    lines.push(...queryHosts(state, network, target, nowMs));
  }
  if (mode.wantsCaches) {
    lines.push(...queryCaches(state, nowMs));
  }
  return lines;
}

export function createGWebCacheServerState(): GWebCacheServerState {
  return {
    caches: new Map<string, StoredCacheEntry>(),
    hosts: {
      gnutella: new Map<string, StoredHostEntry>(),
      gnutella2: new Map<string, StoredHostEntry>(),
    },
  };
}

export function handleGWebCacheRequest(
  state: GWebCacheServerState,
  method: string,
  target: URL,
): GWebCacheServerReply | undefined {
  if (!isGWebCacheRequest(target)) return undefined;
  if (!allowsGWebCacheMethod(method)) return methodNotAllowedReply();

  const mode = requestMode(target);
  if (!mode.network && (mode.wantsHosts || mode.wantsCaches)) {
    return invalidNetworkReply(method);
  }
  const nowMs = Date.now();
  cleanupGWebCacheState(state, nowMs);

  return {
    body:
      method === "HEAD"
        ? Buffer.alloc(0)
        : linesBuffer(responseLines(state, mode, target, nowMs)),
    headers: { ...CACHE_HEADERS },
    statusCode: 200,
  };
}
