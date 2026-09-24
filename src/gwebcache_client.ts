export {
  connectBootstrapPeers,
  fetchBootstrapData,
  getMorePeers,
  reportSelfToGWebCaches,
} from "./discovery/gwebcache/bootstrap";
export {
  buildGWebCacheUrl,
  parseGWebCacheResponse,
  requestGWebCache,
} from "./discovery/gwebcache/response";
export { KNOWN_CACHES } from "./discovery/gwebcache/types";
export type { GWebCacheBootstrapState } from "./discovery/gwebcache/types";
