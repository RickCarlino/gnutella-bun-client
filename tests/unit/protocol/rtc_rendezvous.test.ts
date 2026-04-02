import { describe, expect, test } from "bun:test";

import {
  advertisedRtcRendezvousEndpoints,
  createRtcRendezvousState,
  sanitizeRtcRendezvousUrls,
  storeRtcRendezvousAnswer,
  storeRtcRendezvousOffer,
  takeRtcRendezvousAnswer,
  takeRtcRendezvousOffer,
} from "../../../src/protocol/rtc_rendezvous";

describe("rtc rendezvous", () => {
  test("normalizes rendezvous urls and extracts ipv4 endpoints", () => {
    const urls = sanitizeRtcRendezvousUrls([
      " http://127.0.0.1:9999/ ",
      "https://example.net/path",
      "http://example.net:8080",
      "http://127.0.0.1:9999",
    ]);
    expect(urls).toEqual(["http://127.0.0.1:9999"]);
    expect(advertisedRtcRendezvousEndpoints(urls)).toEqual([
      { host: "127.0.0.1", port: 9999 },
    ]);
  });

  test("stores one offer and answer exchange in rendezvous state", () => {
    const state = createRtcRendezvousState();
    const offer = {
      cookieHex: "11".repeat(20),
      fileIndex: 7,
      queryIdHex: "22".repeat(16),
      ridHex: "33".repeat(16),
      sdp: "v=0\r\n",
      targetServentIdHex: "44".repeat(16),
      tokenHex: "55".repeat(16),
    };

    storeRtcRendezvousOffer(state, offer);
    expect(
      takeRtcRendezvousOffer(state, offer.targetServentIdHex),
    ).toEqual(offer);
    expect(
      takeRtcRendezvousOffer(state, offer.targetServentIdHex),
    ).toBeUndefined();

    const answer = {
      ridHex: offer.ridHex,
      sdp: "v=0\r\na=answer\r\n",
    };
    expect(storeRtcRendezvousAnswer(state, answer, offer.tokenHex)).toBe(
      true,
    );
    expect(
      takeRtcRendezvousAnswer(state, offer.ridHex, offer.tokenHex),
    ).toEqual(answer);
    expect(
      takeRtcRendezvousAnswer(state, offer.ridHex, offer.tokenHex),
    ).toBeNull();
  });
});
