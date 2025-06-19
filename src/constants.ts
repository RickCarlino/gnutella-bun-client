export enum Desc {
  "PING" = 0x00,
  "PONG" = 0x01,
  "PUSH" = 0x40,
  "QUERY" = 0x80,
  "QUERYHIT" = 0x81,
}

export const DESC_LABELS: Record<Desc, string | undefined> = {
  0x00: "PING",
  0x01: "PONG",
  0x40: "PUSH",
  0x80: "QUERY",
  0x81: "QUERYHIT",
};

export const HELLO =
  "GNUTELLA CONNECT/0.6\r\nUser-Agent: gnutella-bun/0.1\r\n\r\n";
export const OK = "GNUTELLA/0.6 200 OK\r\n\r\n";
export const DEFAULT_TTL = 5;
