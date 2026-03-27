export const HEADER_LEN = 23;
export const LOCAL_ROUTE = "__local__";
export const DEFAULT_QRP_TABLE_SIZE = 65536;
export const DEFAULT_QRP_INFINITY = 7;
export const DEFAULT_QRP_ENTRY_BITS = 4;
export const DEFAULT_USER_AGENT = "GnutellaBun/0.6";
export const DEFAULT_VENDOR_CODE = "GBUN";
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
  "content-encoding": "Content-Encoding",
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
  "listen-ip",
  "remote-ip",
] as const;

export const QRP_HASH_MULTIPLIER = 0x4f1bbcdc;
export const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const PROMPT_THROBBER_FRAMES = ["*", "o", ".", " "] as const;
export const PROMPT_THROBBER_INTERVAL_MS = 120;

export const CLI_HELP_LINES = [
  "help",
  "status",
  "peers",
  "connect <host:port>",
  "shares",
  "results",
  "clear",
  "ping [ttl]",
  "query <search terms...>",
  "download <resultNo> [destPath]",
  "rescan",
  "save",
  "quit",
  "sleep",
] as const;

export const RESULT_NAME_WIDTH_MAX = 48;
