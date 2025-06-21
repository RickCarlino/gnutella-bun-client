export const DEFAULT_PORT = 6346;
export const TARGET_CONNECTIONS = 8;
export const HANDSHAKE_TIMEOUT = 5000;
export const CONNECTION_CHECK_INTERVAL = 10000;
export const MESSAGE_TYPES = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  QRP: 0x30,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HITS: 0x81,
};
export const QRP_VARIANTS = {
  RESET: 0,
  PATCH: 1,
};

// Message ID tracking for duplicate detection
export const seenMessages = new Map<string, number>();
export const MESSAGE_CACHE_TIME = 600000; // 10 minutes
