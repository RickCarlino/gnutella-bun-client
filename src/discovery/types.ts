export type PeerCandidate = {
  host: string;
  port: number;
  peer: string;
};

export type BootstrapAttemptSummary = {
  attemptedPeers: readonly string[];
};

type DiscoveryBootstrapState = {
  active?: boolean;
  lastExhaustedPeerSet?: string;
};

export type FreshPeerCandidateFetchInput = {
  candidates: readonly PeerCandidate[];
  initialAttempt: BootstrapAttemptSummary;
  candidateKey: string;
  state?: DiscoveryBootstrapState;
};

export type TimestampedPeerCandidate = {
  peer: string;
  lastSeen: number;
};
