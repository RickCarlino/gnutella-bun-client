import crypto from "node:crypto";

import type { PongCacheEntry } from "./types";

export function pongCacheKey(payload: Buffer): string {
  return crypto.createHash("sha1").update(payload).digest("hex");
}

export function overflowPongCacheKeys(
  entries: Iterable<[string, Pick<PongCacheEntry, "at">]>,
  maxSize: number,
): string[] {
  const all = [...entries];
  if (all.length <= maxSize) return [];
  return all
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, all.length - maxSize)
    .map(([key]) => key);
}

export function selectCachedPongPayloads(
  entries: Iterable<PongCacheEntry>,
  alreadySent: number,
  maxSent: number,
): Buffer[] {
  const available = Math.max(0, maxSent - alreadySent);
  if (available === 0) return [];
  return [...entries]
    .sort((a, b) => b.at - a.at)
    .slice(0, available)
    .map((entry) => entry.payload);
}
