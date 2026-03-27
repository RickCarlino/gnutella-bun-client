import { normalizePeer, parsePeer } from "../shared";
import {
  DEFAULT_MAX_BOOTSTRAP_CACHES,
  DEFAULT_MAX_BOOTSTRAP_PEERS,
  DEFAULT_MAX_CACHES,
  DEFAULT_MAX_PEERS,
  aliveCachesForState,
  normalizeGWebCachePeer,
  rememberAliveCaches,
  seedCacheList,
} from "./shared";
import {
  describeHttpError,
  describeUpdateError,
  requestGWebCache,
} from "./response";
import type {
  BootstrapOptions,
  BootstrapPeer,
  BootstrapResult,
  ConnectBootstrapOptions,
  ConnectBootstrapResult,
  GWebCacheBootstrapState,
  GWebCacheHttpResponse,
  GWebCacheRequestOptions,
  ReportSelfOptions,
  ReportSelfResult,
} from "./types";

function normalizeBootstrapPeers(
  peers: readonly string[],
  isSelfPeer?: (host: string, port: number) => boolean,
): BootstrapPeer[] {
  const out: BootstrapPeer[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    const parsed = parsePeer(peer);
    if (!parsed) continue;
    if (isSelfPeer?.(parsed.host, parsed.port)) continue;

    const normalized = normalizePeer(parsed.host, parsed.port);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      host: parsed.host,
      port: parsed.port,
      peer: normalized,
    });
  }

  return out;
}

