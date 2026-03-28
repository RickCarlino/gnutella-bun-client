export const HEADER_LEN = 23;
export const LOCAL_ROUTE = "__local__";
export const DEFAULT_QRP_TABLE_SIZE = 65536;
export const DEFAULT_QRP_INFINITY = 7;
export const DEFAULT_QRP_ENTRY_BITS = 4;
export const DEFAULT_LISTEN_HOST = "0.0.0.0";
export const DEFAULT_LISTEN_PORT = 6346;
export const DEFAULT_USER_AGENT = "GnutellaBun/0.6";
export const DEFAULT_VENDOR_CODE = "GBUN";
export const DATA_DOWNLOADS_DIRNAME = "downloads";
export const MAX_CONNECTIONS = 12;
export const MAX_ULTRAPEER_CONNECTIONS = 4;
export const MAX_LEAF_CONNECTIONS = 24;
export const CONNECT_TIMEOUT_MS = 5000;
export const PING_INTERVAL_SEC = 60;
export const RECONNECT_INTERVAL_SEC = 15;
export const RESCAN_SHARES_SEC = 30;
export const ROUTE_TTL_SEC = 600;
export const SEEN_TTL_SEC = 600;
export const MAX_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_TTL = 7;
export const DEFAULT_PING_TTL = 1;
export const DEFAULT_QUERY_TTL = 4;
export const ADVERTISED_SPEED_KBPS = 512;
export const DOWNLOAD_TIMEOUT_MS = 15000;
export const PUSH_WAIT_MS = 15000;
export const MAX_RESULTS_PER_QUERY = 50;
export const MAX_TRACKED_PEERS = 40;
export const PEER_SEEN_THRESHOLD_SEC = 60;
export const MAX_PEER_AGE_SEC = 7 * 24 * 60 * 60;
export const GWEBCACHE_REPORT_DELAY_SEC = 5 * 60;
export const DEFAULT_QUERY_ROUTING_VERSION = "0.1";
export const ENABLE_COMPRESSION = true;
export const ENABLE_TLS = true;
export const ENABLE_QRP = true;
export const ENABLE_BYE = true;
export const ENABLE_PONG_CACHING = true;
export const ENABLE_GGEP = true;
export const SERVE_URI_RES = true;
export const QRP_COMPRESSOR_NONE = 0;
export const QRP_COMPRESSOR_DEFLATE = 1;
export const MAX_XTRY = 10;
export const BYE_DEFAULT_CODE = 200;
export const BOOTSTRAP_CONNECT_CONCURRENCY = 8;
export const BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR = 2;

export const TYPE = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  ROUTE_TABLE_UPDATE: 0x30,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HIT: 0x81,
} as const;

export const TYPE_NAME: Record<number, string> = {
  [TYPE.PING]: "PING",
  [TYPE.PONG]: "PONG",
  [TYPE.BYE]: "BYE",
  [TYPE.ROUTE_TABLE_UPDATE]: "ROUTE_TABLE_UPDATE",
  [TYPE.PUSH]: "PUSH",
  [TYPE.QUERY]: "QUERY",
  [TYPE.QUERY_HIT]: "QUERY_HIT",
};

export const CANONICAL_HEADER_NAMES: Record<string, string> = {
  "user-agent": "User-Agent",
  "x-ultrapeer": "X-Ultrapeer",
  "x-ultrapeer-needed": "X-Ultrapeer-Needed",
  "x-query-routing": "X-Query-Routing",
  "x-ultrapeer-query-routing": "X-Ultrapeer-Query-Routing",
  "accept-encoding": "Accept-Encoding",
  connection: "Connection",
  "content-encoding": "Content-Encoding",
  upgrade: "Upgrade",
  "listen-ip": "Listen-IP",
  "remote-ip": "Remote-IP",
  "pong-caching": "Pong-Caching",
  ggep: "GGEP",
  "bye-packet": "Bye-Packet",
  "x-try": "X-Try",
  "x-try-ultrapeers": "X-Try-Ultrapeers",
  "x-max-ttl": "X-Max-TTL",
  "private-data": "Private-Data",
};

export const INTERESTING_HANDSHAKE_HEADERS = [
  "server",
  "user-agent",
  "x-try",
  "x-try-ultrapeers",
  "x-ultrapeer",
  "x-ultrapeer-needed",
  "upgrade",
  "connection",
  "listen-ip",
  "remote-ip",
] as const;

export const QRP_HASH_MULTIPLIER = 0x4f1bbcdc;
export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const PROMPT_THROBBER_FRAMES = ["*", "o", ".", " "] as const;
export const PROMPT_THROBBER_INTERVAL_MS = 120;

export const CLI_HELP_LINES = [
  "help",
  "monitor",
  "status",
  "peers",
  "connect <host:port>",
  "shares",
  "results",
  "clear",
  "ping [ttl]",
  "query <search terms...>",
  "browse",
  "info <resultNo>",
  "download <resultNo> [destPath]",
  "rescan",
  "save",
  "quit",
  "sleep",
] as const;

export const RESULT_NAME_WIDTH_MAX = 48;
