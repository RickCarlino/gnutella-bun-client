type EventBase<T extends string> = { type: T; at: string };

export type CliNode = {
  getPeers(): Array<{
    key: string;
    remoteLabel: string;
    outbound: boolean;
    dialTarget?: string;
    userAgent?: string;
    compression: boolean;
    tls: boolean;
  }>;
  getResults(): Array<{
    resultNo: number;
    queryIdHex?: string;
    queryHops?: number;
    remoteHost: string;
    remotePort: number;
    speedKBps?: number;
    fileIndex?: number;
    fileSize: number;
    fileName: string;
    serventIdHex: string;
    viaPeerKey?: string;
    sha1Urn?: string;
    urns?: string[];
    metadata?: string[];
    vendorCode?: string;
    needsPush?: boolean;
    busy?: boolean;
  }>;
  getShares(): Array<{ index: number; size: number; rel: string }>;
  getStatus(): {
    peers: number;
    shares: number;
    results: number;
    knownPeers: number;
  };
};

export type ParsedCli = {
  config: string;
  exec: string[];
  command: string;
};

export type PeerAddr = { host: string; port: number };
export type PeerState = Record<string, number>;
export type Route = { peerKey: string; ts: number };
type NodeMode = "leaf" | "ultrapeer";
export type PeerRole = "leaf" | "ultrapeer";

export type RemoteQrpState = {
  resetSeen: boolean;
  tableSize: number;
  infinity: number;
  entryBits: number;
  table: Uint8Array | null;
  seqSize: number;
  compressor: number;
  parts: Map<number, Buffer>;
};

export type PeerCapabilities = {
  version: string;
  headers: Record<string, string>;
  userAgent?: string;
  supportsGgep: boolean;
  supportsPongCaching: boolean;
  supportsBye: boolean;
  supportsCompression: boolean;
  supportsTls: boolean;
  compressIn: boolean;
  compressOut: boolean;
  isUltrapeer?: boolean;
  ultrapeerNeeded?: boolean;
  queryRoutingVersion?: string;
  ultrapeerQueryRoutingVersion?: string;
  isCrawler?: boolean;
  listenIp?: PeerAddr;
};

export type QueryDescriptor = {
  search: string;
  flagsRaw: number;
  requesterFirewalled: boolean;
  wantsXml: boolean;
  leafGuidedDynamic: boolean;
  ggepHAllowed: boolean;
  outOfBand: boolean;
  maxHits: number;
  urns: string[];
  xmlBlocks: string[];
  rawExtensions: Buffer;
};

export type QueryHitDescriptor = {
  hits: number;
  port: number;
  ip: string;
  speedKBps: number;
  results: Array<{
    fileIndex: number;
    fileSize: number;
    fileName: string;
    urns: string[];
    metadata: string[];
    rawExtension: Buffer;
  }>;
  vendorCode?: string;
  openDataSize?: number;
  flagGgep?: boolean;
  flagBusy?: boolean;
  flagHaveUploaded?: boolean;
  flagUploadSpeedMeasured?: boolean;
  flagPush?: boolean;
  qhdPrivateArea?: Buffer;
  serventId: Buffer;
  serventIdHex: string;
};

export type ShareFile = {
  index: number;
  name: string;
  rel: string;
  abs: string;
  size: number;
  sha1: Buffer;
  sha1Urn: string;
  keywords: string[];
};

export type SearchHit = {
  resultNo: number;
  queryIdHex: string;
  queryHops: number;
  remoteHost: string;
  remotePort: number;
  speedKBps: number;
  fileIndex: number;
  fileName: string;
  fileSize: number;
  serventIdHex: string;
  viaPeerKey: string;
  sha1Urn?: string;
  urns?: string[];
  metadata?: string[];
  vendorCode?: string;
  needsPush?: boolean;
  busy?: boolean;
};

export type PendingPush = {
  serventIdHex: string;
  result: SearchHit;
  destPath: string;
  createdAt: number;
  resolve: (v: any) => void;
  reject: (e: any) => void;
};

export type DownloadRecord = {
  at: string;
  fileName: string;
  bytes: number;
  host: string;
  port: number;
  mode: string;
  destPath: string;
};

export type ConfigDoc = {
  config: {
    listenHost: string;
    listenPort: number;
    advertisedHost?: string;
    advertisedPort?: number;
    ultrapeer: boolean;
    monitorIgnoreEvents?: string[];
    dataDir: string;
  };
  state: {
    serventIdHex: string;
    peers: PeerState;
  };
};

