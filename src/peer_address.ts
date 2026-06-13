import net from "node:net";

import type { PeerAddr } from "./types";

export function normalizeIpv4(
  host: string | undefined,
): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim();
  if (net.isIPv4(trimmed)) return trimmed;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  return undefined;
}

export function normalizePeer(host: string, port: number): string {
  return `${normalizeIpv4(host) || host.trim()}:${port}`;
}

export function parsePeer(s: string): PeerAddr | null {
  const t = String(s || "").trim();
  const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(t);
  if (!m) return null;
  const host = normalizeIpv4(m[1]);
  if (!host) return null;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function ipv4Octets(host: string): number[] | null {
  const normalized = normalizeIpv4(host);
  if (!normalized) return null;
  return normalized.split(".").map((part) => Number(part));
}

type Ipv4Matcher = (parts: readonly number[]) => boolean;

const NON_ROUTABLE_IPV4_MATCHERS: Ipv4Matcher[] = [
  ([a]) => a === 0 || a >= 224,
  ([a]) => a === 10 || a === 127,
  ([a, b]) => a === 100 && b >= 64 && b <= 127,
  ([a, b]) => a === 169 && b === 254,
  ([a, b]) => a === 172 && b >= 16 && b <= 31,
  ([a, b]) => a === 192 && b === 168,
  ([a, b, c]) => a === 192 && b === 0 && c === 0,
  ([a, b, c]) => a === 192 && b === 0 && c === 2,
  ([a, b]) => a === 198 && (b === 18 || b === 19),
  ([a, b, c]) => a === 198 && b === 51 && c === 100,
  ([a, b, c]) => a === 203 && b === 0 && c === 113,
];

export function isUnspecifiedIpv4(host: string): boolean {
  return normalizeIpv4(host) === "0.0.0.0";
}

export function isRoutableIpv4(host: string): boolean {
  const parts = ipv4Octets(host);
  return (
    !!parts && !NON_ROUTABLE_IPV4_MATCHERS.some((match) => match(parts))
  );
}

export function ipv4Subnet16(host: string): string | undefined {
  const parts = ipv4Octets(host);
  if (!parts) return undefined;
  return `${parts[0]}.${parts[1]}`;
}