function bootstrapPeerSetKey(peers: BootstrapPeer[]): string {
  return peers
    .map((peer) => peer.peer)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

function buildReportReferenceUrl(
  cache: string,
  knownAliveCaches: readonly string[],
  seedCaches: readonly string[],
  fallbackCache: string,
): string {
  return (
    knownAliveCaches.find((candidate) => candidate !== cache) ||
    seedCaches.find((candidate) => candidate !== cache) ||
    fallbackCache
  );
}

async function reportSelfToCache(
  cache: string,
  peer: string,
  referenceUrl: string,
  options: ReportSelfOptions,
): Promise<{ reported: boolean; message?: string }> {
  try {
    const result = await requestGWebCache(cache, {
      mode: "update",
      client: options.client,
      version: options.version,
      spec: 2,
      ip: peer,
      url: referenceUrl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    if (result.ok && result.spec && result.update?.ok)
      return { reported: true };
    return { reported: false, message: describeUpdateError(result) };
  } catch (error) {
    return {
      reported: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyConnectBootstrapResult(
  attemptedPeers: string[],
): ConnectBootstrapResult {
  return {
    attemptedPeers,
    fetchedFromCaches: false,
    addedPeers: [],
    queriedCaches: [],
    errors: [],
  };
}

function exhaustedBootstrapPeerSet(
  candidates: BootstrapPeer[],
  initialAttempt: Awaited<ReturnType<typeof connectBootstrapPeerSet>>,
): boolean {
  return (
    candidates.length === 0 ||
    initialAttempt.attemptedPeers.length >= candidates.length
  );
}

function shouldSkipCacheBootstrap(
  candidates: BootstrapPeer[],
  initialAttempt: Awaited<ReturnType<typeof connectBootstrapPeerSet>>,
  candidateKey: string,
  state: GWebCacheBootstrapState | undefined,
): boolean {
  if (!exhaustedBootstrapPeerSet(candidates, initialAttempt)) return true;
  if (state?.active) return true;
  return state?.lastExhaustedPeerSet === candidateKey;
}

function buildBootstrapFetchOptions(
  options: ConnectBootstrapOptions,
): BootstrapOptions {
  return {
    caches: options.caches,
    client: options.client,
    version: options.version,
    network: options.network,
    timeoutMs: options.timeoutMs,
    maxPeers: options.maxBootstrapPeers || DEFAULT_MAX_BOOTSTRAP_PEERS,
    maxCaches: options.maxBootstrapCaches || DEFAULT_MAX_BOOTSTRAP_CACHES,
    queryAll: true,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
}

function addDiscoveredBootstrapPeers(
  peers: BootstrapPeer[],
  knownPeers: Set<string>,
  addPeer: ConnectBootstrapOptions["addPeer"],
): string[] {
  const addedPeers: string[] = [];
  for (const peer of peers) {
    knownPeers.add(peer.peer);
    addedPeers.push(peer.peer);
    addPeer?.(peer.peer);
  }
  return addedPeers;
}

async function fetchAndRetryBootstrapPeers(
  knownPeers: Set<string>,
  options: ConnectBootstrapOptions,
): Promise<{
  retryAttempt: Awaited<ReturnType<typeof connectBootstrapPeerSet>>;
  addedPeers: string[];
  queriedCaches: string[];
  errors: BootstrapResult["errors"];
}> {
  const bootstrap = await fetchBootstrapData(
    buildBootstrapFetchOptions(options),
  );
  rememberAliveCaches(options.state, bootstrap.successfulCaches);
  const discovered = normalizeBootstrapPeers(
    bootstrap.peers,
    options.isSelfPeer,
  ).filter((peer) => !knownPeers.has(peer.peer));
  const addedPeers = addDiscoveredBootstrapPeers(
    discovered,
    knownPeers,
    options.addPeer,
  );
  return {
    retryAttempt: await connectBootstrapPeerSet(discovered, options),
    addedPeers,
    queriedCaches: bootstrap.queriedCaches,
    errors: bootstrap.errors,
  };
}

async function connectBootstrapPeerSet(
  peers: BootstrapPeer[],
  options: Pick<
    ConnectBootstrapOptions,
    | "availableSlots"
    | "connectConcurrency"
    | "connectPeer"
    | "connectTimeoutMs"
  >,
): Promise<{
  attemptedPeers: string[];
  successCount: number;
}> {
  const availableSlots = Math.max(0, options.availableSlots());
  const workerCount = Math.min(
    Math.max(1, options.connectConcurrency),
    availableSlots,
    peers.length,
  );
  if (!workerCount) return { attemptedPeers: [], successCount: 0 };

  const attemptedPeers: string[] = [];
  let successCount = 0;
  let next = 0;

  const dialNext = async (): Promise<void> => {
    while (next < peers.length) {
      if (options.availableSlots() <= 0) return;
      const peer = peers[next++];
      attemptedPeers.push(peer.peer);
      try {
        await options.connectPeer(
          peer.host,
          peer.port,
          options.connectTimeoutMs,
        );
        successCount += 1;
      } catch {
        // Keep walking until the bootstrap list is exhausted.
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => dialNext()));
  return { attemptedPeers, successCount };
}

function mergeBootstrapResponse(
  result: BootstrapResult | GWebCacheHttpResponse,
  peers: Set<string>,
  caches: Set<string>,
  maxPeers: number,
  maxCaches: number,
): void {
  for (const peer of result.peers) {
    if (peers.size >= maxPeers) break;
    peers.add(peer);
  }
  for (const cache of result.caches) {
    if (caches.size >= maxCaches) break;
    caches.add(cache);
  }
}

function buildBootstrapRequestOptions(
  options: BootstrapOptions,
): GWebCacheRequestOptions {
  return {
    mode: "get",
    network: options.network || "gnutella",
    client: options.client,
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  };
}

function bootstrapResponseError(
  result: GWebCacheHttpResponse,
): string | undefined {
  if (!result.ok) return describeHttpError(result);
  if (!result.spec) return "unexpected non-spec2 gwebcache response";
  return undefined;
}

async function queryBootstrapCache(
  cache: string,
  options: BootstrapOptions,
): Promise<{ result?: GWebCacheHttpResponse; error?: string }> {
  try {
    return {
      result: await requestGWebCache(
        cache,
        buildBootstrapRequestOptions(options),
      ),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchBootstrapData(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const seedCaches = seedCacheList(options.caches);
  const maxPeers = Math.max(1, options.maxPeers ?? DEFAULT_MAX_PEERS);
  const maxCaches = Math.max(1, options.maxCaches ?? DEFAULT_MAX_CACHES);
  const peers = new Set<string>();
  const caches = new Set<string>();
  const successfulCaches = new Set<string>();
  const queriedCaches: string[] = [];
  const errors: BootstrapResult["errors"] = [];

  for (const cache of seedCaches) {
    if (!options.queryAll && peers.size >= maxPeers) break;
    queriedCaches.push(cache);
    const outcome = await queryBootstrapCache(cache, options);
    if (outcome.error) {
      errors.push({ cache, message: outcome.error });
      continue;
    }
    const result = outcome.result!;
    mergeBootstrapResponse(result, peers, caches, maxPeers, maxCaches);
    const message = bootstrapResponseError(result);
    if (message) {
      errors.push({ cache, message });
      continue;
    }
    successfulCaches.add(cache);
  }

  return {
    peers: [...peers],
    caches: [...caches],
    queriedCaches,
    successfulCaches: [...successfulCaches],
    errors,
  };
}

export async function getMorePeers(
  options: BootstrapOptions = {},
): Promise<string[]> {
  const result = await fetchBootstrapData(options);
  return result.peers;
}

export async function reportSelfToGWebCaches(
  options: ReportSelfOptions,
): Promise<ReportSelfResult> {
  const peer = normalizeGWebCachePeer(options.ip);
  if (!peer)
    throw new Error(`invalid gwebcache peer update: ${options.ip}`);

  const seedCaches = seedCacheList(options.caches);
  const errors: BootstrapResult["errors"] = [];
  const reportedCaches: string[] = [];
  const attemptedCaches: string[] = [];

  let knownAliveCaches = aliveCachesForState(options.state);
  const referenceCache = knownAliveCaches[0] || seedCaches[0];
  if (!referenceCache) {
    return {
      referenceCache: undefined,
      attemptedCaches,
      reportedCaches,
      errors,
    };
  }

  for (const cache of seedCaches) {
    attemptedCaches.push(cache);
    const result = await reportSelfToCache(
      cache,
      peer,
      buildReportReferenceUrl(
        cache,
        knownAliveCaches,
        seedCaches,
        referenceCache,
      ),
      options,
    );
    if (result.reported) {
      reportedCaches.push(cache);
      rememberAliveCaches(options.state, [cache]);
      knownAliveCaches = aliveCachesForState(options.state);
      continue;
    }
    if (result.message) errors.push({ cache, message: result.message });
  }

  return {
    referenceCache,
    attemptedCaches,
    reportedCaches,
    errors,
  };
}

function bootstrapSatisfied(
  successCount: number,
  connectedCount: number,
): boolean {
  return successCount > 0 || connectedCount > 0;
}

function clearExhaustedPeerSet(
  state: GWebCacheBootstrapState | undefined,
): void {
  if (state) state.lastExhaustedPeerSet = undefined;
}

function startCacheBootstrap(
  state: GWebCacheBootstrapState | undefined,
  candidateKey: string,
): void {
  if (!state) return;
  state.active = true;
  state.lastExhaustedPeerSet = candidateKey;
}

function finishCacheBootstrap(
  state: GWebCacheBootstrapState | undefined,
): void {
  if (state) state.active = false;
}

export async function connectBootstrapPeers(
  options: ConnectBootstrapOptions,
): Promise<ConnectBootstrapResult> {
  const candidates = normalizeBootstrapPeers(
    options.peers,
    options.isSelfPeer,
  );
  const candidateKey = bootstrapPeerSetKey(candidates);
  const knownPeers = new Set(candidates.map((peer) => peer.peer));
  const initialAttempt = await connectBootstrapPeerSet(
    candidates,
    options,
  );

  if (
    bootstrapSatisfied(
      initialAttempt.successCount,
      options.connectedCount(),
    )
  ) {
    clearExhaustedPeerSet(options.state);
    return emptyConnectBootstrapResult(initialAttempt.attemptedPeers);
  }
  if (
    shouldSkipCacheBootstrap(
      candidates,
      initialAttempt,
      candidateKey,
      options.state,
    )
  ) {
    return emptyConnectBootstrapResult(initialAttempt.attemptedPeers);
  }

  startCacheBootstrap(options.state, candidateKey);
  try {
    const retry = await fetchAndRetryBootstrapPeers(knownPeers, options);
    if (
      bootstrapSatisfied(
        retry.retryAttempt.successCount,
        options.connectedCount(),
      )
    ) {
      clearExhaustedPeerSet(options.state);
    }
    return {
      attemptedPeers: [
        ...initialAttempt.attemptedPeers,
        ...retry.retryAttempt.attemptedPeers,
      ],
      fetchedFromCaches: true,
      addedPeers: retry.addedPeers,
      queriedCaches: retry.queriedCaches,
      errors: retry.errors,
    };
  } finally {
    finishCacheBootstrap(options.state);
  }
}