export type RuntimeConfig = {
  listenHost: string;
  listenPort: number;
  advertisedHost?: string;
  advertisedPort?: number;
  ultrapeer: boolean;
  monitorIgnoreEvents: string[];
  nodeMode: NodeMode;
  dataDir: string;
  downloadsDir: string;
  peers: string[];
  peerSeenThresholdSec: number;
  maxConnections: number;
  maxUltrapeerConnections: number;
  maxLeafConnections: number;
  connectTimeoutMs: number;
  pingIntervalSec: number;
  reconnectIntervalSec: number;
  rescanSharesSec: number;
  routeTtlSec: number;
  seenTtlSec: number;
  maxPayloadBytes: number;
  maxTtl: number;
  defaultPingTtl: number;
  defaultQueryTtl: number;
  advertisedSpeedKBps: number;
  downloadTimeoutMs: number;
  pushWaitMs: number;
  maxResultsPerQuery: number;
  userAgent: string;
  queryRoutingVersion: "0.1" | "0.2";
  enableCompression: boolean;
  enableQrp: boolean;
  enableBye: boolean;
  enablePongCaching: boolean;
  enableGgep: boolean;
  serveUriRes: boolean;
  vendorCode: string;
};

export type PeerInfo = {
  key: string;
  remoteLabel: string;
  outbound: boolean;
  dialTarget?: string;
  userAgent?: string;
  compression: boolean;
  tls: boolean;
};

export type NodeStatus = {
  peers: number;
  shares: number;
  results: number;
  knownPeers: number;
};

export type GnutellaEvent =
  | (EventBase<"STARTED"> & {
      listenHost: string;
      listenPort: number;
      advertisedHost: string;
      advertisedPort: number;
    })
  | (EventBase<"IDENTITY"> & {
      serventIdHex: string;
    })
  | (EventBase<"SHARES_REFRESHED"> & {
      count: number;
      totalKBytes: number;
    })
  | (EventBase<"MAINTENANCE_ERROR"> & {
      operation:
        | "SHARE_RESCAN"
        | "RECONNECT"
        | "SAVE"
        | "GWEBCACHE_UPDATE";
      message: string;
    })
  | (EventBase<"PROBE_REJECTED"> & {
      message: string;
    })
  | (EventBase<"HANDSHAKE_DEBUG"> & {
      direction: "inbound" | "outbound";
      phase: string;
      peer: string;
      message: string;
    })
  | (EventBase<"PEER_CONNECTED"> & {
      peer: PeerInfo;
    })
  | (EventBase<"PEER_DROPPED"> & {
      peer: PeerInfo;
      message: string;
    })
  | (EventBase<"PEER_MESSAGE_RECEIVED"> & {
      peer: PeerInfo;
      payloadType: number;
      payloadTypeName: string;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      payloadLength: number;
    })
  | (EventBase<"PEER_MESSAGE_SENT"> & {
      peer: PeerInfo;
      payloadType: number;
      payloadTypeName: string;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      payloadLength: number;
    })
  | (EventBase<"PONG"> & {
      ip: string;
      port: number;
      files: number;
      kbytes: number;
    })
  | (EventBase<"QUERY_RECEIVED"> & {
      peer: PeerInfo;
      descriptorIdHex: string;
      ttl: number;
      hops: number;
      search: string;
      urns: string[];
    })
  | (EventBase<"QUERY_RESULT"> & {
      hit: SearchHit;
    })
  | (EventBase<"PUSH_REQUESTED"> & {
      fileIndex: number;
      fileName: string;
      ip: string;
      port: number;
    })
  | (EventBase<"PUSH_CALLBACK_FAILED"> & {
      message: string;
    })
  | (EventBase<"PUSH_UPLOAD_FAILED"> & {
      message: string;
    })
  | (EventBase<"DOWNLOAD_SUCCEEDED"> & {
      mode: "direct" | "push";
      resultNo: number;
      fileName: string;
      destPath: string;
      remoteHost: string;
      remotePort: number;
    })
  | (EventBase<"DOWNLOAD_DIRECT_FAILED"> & {
      resultNo: number;
      fileName: string;
      destPath: string;
      remoteHost: string;
      remotePort: number;
      message: string;
    })
  | (EventBase<"PING_SENT"> & {
      descriptorIdHex: string;
      ttl: number;
    })
  | (EventBase<"QUERY_SENT"> & {
      descriptorIdHex: string;
      ttl: number;
      search: string;
    })
  | (EventBase<"QUERY_SKIPPED"> & {
      reason: "NO_PEERS_CONNECTED";
    });

export type GnutellaEventListener = (event: GnutellaEvent) => void;
export type GnutellaServentOptions = { onEvent?: GnutellaEventListener };
export type ConnectPeerResult = {
  peer: string;
  status: "connected" | "already-connected" | "dialing" | "saved";
  message?: string;
};
