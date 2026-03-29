import net from "node:net";
import path from "node:path";

import { LOCAL_ROUTE } from "../const";
import {
  connectBootstrapPeers,
  reportSelfToGWebCaches,
  type GWebCacheBootstrapState,
} from "../gwebcache_client";
import { sleep } from "../shared";
import type {
  ConfigDoc,
  DownloadRecord,
  GnutellaServentCollaboratorOverrides,
  GnutellaServentCollaborators,
  GnutellaEventListener,
  GnutellaServentOptions,
  PendingPush,
  Route,
  RuntimeConfig,
  SearchHit,
  ShareFile,
} from "../types";
import { fromHex16, randomId16, rawHex16 } from "./core_utils";
import {
  applyRuntimeConfigPatch,
  configDocForRuntime,
  runtimeConfigFor,
} from "./peer_state";
import * as handshake from "./node_handshake";
import * as lifecycle from "./node_lifecycle";
import * as protocolRuntime from "./node_protocol_runtime";
import * as state from "./node_state";
import * as tlsSupport from "./node_tls";
import * as topology from "./node_topology";
import * as transfer from "./node_transfer";
import type { Peer } from "./node_types";
import { QrpTable } from "./qrp";

type BoundMethods<T extends Record<string, unknown>> = {
  [K in keyof T as T[K] extends (...args: infer AllArgs) => unknown
    ? AllArgs extends [unknown, ...unknown[]]
      ? K
      : never
    : never]: T[K] extends (...args: infer AllArgs) => infer Result
    ? AllArgs extends [unknown, ...infer Rest]
      ? (...args: Rest) => Result
      : never
    : never;
};

function bindNodeMethods<T extends Record<string, unknown>>(
  mod: T,
): BoundMethods<T> {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== "function") continue;
    out[name] = function (this: GnutellaServent, ...args: unknown[]) {
      return (
        fn as (node: GnutellaServent, ...args: unknown[]) => unknown
      )(this, ...args);
    };
  }
  return out as BoundMethods<T>;
}

function defaultCollaborators(): GnutellaServentCollaborators {
  return {
    clock: {
      now: () => Date.now(),
    },
    scheduler: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (timer) => clearInterval(timer),
      sleep,
    },
    netFactory: {
      createConnection: (options) => net.createConnection(options),
      createServer: (listener) => net.createServer(listener),
    },
    bootstrapClient: {
      connectBootstrapPeers,
      reportSelfToGWebCaches,
    },
  };
}

function buildCollaborators(
  overrides?: GnutellaServentCollaboratorOverrides,
): GnutellaServentCollaborators {
  const defaults = defaultCollaborators();
  return {
    clock: { ...defaults.clock, ...overrides?.clock },
    scheduler: { ...defaults.scheduler, ...overrides?.scheduler },
    netFactory: { ...defaults.netFactory, ...overrides?.netFactory },
    bootstrapClient: {
      ...defaults.bootstrapClient,
      ...overrides?.bootstrapClient,
    },
  };
}

const nodeCoreMethods = {
  randomId16(_node: GnutellaServent): Buffer {
    return randomId16();
  },
  rawHex16(_node: GnutellaServent, hex: string): Buffer {
    return rawHex16(hex);
  },
  now(node: GnutellaServent): number {
    return node.collaborators.clock.now();
  },
  sleep(node: GnutellaServent, ms: number): Promise<void> {
    return node.collaborators.scheduler.sleep(ms);
  },
  createConnection(
    node: GnutellaServent,
    options: net.NetConnectOpts,
  ): net.Socket {
    return node.collaborators.netFactory.createConnection(options);
  },
  createServer(
    node: GnutellaServent,
    listener: (socket: net.Socket) => void,
  ): net.Server {
    return node.collaborators.netFactory.createServer(listener);
  },
  connectBootstrapPeers(
    node: GnutellaServent,
    options: Parameters<
      GnutellaServentCollaborators["bootstrapClient"]["connectBootstrapPeers"]
    >[0],
  ) {
    return node.collaborators.bootstrapClient.connectBootstrapPeers(
      options,
    );
  },
  reportSelfToGWebCaches(
    node: GnutellaServent,
    options: Parameters<
      GnutellaServentCollaborators["bootstrapClient"]["reportSelfToGWebCaches"]
    >[0],
  ) {
    return node.collaborators.bootstrapClient.reportSelfToGWebCaches(
      options,
    );
  },
  updateRuntimeConfig(
    node: GnutellaServent,
    patch: Partial<RuntimeConfig>,
  ): RuntimeConfig {
    node.runtimeConfig = applyRuntimeConfigPatch(
      node.runtimeConfig,
      patch,
    );
    node.doc.config = configDocForRuntime(node.runtimeConfig);
    return node.runtimeConfig;
  },
};

