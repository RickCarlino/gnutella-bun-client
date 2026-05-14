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
  leafCount?: number;
  maxLeaves?: number;
  uptimeSec?: number;
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
  cluster?: string;
  leafCount?: number;
  maxLeaves?: number;
  uptimeSec?: number;
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
  "http://bj.ddns.net/beacon/gwc.php",
  "http://bj.ddns.net/cachechu/",
  "http://bj.ddns.net/gnucache/gcache.php",
  "http://bj.ddns.net/gwebcache/gcache.php",
  "http://bj.ddns.net/perlcache/perlgcache.cgi",
  "http://bj.ddns.net/phpgnucacheii/gwcii.php",
  "http://bj.ddns.net/skulls/skulls.php",
  "http://cache.jayl.de/g2/gwc.php/",
  "http://cache.trillinux.org/g2/bazooka.php",
  "http://dkac.trillinux.org/dkac/dkac.php/",
  "http://fascination77.free.fr/cachechu/",
  "http://gweb3.4octets.co.uk/gwc.php",
  "http://gweb4.4octets.co.uk/index.php",
  "http://midian.jayl.de/g2/bazooka.php",
  "http://p2p.findclan.net/skulls.php",
  "http://skulls.gwc.dyslexicfish.net/skulls.php",
  "http://www.paper.gwc.dyslexicfish.net/",
  "http://www.rock.gwc.dyslexicfish.net/",
  "http://www.scissors.gwc.dyslexicfish.net/",
  "https://www.paper.gwc.dyslexicfish.net/",
] as const;
