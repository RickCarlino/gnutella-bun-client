import { normalizePeer, parsePeer } from "../peer_address";
import type {
  BootstrapAttemptSummary,
  FreshPeerCandidateFetchInput,
  PeerCandidate,
  TimestampedPeerCandidate,
} from "./types";

export function normalizePeerCandidates(
  peers: readonly string[],
  isSelfPeer?: (host: string, port: number) => boolean,
): PeerCandidate[] {
  const out: PeerCandidate[] = [];
  const seen = new Set<string>();

  for (const peer of peers) {
    const parsed = parsePeer(peer);
    if (!parsed) continue;
    if (isSelfPeer?.(parsed.host, parsed.port)) continue;

    const normalized = normalizePeer(parsed.host, parsed.port);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      host: parsed.host,
      port: parsed.port,
      peer: normalized,
    });
  }

  return out;
}

export function peerCandidateSetKey(
  candidates: readonly PeerCandidate[],
): string {
  return candidates
    .map((peer) => peer.peer)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

export function exhaustedPeerSet(
  candidates: readonly PeerCandidate[],
  attempt: BootstrapAttemptSummary,
): boolean {
  return (
    candidates.length === 0 ||
    attempt.attemptedPeers.length >= candidates.length
  );
}

export function shouldFetchFreshPeerCandidates(
  input: FreshPeerCandidateFetchInput,
): boolean {
  if (!exhaustedPeerSet(input.candidates, input.initialAttempt)) {
    return false;
  }
  if (input.state?.active) return false;
  return input.state?.lastExhaustedPeerSet !== input.candidateKey;
}

export function addPeerCandidatesToKnownSet(
  candidates: readonly PeerCandidate[],
  knownPeers: Set<string>,
): string[] {
  const addedPeers: string[] = [];
  for (const candidate of candidates) {
    if (knownPeers.has(candidate.peer)) continue;
    knownPeers.add(candidate.peer);
    addedPeers.push(candidate.peer);
  }
  return addedPeers;
}

export function rankPeerCandidatesByLastSeen<
  T extends TimestampedPeerCandidate,
>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => b.lastSeen - a.lastSeen);
}
