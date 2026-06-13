import { MAX_TRACKED_PEERS } from "../const";
import { normalizeIpv4, normalizePeer, parsePeer } from "../peer_address";
import { rankPeerCandidatesByLastSeen } from "../peer_discovery";
import type { PeerState } from "../types";

function normalizePeerTimestamp(value: unknown): number {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, Math.floor(ts));
}

export function normalizePeerState(value: unknown): PeerState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return {};

  const out = new Map<string, number>();
  for (const [peerSpec, rawTimestamp] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const addr = parsePeer(peerSpec);
    if (!addr) continue;
    const peer = normalizePeer(addr.host, addr.port);
    const timestamp = normalizePeerTimestamp(rawTimestamp);
    const current = out.get(peer) ?? 0;
    if (!out.has(peer) || timestamp > current) out.set(peer, timestamp);
  }

  return Object.fromEntries(out);
}

export function sortPeerStateEntries(
  peers: PeerState,
): Array<[peer: string, lastSeen: number]> {
  return rankPeerCandidatesByLastSeen(
    Object.entries(normalizePeerState(peers)).map(([peer, lastSeen]) => ({
      peer,
      lastSeen,
    })),
  ).map(({ peer, lastSeen }) => [peer, lastSeen]);
}

export function trimPeerState(
  peers: PeerState,
  limit = MAX_TRACKED_PEERS,
): PeerState {
  if (limit <= 0) return {};
  return Object.fromEntries(sortPeerStateEntries(peers).slice(0, limit));
}

export function filterBlockedPeerState(
  peers: PeerState,
  blockedIps: readonly string[],
): PeerState {
  const blocked = new Set(
    blockedIps
      .map((entry) => normalizeIpv4(entry))
      .filter((entry): entry is string => !!entry),
  );
  if (!blocked.size) return trimPeerState(peers);
  return Object.fromEntries(
    sortPeerStateEntries(peers).filter(([peer]) => {
      const addr = parsePeer(peer);
      const host = normalizeIpv4(addr?.host);
      return !host || !blocked.has(host);
    }),
  );
}

export function rememberPeerInState(
  peers: PeerState,
  peerSpec: string,
  timestamp = 0,
): PeerState {
  const addr = parsePeer(peerSpec);
  if (!addr) return trimPeerState(peers);

  const peer = normalizePeer(addr.host, addr.port);
  const current = normalizePeerState(peers);
  const existing = current[peer];
  const nextTimestamp = Math.max(
    existing ?? 0,
    normalizePeerTimestamp(timestamp),
  );
  const shouldPromote =
    existing == null ||
    nextTimestamp > existing ||
    (existing === 0 && nextTimestamp === 0);

  if (!shouldPromote) return trimPeerState(current);

  return trimPeerState(
    Object.fromEntries([
      [peer, nextTimestamp],
      ...Object.entries(current).filter(
        ([candidate]) => candidate !== peer,
      ),
    ]),
  );
}

export function peerStateTargets(peers: PeerState): string[] {
  return sortPeerStateEntries(peers).map(([peer]) => peer);
}

export function peerStateEquals(a: PeerState, b: PeerState): boolean {
  const aEntries = sortPeerStateEntries(a);
  const bEntries = sortPeerStateEntries(b);
  if (aEntries.length !== bEntries.length) return false;
  return aEntries.every(
    ([peer, lastSeen], index) =>
      bEntries[index]?.[0] === peer && bEntries[index]?.[1] === lastSeen,
  );
}
