type HandshakeNodeMode = "leaf" | "ultrapeer";

export type LocalHandshakePolicy = {
  userAgent?: string;
  advertisedHost: string;
  advertisedPort: number;
  maxTtl: number;
  nodeMode: HandshakeNodeMode;
  maxUltrapeerConnections: number;
  maxLeafConnections: number;
  connectedMeshPeerCount: number;
  connectedLeafCount: number;
  enableQrp: boolean;
  queryRoutingVersion?: string;
  enableCompression: boolean;
  enablePongCaching: boolean;
  enableGgep: boolean;
  enableBye: boolean;
  tlsEnabled: boolean;
  tlsUpgradeToken: string;
};

export type CapabilityPolicy = {
  version: string;
  headers: Record<string, string>;
  compressIn: boolean;
  compressOut: boolean;
  tlsEnabled: boolean;
  tlsUpgradeToken: string;
};

export type RejectHandshakePolicy = {
  extraHeaders?: Record<string, string>;
  remoteIp?: string;
  tryPeers?: string[];
};
