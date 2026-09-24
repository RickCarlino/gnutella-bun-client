import {
  filterBlockedPeerState,
  peerStateEquals,
  peerStateTargets,
  rememberPeerInState,
  sortPeerStateEntries,
  trimPeerState,
} from "../config";
import {
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  GWEBCACHE_REPORT_DELAY_SEC,
  MAX_PEER_AGE_SEC,
} from "../const";
import type { GWebCacheBootstrapState } from "../gwebcache_client";
import {
  isRoutableIpv4,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
} from "../shared";
import type {
  GnutellaServentCollaborators,
  PeerState,
  RuntimeConfig,
} from "../types";

type DiscoveryPeer = {
  connectedAt: number;
  dialTarget?: string;
  capabilities: { listenIp?: { host: string; port: number } };
};
type DiscoveryConfig = Pick<
  RuntimeConfig,
  | "blockedIps"
  | "peerSeenThresholdSec"
  | "gwebCacheUrls"
  | "vendorCode"
  | "userAgent"
  | "maxLeafConnections"
  | "connectTimeoutMs"
>;
type DiscoveryDependencies =
  GnutellaServentCollaborators["bootstrapClient"] & {
    config: () => DiscoveryConfig;
    now: () => number;
    startedAtMs: () => number;
    scheduler: Pick<
      GnutellaServentCollaborators["scheduler"],
      "setTimeout" | "clearTimeout"
    >;
    isSelfPeer: (host: string, port: number) => boolean;
    isBlockedHost: (host: string) => boolean;
    peerCount: () => number;
    nodeMode: () => "leaf" | "ultrapeer";
    connectedLeafCount: () => number;
    connectedMeshPeerCount: () => number;
    availableDialSlots: () => number;
    connectPeer: (
      host: string,
      port: number,
      timeoutMs?: number,
    ) => Promise<void>;
    currentAdvertisedHost: () => string;
    currentAdvertisedPort: () => number;
    onError: (error: unknown) => void;
  };

/** Owns remembered peers and GWebCache bootstrap work. */
export class PeerDiscovery {
  knownPeers: PeerState;
  readonly gwebCacheBootstrapState: GWebCacheBootstrapState = {};
  gwebCacheReportTimer?: NodeJS.Timeout;
  gwebCacheReportAttempted = false;
  gwebCacheReported = false;
  private stopped = false;

  /** Copy remembered peers and attach discovery dependencies. */
  constructor(
    private readonly deps: DiscoveryDependencies,
    peers: PeerState,
  ) {
    this.knownPeers = { ...peers };
  }

  /** Return a copy of remembered peer timestamps. */
  snapshot(): PeerState {
    return { ...this.knownPeers };
  }

  /** Stop discovery announcements and cancel their timer. */
  dispose(): void {
    this.stopped = true;
    this.cancelTimeout(this.gwebCacheReportTimer);
    this.gwebCacheReportTimer = undefined;
  }

  private scheduleOnce(
    delay: number,
    callback: () => void,
  ): NodeJS.Timeout {
    return this.deps.scheduler.setTimeout(callback, delay);
  }

  private cancelTimeout(timer?: NodeJS.Timeout): void {
    if (timer) this.deps.scheduler.clearTimeout(timer);
  }

  /** Remove blocked endpoints and count the removals. */
  pruneBlockedKnownPeers(): number {
    const current = trimPeerState(this.knownPeers);
    const filtered = filterBlockedPeerState(
      current,
      this.deps.config().blockedIps,
    );
    const removedKnownPeers =
      peerStateTargets(current).length - peerStateTargets(filtered).length;
    if (peerStateEquals(current, filtered)) return 0;
    this.knownPeers = filtered;
    this.gwebCacheBootstrapState.lastExhaustedPeerSet = undefined;
    return removedKnownPeers;
  }

  private rememberKnownPeer(
    host: string,
    port: number,
    timestamp: number,
  ): void {
    if (!host || !port || this.deps.isSelfPeer(host, port)) return;
    if (this.deps.isBlockedHost(host)) return;
    this.knownPeers = rememberPeerInState(
      this.knownPeers,
      normalizePeer(host, port),
      timestamp,
    );
  }

  /** Remember a newly discovered endpoint. */
  addKnownPeer(host: string, port: number): void {
    this.rememberKnownPeer(host, port, 0);
  }

  /** Record a peer's most recent successful sighting. */
  updateKnownPeerLastSeen(
    host: string,
    port: number,
    timestamp?: number,
  ): void {
    this.rememberKnownPeer(
      host,
      port,
      timestamp ?? this.peerSeenTimestamp(),
    );
  }

  /** Convert the clock to nonnegative epoch seconds. */
  peerSeenTimestamp(nowMs = this.deps.now()): number {
    return Math.max(0, Math.floor(nowMs / 1000));
  }

  /** Remove stale or blocked peers and report changes. */
  pruneExpiredKnownPeers(nowSec?: number): boolean {
    const timestamp = nowSec ?? this.peerSeenTimestamp();
    const current = trimPeerState(this.knownPeers);
    const filtered = Object.fromEntries(
      sortPeerStateEntries(
        filterBlockedPeerState(current, this.deps.config().blockedIps),
      ).filter(
        ([, lastSeen]) =>
          lastSeen === 0 || timestamp - lastSeen <= MAX_PEER_AGE_SEC,
      ),
    ) as PeerState;
    if (peerStateEquals(current, filtered)) return false;
    this.knownPeers = filtered;
    this.gwebCacheBootstrapState.lastExhaustedPeerSet = undefined;
    return true;
  }

