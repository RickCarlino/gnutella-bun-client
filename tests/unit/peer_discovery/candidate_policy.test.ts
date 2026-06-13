import { describe, expect, test } from "bun:test";

import {
  addPeerCandidatesToKnownSet,
  exhaustedPeerSet,
  normalizePeerCandidates,
  peerCandidateSetKey,
  rankPeerCandidatesByLastSeen,
  shouldFetchFreshPeerCandidates,
} from "../../../src/peer_discovery";

describe("peer discovery candidate policy", () => {
  test("normalizes, deduplicates, and filters peer candidates", () => {
    expect(
      normalizePeerCandidates(
        [
          "66.132.55.12:6346",
          "66.132.55.12:6346",
          "::ffff:66.132.55.12:6346",
          "bad",
          "72.14.201.10:6346",
        ],
        (host, port) => host === "72.14.201.10" && port === 6346,
      ),
    ).toEqual([
      { host: "66.132.55.12", port: 6346, peer: "66.132.55.12:6346" },
    ]);
  });

  test("keys peer sets independently from candidate order", () => {
    const candidates = normalizePeerCandidates([
      "72.14.201.10:6346",
      "66.132.55.12:6346",
    ]);

    expect(peerCandidateSetKey(candidates)).toBe(
      "66.132.55.12:6346,72.14.201.10:6346",
    );
  });

  test("detects exhausted peer sets and repeated bootstrap suppression", () => {
    const candidates = normalizePeerCandidates([
      "66.132.55.12:6346",
      "72.14.201.10:6346",
    ]);
    const candidateKey = peerCandidateSetKey(candidates);

    expect(
      exhaustedPeerSet(candidates, {
        attemptedPeers: ["66.132.55.12:6346"],
      }),
    ).toBe(false);
    expect(
      exhaustedPeerSet(candidates, {
        attemptedPeers: ["66.132.55.12:6346", "72.14.201.10:6346"],
      }),
    ).toBe(true);
    expect(
      shouldFetchFreshPeerCandidates({
        candidates,
        candidateKey,
        initialAttempt: {
          attemptedPeers: ["66.132.55.12:6346", "72.14.201.10:6346"],
        },
        state: {},
      }),
    ).toBe(true);
    expect(
      shouldFetchFreshPeerCandidates({
        candidates,
        candidateKey,
        initialAttempt: {
          attemptedPeers: ["66.132.55.12:6346", "72.14.201.10:6346"],
        },
        state: { lastExhaustedPeerSet: candidateKey },
      }),
    ).toBe(false);
    expect(
      shouldFetchFreshPeerCandidates({
        candidates,
        candidateKey,
        initialAttempt: {
          attemptedPeers: ["66.132.55.12:6346", "72.14.201.10:6346"],
        },
        state: { active: true },
      }),
    ).toBe(false);
  });

  test("adds only new discovered peers to the known set", () => {
    const known = new Set(["66.132.55.12:6346"]);
    const candidates = normalizePeerCandidates([
      "66.132.55.12:6346",
      "72.14.201.10:6346",
    ]);

    expect(addPeerCandidatesToKnownSet(candidates, known)).toEqual([
      "72.14.201.10:6346",
    ]);
    expect([...known]).toEqual(["66.132.55.12:6346", "72.14.201.10:6346"]);
  });

  test("prioritizes stable peers by newest last-seen timestamp", () => {
    expect(
      rankPeerCandidatesByLastSeen([
        { peer: "old", lastSeen: 10 },
        { peer: "zero", lastSeen: 0 },
        { peer: "new", lastSeen: 20 },
      ]),
    ).toEqual([
      { peer: "new", lastSeen: 20 },
      { peer: "old", lastSeen: 10 },
      { peer: "zero", lastSeen: 0 },
    ]);
  });
});
