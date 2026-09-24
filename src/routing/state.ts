import { LOCAL_ROUTE } from "../const";
import type { Route } from "../types";
import { seenKey } from "./descriptors/seen";
import type { MessageRouter } from "./router";

/** Record a descriptor's deduplication key and arrival time. */
export function markSeen(
  router: MessageRouter,
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): void {
  router.seen.set(
    seenKey(payloadType, descriptorIdHex, payload),
    router.now(),
  );
}

/** Check whether a descriptor's deduplication key is known. */
export function hasSeen(
  router: MessageRouter,
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): boolean {
  return router.seen.has(seenKey(payloadType, descriptorIdHex, payload));
}

/** Remove expired descriptor deduplication entries. */
export function pruneSeenEntries(
  router: MessageRouter,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, at] of router.seen) {
    if (now - at > maxAgeMs) router.seen.delete(key);
  }
}

/** Remove expired forwarding routes, preserving local routes. */
export function pruneRouteEntries(
  _router: MessageRouter,
  routes: Map<string, Route | typeof LOCAL_ROUTE>,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, route] of routes) {
    if (route !== LOCAL_ROUTE && now - route.ts > maxAgeMs)
      routes.delete(key);
  }
}

/** Remove expired servent-to-peer push routes. */
export function prunePushRoutes(
  router: MessageRouter,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, route] of router.pushRoutes) {
    if (now - route.ts > maxAgeMs) router.pushRoutes.delete(key);
  }
}

/** Remove expired cached pong payloads. */
export function prunePongCache(
  router: MessageRouter,
  now: number,
  maxAgeMs: number,
): void {
  for (const [key, entry] of router.pongCache) {
    if (now - entry.at > maxAgeMs) router.pongCache.delete(key);
  }
}
