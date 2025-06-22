export const DEFAULT_PORT = 6346;
export const TARGET_CONNECTIONS = 8;
export const HANDSHAKE_TIMEOUT = 5000;
export const CONNECTION_CHECK_INTERVAL = 10000;
export const MESSAGE_TYPES = {
  PING: 0x00,
  PONG: 0x01,
  BYE: 0x02,
  PUSH: 0x40,
  QUERY: 0x80,
  QUERY_HITS: 0x81,
  ROUTE_TABLE_UPDATE: 0x30,
};
export const SERVENT_ID = Buffer.from([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10
]);

// Message ID tracking for duplicate detection
export const seenMessages = new Map<string, number>();
export const MESSAGE_CACHE_TIME = 600000; // 10 minutes