type CoreMethods = BoundMethods<typeof nodeCoreMethods>;
type StateMethods = BoundMethods<typeof state>;
type LifecycleMethods = BoundMethods<typeof lifecycle>;
type HandshakeMethods = BoundMethods<typeof handshake>;
type ProtocolRuntimeMethods = BoundMethods<typeof protocolRuntime>;
type TopologyMethods = BoundMethods<typeof topology>;
type TlsMethods = BoundMethods<typeof tlsSupport>;
type TransferMethods = BoundMethods<typeof transfer>;

export class GnutellaServent {
  configPath: string;
  doc: ConfigDoc;
  persistedState: ConfigDoc["state"];
  runtimeConfig: RuntimeConfig;
  collaborators: GnutellaServentCollaborators;
  serventId: Buffer;
  server: net.Server | null = null;
  peers = new Map<string, Peer>();
  dialing = new Set<string>();
  peerSeq = 0;
  shares: ShareFile[] = [];
  sharesByIndex = new Map<number, ShareFile>();
  sharesByUrn = new Map<string, ShareFile>();
  seen = new Map<string, number>();
  pingRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  queryRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  pushRoutes = new Map<string, Route>();
  lastResults: SearchHit[] = [];
  resultSeq = 1;
  downloads: DownloadRecord[] = [];
  pendingPushes = new Map<string, PendingPush[]>();
  activeAutoDownloadPaths = new Set<string>();
  timers: NodeJS.Timeout[] = [];
  timeouts: NodeJS.Timeout[] = [];
  stopped = false;
  listeners = new Set<GnutellaEventListener>();
  qrpTable = new QrpTable();
  pongCache = new Map<string, { payload: Buffer; at: number }>();
  gwebCacheBootstrapState: GWebCacheBootstrapState = {};
  gwebCacheReportTimer?: NodeJS.Timeout;
  gwebCacheReportAttempted = false;
  gwebCacheReported = false;
  learnedAdvertisedHost?: string;
  pendingAdvertisedHost?: string;
  pendingAdvertisedSubnets = new Set<string>();
  declare randomId16: CoreMethods["randomId16"];
  declare rawHex16: CoreMethods["rawHex16"];
  declare now: CoreMethods["now"];
  declare sleep: CoreMethods["sleep"];
  declare createConnection: CoreMethods["createConnection"];
  declare createServer: CoreMethods["createServer"];
  declare connectBootstrapPeers: CoreMethods["connectBootstrapPeers"];
  declare reportSelfToGWebCaches: CoreMethods["reportSelfToGWebCaches"];
  declare updateRuntimeConfig: CoreMethods["updateRuntimeConfig"];
  declare subscribe: StateMethods["subscribe"];
  declare emitEvent: StateMethods["emitEvent"];
  declare emitMaintenanceError: StateMethods["emitMaintenanceError"];
  declare schedule: StateMethods["schedule"];
  declare scheduleOnce: StateMethods["scheduleOnce"];
  declare cancelTimeout: StateMethods["cancelTimeout"];
  declare peerInfo: StateMethods["peerInfo"];
  declare peerCount: StateMethods["peerCount"];
  declare config: StateMethods["config"];
  declare configuredAdvertisedHost: StateMethods["configuredAdvertisedHost"];
  declare currentAdvertisedPort: StateMethods["currentAdvertisedPort"];
  declare currentAdvertisedHost: StateMethods["currentAdvertisedHost"];
  declare selfHosts: StateMethods["selfHosts"];
  declare isSelfPeer: StateMethods["isSelfPeer"];
  declare maybeObserveAdvertisedHost: StateMethods["maybeObserveAdvertisedHost"];
  declare trackPendingAdvertisedHost: StateMethods["trackPendingAdvertisedHost"];
  declare absorbHandshakeHeaders: StateMethods["absorbHandshakeHeaders"];
  declare save: StateMethods["save"];
  declare refreshShares: StateMethods["refreshShares"];
  declare totalSharedKBytes: StateMethods["totalSharedKBytes"];
  declare addKnownPeer: StateMethods["addKnownPeer"];
  declare updateKnownPeerLastSeen: StateMethods["updateKnownPeerLastSeen"];
  declare peerSeenTimestamp: StateMethods["peerSeenTimestamp"];
  declare pruneExpiredKnownPeers: StateMethods["pruneExpiredKnownPeers"];
  declare shouldBootstrapFreshPeers: StateMethods["shouldBootstrapFreshPeers"];
  declare rememberPeerAddresses: StateMethods["rememberPeerAddresses"];
  declare markPeerSeenIfStable: StateMethods["markPeerSeenIfStable"];
  declare scheduleGWebCacheReport: StateMethods["scheduleGWebCacheReport"];
  declare refreshGWebCacheReport: StateMethods["refreshGWebCacheReport"];
  declare announceSelfToGWebCaches: StateMethods["announceSelfToGWebCaches"];
  declare peerDialState: StateMethods["peerDialState"];
  declare connectToPeer: StateMethods["connectToPeer"];
  declare markSeen: StateMethods["markSeen"];
  declare hasSeen: StateMethods["hasSeen"];
  declare pruneSeenEntries: StateMethods["pruneSeenEntries"];
  declare pruneRouteEntries: StateMethods["pruneRouteEntries"];
  declare prunePushRoutes: StateMethods["prunePushRoutes"];
  declare prunePendingPushQueues: StateMethods["prunePendingPushQueues"];
  declare prunePongCache: StateMethods["prunePongCache"];
  declare pruneMaps: StateMethods["pruneMaps"];
  declare getPeers: StateMethods["getPeers"];
  declare getShares: StateMethods["getShares"];
  declare getResults: StateMethods["getResults"];
  declare clearResults: StateMethods["clearResults"];
  declare getKnownPeers: StateMethods["getKnownPeers"];
  declare getDownloads: StateMethods["getDownloads"];
  declare getServentIdHex: StateMethods["getServentIdHex"];
  declare getStatus: StateMethods["getStatus"];
  declare reserveAutoDownloadPath: StateMethods["reserveAutoDownloadPath"];
  declare start: LifecycleMethods["start"];
  declare stop: LifecycleMethods["stop"];
  declare startServer: LifecycleMethods["startServer"];
  declare connectKnownPeers: LifecycleMethods["connectKnownPeers"];
  declare connectPeer: LifecycleMethods["connectPeer"];
  declare tlsEnabled: TlsMethods["tlsEnabled"];
  declare socketUsesTls: TlsMethods["socketUsesTls"];
  declare canUpgradeSocketToTls: TlsMethods["canUpgradeSocketToTls"];
  declare peerRequestedTlsUpgrade: TlsMethods["peerRequestedTlsUpgrade"];
  declare peerAcceptedTlsUpgrade: TlsMethods["peerAcceptedTlsUpgrade"];
  declare clientAcceptedTlsUpgrade: TlsMethods["clientAcceptedTlsUpgrade"];
  declare tlsUpgradeToken: TlsMethods["tlsUpgradeToken"];
  declare upgradeSocketToTls: TlsMethods["upgradeSocketToTls"];
  declare baseHandshakeHeaders: HandshakeMethods["baseHandshakeHeaders"];
  declare buildServerHandshakeHeaders: HandshakeMethods["buildServerHandshakeHeaders"];
  declare buildClientFinalHeaders: HandshakeMethods["buildClientFinalHeaders"];
  declare buildCapabilities: HandshakeMethods["buildCapabilities"];
  declare selectTryPeers: HandshakeMethods["selectTryPeers"];
  declare maybeAbsorbTryHeaders: HandshakeMethods["maybeAbsorbTryHeaders"];
  declare reject06: HandshakeMethods["reject06"];
  declare handleProbe: HandshakeMethods["handleProbe"];
  declare handleUndecidedProbe: HandshakeMethods["handleUndecidedProbe"];
  declare handleInbound06Probe: HandshakeMethods["handleInbound06Probe"];
  declare rejectLegacyInboundProbe: HandshakeMethods["rejectLegacyInboundProbe"];
  declare startHttpProbeSession: HandshakeMethods["startHttpProbeSession"];
  declare startGivProbeSession: HandshakeMethods["startGivProbeSession"];
  declare finishInbound06Probe: HandshakeMethods["finishInbound06Probe"];
  declare tryDecideProbe: HandshakeMethods["tryDecideProbe"];
  declare connectPeer06: HandshakeMethods["connectPeer06"];
  declare nodeMode: TopologyMethods["nodeMode"];
  declare classifyPeerRole: TopologyMethods["classifyPeerRole"];
  declare peerRole: TopologyMethods["peerRole"];
  declare countPeersByRole: TopologyMethods["countPeersByRole"];
  declare connectedLeafCount: TopologyMethods["connectedLeafCount"];
  declare connectedMeshPeerCount: TopologyMethods["connectedMeshPeerCount"];
  declare availableDialSlots: TopologyMethods["availableDialSlots"];
  declare canAcceptPeerRole: TopologyMethods["canAcceptPeerRole"];
  declare shouldRelayQueries: TopologyMethods["shouldRelayQueries"];
  declare shouldRelayPings: TopologyMethods["shouldRelayPings"];
  declare isLeafPeer: TopologyMethods["isLeafPeer"];
  declare isMeshPeer: TopologyMethods["isMeshPeer"];
  declare attachPeer: ProtocolRuntimeMethods["attachPeer"];
  declare startHttpSession: ProtocolRuntimeMethods["startHttpSession"];
  declare pendingHttpSessionHeadEnd: ProtocolRuntimeMethods["pendingHttpSessionHeadEnd"];
  declare shiftHttpSessionHead: ProtocolRuntimeMethods["shiftHttpSessionHead"];
  declare processHttpSessionRequests: ProtocolRuntimeMethods["processHttpSessionRequests"];
  declare drainHttpSession: ProtocolRuntimeMethods["drainHttpSession"];
  declare consumePeerBuffer: ProtocolRuntimeMethods["consumePeerBuffer"];
  declare validateDescriptor: ProtocolRuntimeMethods["validateDescriptor"];
  declare sendRaw: ProtocolRuntimeMethods["sendRaw"];
  declare sendToPeer: ProtocolRuntimeMethods["sendToPeer"];
  declare forwardToRoute: ProtocolRuntimeMethods["forwardToRoute"];
  declare broadcast: ProtocolRuntimeMethods["broadcast"];
  declare broadcastQuery: ProtocolRuntimeMethods["broadcastQuery"];
  declare normalizeQueryLifetime: ProtocolRuntimeMethods["normalizeQueryLifetime"];
  declare isIndexQuery: ProtocolRuntimeMethods["isIndexQuery"];
  declare shouldIgnoreQuery: ProtocolRuntimeMethods["shouldIgnoreQuery"];
  declare enqueuePendingPush: ProtocolRuntimeMethods["enqueuePendingPush"];
  declare shiftPendingPush: ProtocolRuntimeMethods["shiftPendingPush"];
  declare cachePongPayload: ProtocolRuntimeMethods["cachePongPayload"];
  declare shouldIgnoreDescriptor: ProtocolRuntimeMethods["shouldIgnoreDescriptor"];
  declare onPingDescriptor: ProtocolRuntimeMethods["onPingDescriptor"];
  declare onQueryDescriptor: ProtocolRuntimeMethods["onQueryDescriptor"];
  declare dispatchDescriptor: ProtocolRuntimeMethods["dispatchDescriptor"];
  declare handleDescriptor: ProtocolRuntimeMethods["handleDescriptor"];
  declare onRouteTableUpdate: ProtocolRuntimeMethods["onRouteTableUpdate"];
  declare sendQrpTable: ProtocolRuntimeMethods["sendQrpTable"];
  declare sendBye: ProtocolRuntimeMethods["sendBye"];
  declare respondPong: ProtocolRuntimeMethods["respondPong"];
  declare respondQueryHit: ProtocolRuntimeMethods["respondQueryHit"];
  declare onPong: ProtocolRuntimeMethods["onPong"];
  declare onQueryHit: ProtocolRuntimeMethods["onQueryHit"];
  declare onPush: ProtocolRuntimeMethods["onPush"];
  declare onBye: ProtocolRuntimeMethods["onBye"];
  declare fulfillPush: ProtocolRuntimeMethods["fulfillPush"];
  declare handleIncomingGet: TransferMethods["handleIncomingGet"];
  declare parseExistingGetRequest: TransferMethods["parseExistingGetRequest"];
  declare writeInvalidRangeResponse: TransferMethods["writeInvalidRangeResponse"];
  declare existingGetBodyLength: TransferMethods["existingGetBodyLength"];
  declare buildExistingGetResponseHeaders: TransferMethods["buildExistingGetResponseHeaders"];
  declare finishExistingGetResponse: TransferMethods["finishExistingGetResponse"];
  declare streamExistingGetBody: TransferMethods["streamExistingGetBody"];
  declare handleExistingGet: TransferMethods["handleExistingGet"];
  declare handleIncomingGiv: TransferMethods["handleIncomingGiv"];
  declare downloadOverSocket: TransferMethods["downloadOverSocket"];
  declare directDownloadViaRequest: TransferMethods["directDownloadViaRequest"];
  declare directDownload: TransferMethods["directDownload"];
  declare initializeHttpDownloadState: TransferMethods["initializeHttpDownloadState"];
  declare writeHttpDownloadBody: TransferMethods["writeHttpDownloadBody"];
  declare consumeHttpDownloadChunk: TransferMethods["consumeHttpDownloadChunk"];
  declare readHttpDownload: TransferMethods["readHttpDownload"];
  declare sendPush: TransferMethods["sendPush"];
  declare downloadResult: TransferMethods["downloadResult"];
  declare sendPing: TransferMethods["sendPing"];
  declare sendQuery: TransferMethods["sendQuery"];

  constructor(
    configPath: string,
    doc: ConfigDoc,
    options: GnutellaServentOptions = {},
  ) {
    this.configPath = path.resolve(configPath);
    this.doc = doc;
    this.persistedState = this.doc.state;
    this.runtimeConfig = applyRuntimeConfigPatch(
      runtimeConfigFor(this.configPath, doc),
      options.runtimeConfig || {},
    );
    this.doc.config = configDocForRuntime(this.runtimeConfig);
    this.collaborators = buildCollaborators(options.collaborators);
    this.serventId = fromHex16(doc.state.serventIdHex);
    if (options.onEvent) this.listeners.add(options.onEvent);
  }
}

Object.assign(
  GnutellaServent.prototype,
  bindNodeMethods(nodeCoreMethods),
  bindNodeMethods(state),
  bindNodeMethods(lifecycle),
  bindNodeMethods(tlsSupport),
  bindNodeMethods(handshake),
  bindNodeMethods(topology),
  bindNodeMethods(protocolRuntime),
  bindNodeMethods(transfer),
);
