import type { DescriptorLifetime } from "./types";

export function normalizeQueryLifetime(
  ttl: number,
  hops: number,
  maxTtl: number,
): DescriptorLifetime | null {
  if (ttl > 15) return null;
  const maxLife = Math.max(1, maxTtl);
  if (hops > maxLife) return null;
  return { ttl: Math.max(0, Math.min(ttl, maxLife - hops)), hops };
}

export function forwardedDescriptorLifetime(
  ttl: number,
  hops: number,
): DescriptorLifetime | undefined {
  if (ttl <= 0) return undefined;
  return { ttl: Math.max(0, ttl - 1), hops: hops + 1 };
}

export function pongReplyTtl(hops: number): number {
  return Math.max(1, hops);
}

export function queryHitReplyTtl(hops: number, maxTtl: number): number {
  return Math.min(maxTtl, Math.max(1, hops + 2));
}

export function shouldRelayPing(
  ttl: number,
  now: number,
  lastPingAt: number,
  minIntervalMs: number,
): boolean {
  return ttl > 1 && now - lastPingAt >= minIntervalMs;
}