  /** Check whether all remembered peers are unverified. */
  shouldBootstrapFreshPeers(): boolean {
    const peers = filterBlockedPeerState(
      trimPeerState(this.knownPeers),
      this.deps.config().blockedIps,
    );
    const timestamps = Object.values(peers);
    return (
      timestamps.length > 0 && timestamps.every((value) => value === 0)
    );
  }

  /** Remember a peer's dial and advertised endpoints. */
  rememberPeerAddresses(peer: DiscoveryPeer, timestamp = 0): void {
    const remembered = new Set<string>();
    const push = (host: string, port: number) => {
      const target = normalizePeer(host, port);
      if (remembered.has(target)) return;
      remembered.add(target);
      if (timestamp > 0)
        this.updateKnownPeerLastSeen(host, port, timestamp);
      else this.addKnownPeer(host, port);
    };

    if (peer.dialTarget) {
      const addr = parsePeer(peer.dialTarget);
      if (addr) push(addr.host, addr.port);
    }
    if (peer.capabilities.listenIp) {
      push(
        peer.capabilities.listenIp.host,
        peer.capabilities.listenIp.port,
      );
    }
  }

  /** Record sightings only after a stable connection. */
  markPeerSeenIfStable(
    peer: DiscoveryPeer,
    nowMs = this.deps.now(),
  ): void {
    if (
      nowMs - peer.connectedAt <
      this.deps.config().peerSeenThresholdSec * 1000
    )
      return;
    this.rememberPeerAddresses(peer, this.peerSeenTimestamp(nowMs));
  }

  /** Schedule an announcement once connected to peers. */
  scheduleGWebCacheReport(): void {
    if (this.stopped) return;
    if (
      this.gwebCacheReportAttempted ||
      this.gwebCacheReported ||
      this.gwebCacheReportTimer ||
      this.deps.peerCount() === 0
    )
      return;

    this.gwebCacheReportTimer = this.scheduleOnce(
      GWEBCACHE_REPORT_DELAY_SEC * 1000,
      () => {
        this.gwebCacheReportTimer = undefined;
        if (
          this.stopped ||
          this.gwebCacheReported ||
          this.deps.peerCount() === 0
        )
          return;
        this.gwebCacheReportAttempted = true;
        void this.announceSelfToGWebCaches().catch((e) =>
          this.deps.onError(e),
        );
      },
    );
  }

  /** Update announcement scheduling for current connectivity. */
  refreshGWebCacheReport(): void {
    if (this.deps.peerCount() > 0) {
      this.scheduleGWebCacheReport();
      return;
    }
    this.cancelTimeout(this.gwebCacheReportTimer);
    this.gwebCacheReportTimer = undefined;
  }

  /** Advertise the local routable endpoint and capacity. */
  async announceSelfToGWebCaches(): Promise<void> {
    const host = normalizeIpv4(this.deps.currentAdvertisedHost());
    const port = this.deps.currentAdvertisedPort();
    if (!host || !isRoutableIpv4(host) || !port) return;

    const result = await this.deps.reportSelfToGWebCaches({
      caches: this.deps.config().gwebCacheUrls,
      client: this.deps.config().vendorCode,
      version: this.deps.config().userAgent,
      ip: normalizePeer(host, port),
      uptimeSec: Math.max(
        0,
        Math.floor((this.deps.now() - this.deps.startedAtMs()) / 1000),
      ),
      leafCount:
        this.deps.nodeMode() === "ultrapeer"
          ? this.deps.connectedLeafCount()
          : undefined,
      maxLeaves:
        this.deps.nodeMode() === "ultrapeer"
          ? this.deps.config().maxLeafConnections
          : undefined,
      state: this.gwebCacheBootstrapState,
    });
    if (result.reportedCaches.length > 0) this.gwebCacheReported = true;
  }

  /** List unblocked remembered endpoints by recency. */
  getKnownPeers(): string[] {
    return peerStateTargets(
      filterBlockedPeerState(
        this.knownPeers,
        this.deps.config().blockedIps,
      ),
    );
  }

  /** Fill available connection slots from discovery sources. */
  async connectKnownPeers(): Promise<void> {
    this.pruneExpiredKnownPeers();
    const bootstrapFreshPeers = this.shouldBootstrapFreshPeers();
    if (bootstrapFreshPeers) {
      this.gwebCacheBootstrapState.lastExhaustedPeerSet = undefined;
    }
    const c = this.deps.config();
    const peers = bootstrapFreshPeers ? [] : this.getKnownPeers();
    const bootstrapTimeoutMs = Math.max(
      1,
      Math.floor(c.connectTimeoutMs / BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR),
    );
    await this.deps.connectBootstrapPeers({
      peers,
      caches: c.gwebCacheUrls,
      client: c.vendorCode,
      version: c.userAgent,
      connectTimeoutMs: bootstrapTimeoutMs,
      connectConcurrency: BOOTSTRAP_CONNECT_CONCURRENCY,
      connectedCount: () =>
        this.deps.nodeMode() === "ultrapeer"
          ? this.deps.connectedMeshPeerCount()
          : this.deps.peerCount(),
      availableSlots: () => this.deps.availableDialSlots(),
      connectPeer: (host, port, timeoutMs) =>
        this.deps.connectPeer(host, port, timeoutMs),
      addPeer: (peer) => {
        const addr = parsePeer(peer);
        if (!addr) return;
        this.addKnownPeer(addr.host, addr.port);
      },
      isSelfPeer: (host, port) => this.deps.isSelfPeer(host, port),
      state: this.gwebCacheBootstrapState,
    });
  }
}
