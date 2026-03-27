type GWebCacheMode = "get" | "update";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type GWebCacheRequestOptions = {
  mode?: GWebCacheMode;
  network?: "gnutella" | "gnutella2";
  client?: string;
  version?: string;
  ping?: boolean;
  spec?: 2;
  ip?: string;
  url?: string;
  cluster?: string;
  getLeaves?: boolean;
  getClusters?: boolean;
  getVendors?: boolean;
  getUptime?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
};

export type GWebCacheInfoLine = {
  key: string;
  values: string[];
};

export type GWebCachePong = {
  name: string;
  networks: string[];
};

export type GWebCacheUpdate = {
  ok: boolean;
  warning?: string;
  values: string[];
};

export type GWebCacheHostEntry = {
  peer: string;
  ageSec?: number;
  cluster?: string;
  leafCount?: number;
  vendor?: string;
  uptimeSec?: number;
  extraFields: string[];
};

export type GWebCacheCacheEntry = {
  url: string;
  ageSec?: number;
};

export type GWebCacheResponse = {
  spec?: 2;
  rawLines: string[];
  peers: string[];
  caches: string[];
  warnings: string[];
  info: GWebCacheInfoLine[];
  hostEntries: GWebCacheHostEntry[];
  cacheEntries: GWebCacheCacheEntry[];
  pong?: GWebCachePong;
  update?: GWebCacheUpdate;
};

export type GWebCacheHttpResponse = GWebCacheResponse & {
  requestUrl: string;
  body: string;
  status: number;
  statusText: string;
  ok: boolean;
};

export type BootstrapOptions = {
  caches?: readonly string[];
  client?: string;
  version?: string;
  network?: "gnutella" | "gnutella2";
  timeoutMs?: number;
  maxPeers?: number;
  maxCaches?: number;
  queryAll?: boolean;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
};

export type BootstrapResult = {
  peers: string[];
  caches: string[];
  queriedCaches: string[];
  successfulCaches: string[];
  errors: Array<{
    cache: string;
    message: string;
  }>;
};

export type BootstrapPeer = {
  host: string;
  port: number;
  peer: string;
};

export type GWebCacheBootstrapState = {
  active?: boolean;
  lastExhaustedPeerSet?: string;
  aliveCaches?: string[];
};

export type ConnectBootstrapOptions = BootstrapOptions & {
  peers: readonly string[];
  connectTimeoutMs: number;
  connectConcurrency: number;
  connectedCount: () => number;
  availableSlots: () => number;
  connectPeer: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<void>;
  addPeer?: (peer: string) => void;
  isSelfPeer?: (host: string, port: number) => boolean;
  maxBootstrapPeers?: number;
  maxBootstrapCaches?: number;
  state?: GWebCacheBootstrapState;
};

export type ConnectBootstrapResult = {
  attemptedPeers: string[];
  fetchedFromCaches: boolean;
  addedPeers: string[];
  queriedCaches: string[];
  errors: BootstrapResult["errors"];
};

export type ReportSelfOptions = {
  caches?: readonly string[];
  client?: string;
  version?: string;
  timeoutMs?: number;
  ip: string;
  state?: GWebCacheBootstrapState;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
};

export type ReportSelfResult = {
  referenceCache?: string;
  attemptedCaches: string[];
  reportedCaches: string[];
  errors: BootstrapResult["errors"];
};

export const KNOWN_CACHES = [
  "http://p2p.findclan.net/skulls.php",
  "http://bj.ddns.net/phpgnucacheii/gwcii.php",
  "http://midian.jayl.de/g2/bazooka.php",
  "https://skulls.gwc.dyslexicfish.net/skulls.php",
  "http://cache.jayl.de/g2/gwc.php",
  "http://bj.ddns.net/beacon/gwc.php",
  "http://midian.jayl.de/g2/gwc.php",
  "http://bj.ddns.net/cachechu/",
] as const;
