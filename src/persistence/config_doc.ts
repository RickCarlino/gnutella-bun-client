import type { ConfigDoc, RuntimeConfig } from "../types";
import { trimPeerState } from "./peer_state";
import type {
  PersistedConfig,
  PersistedDoc,
  PersistedState,
} from "./types";

export function persistedConfigForRuntime(
  runtime: RuntimeConfig,
): PersistedConfig {
  const cleanConfig: PersistedConfig = {
    listen_ip: runtime.listenHost,
    listen_port: runtime.listenPort,
    gwebcache_urls: [...runtime.gwebCacheUrls],
    ultrapeer: runtime.ultrapeer,
    max_ultrapeer_connections: runtime.maxUltrapeerConnections,
    max_leaf_connections: runtime.maxLeafConnections,
    max_ttl: runtime.maxTtl,
    enable_tls: runtime.enableTls,
    data_dir: runtime.dataDir,
    downloads_dir: runtime.downloadsDir,
    incomplete_downloads_dir: runtime.incompleteDownloadsDir,
    download_queue_size: runtime.downloadQueueSize,
    download_max_active_per_host: runtime.downloadMaxActivePerHost,
    download_retry_limit: runtime.downloadRetryLimit,
    download_retry_backoff_sec: runtime.downloadRetryBackoffSec,
    verify_downloads: runtime.verifyDownloads,
  };
  if (runtime.advertisedHost)
    cleanConfig.advertised_ip = runtime.advertisedHost;
  if (
    runtime.advertisedPort != null &&
    runtime.advertisedPort !== runtime.listenPort
  ) {
    cleanConfig.advertised_port = runtime.advertisedPort;
  }
  if (runtime.blockedIps.length)
    cleanConfig.blocked_ips = runtime.blockedIps;
  if (runtime.monitorIgnoreEvents.length)
    cleanConfig.log_ignore = runtime.monitorIgnoreEvents;
  return cleanConfig;
}

export function persistedStateForDoc(
  doc: ConfigDoc,
  fallbackServentIdHex: string,
): PersistedState {
  return {
    servent_id_hex:
      typeof doc.state.serventIdHex === "string" &&
      /^[0-9a-f]{32}$/i.test(doc.state.serventIdHex)
        ? doc.state.serventIdHex.toLowerCase()
        : fallbackServentIdHex,
    peers: trimPeerState(doc.state.peers),
  };
}

export function persistedDocForRuntime(
  runtime: RuntimeConfig,
  doc: ConfigDoc,
  fallbackServentIdHex: string,
): PersistedDoc {
  return {
    config: persistedConfigForRuntime(runtime),
    state: persistedStateForDoc(doc, fallbackServentIdHex),
  };
}
