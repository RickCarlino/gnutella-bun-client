import { afterEach, describe, expect, test } from "bun:test";

import { startRtcRelayServer } from "../../bin/rtc_relay";
import {
  fetchBootstrapData,
  reportSelfToGWebCaches,
  requestGWebCache,
} from "../../src/gwebcache_client";

const OFFER_HEADERS = {
  "content-type": "application/sdp",
  "x-rtc-cookie": "11".repeat(20),
  "x-rtc-file-index": "7",
  "x-rtc-query-id": "22".repeat(16),
  "x-rtc-rid": "33".repeat(16),
  "x-rtc-target": "44".repeat(16),
  "x-rtc-token": "55".repeat(16),
} as const;

const OFFER_SDP = "v=0\r\na=offer\r\n";
const ANSWER_SDP = "v=0\r\na=answer\r\n";

let relay: Awaited<ReturnType<typeof startRtcRelayServer>> | undefined;

async function startRelay() {
  relay = await startRtcRelayServer({
    host: "127.0.0.1",
    port: 0,
  });
  return relay;
}

afterEach(async () => {
  if (!relay) return;
  await relay.stop();
  relay = undefined;
});

describe("rtc relay", () => {
  test("relays one offer and answer exchange without a node", async () => {
    const { url } = await startRelay();

    const accepted = await fetch(`${url}/rtc/offer`, {
      body: OFFER_SDP,
      headers: OFFER_HEADERS,
      method: "POST",
    });
    expect(accepted.status).toBe(202);

    const offer = await fetch(
      `${url}/rtc/offer?target=${OFFER_HEADERS["x-rtc-target"]}`,
    );
    expect(offer.status).toBe(200);
    expect(offer.headers.get("content-type")).toBe("application/sdp");
    expect(offer.headers.get("x-rtc-cookie")).toBe(
      OFFER_HEADERS["x-rtc-cookie"],
    );
    expect(offer.headers.get("x-rtc-file-index")).toBe(
      OFFER_HEADERS["x-rtc-file-index"],
    );
    expect(offer.headers.get("x-rtc-query-id")).toBe(
      OFFER_HEADERS["x-rtc-query-id"],
    );
    expect(offer.headers.get("x-rtc-rid")).toBe(
      OFFER_HEADERS["x-rtc-rid"],
    );
    expect(offer.headers.get("x-rtc-token")).toBe(
      OFFER_HEADERS["x-rtc-token"],
    );
    expect(await offer.text()).toBe(OFFER_SDP);

    const noOffer = await fetch(
      `${url}/rtc/offer?target=${OFFER_HEADERS["x-rtc-target"]}`,
    );
    expect(noOffer.status).toBe(204);

    const waitingForAnswer = await fetch(
      `${url}/rtc/answer?rid=${OFFER_HEADERS["x-rtc-rid"]}&token=${OFFER_HEADERS["x-rtc-token"]}`,
    );
    expect(waitingForAnswer.status).toBe(204);

    const answerAccepted = await fetch(
      `${url}/rtc/answer?rid=${OFFER_HEADERS["x-rtc-rid"]}&token=${OFFER_HEADERS["x-rtc-token"]}`,
      {
        body: ANSWER_SDP,
        headers: {
          "content-type": "application/sdp",
        },
        method: "POST",
      },
    );
    expect(answerAccepted.status).toBe(202);

    const answer = await fetch(
      `${url}/rtc/answer?rid=${OFFER_HEADERS["x-rtc-rid"]}&token=${OFFER_HEADERS["x-rtc-token"]}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("application/sdp");
    expect(await answer.text()).toBe(ANSWER_SDP);

    const answerGone = await fetch(
      `${url}/rtc/answer?rid=${OFFER_HEADERS["x-rtc-rid"]}&token=${OFFER_HEADERS["x-rtc-token"]}`,
    );
    expect(answerGone.status).toBe(404);
  });

  test("keeps queued offers in fifo order for the same target", async () => {
    const { url } = await startRelay();

    const first = {
      ...OFFER_HEADERS,
      "x-rtc-rid": "66".repeat(16),
      "x-rtc-token": "77".repeat(16),
    };
    const second = {
      ...OFFER_HEADERS,
      "x-rtc-rid": "88".repeat(16),
      "x-rtc-token": "99".repeat(16),
    };

    await fetch(`${url}/rtc/offer`, {
      body: "v=0\r\na=first\r\n",
      headers: first,
      method: "POST",
    });
    await fetch(`${url}/rtc/offer`, {
      body: "v=0\r\na=second\r\n",
      headers: second,
      method: "POST",
    });

    const firstOffer = await fetch(
      `${url}/rtc/offer?target=${OFFER_HEADERS["x-rtc-target"]}`,
    );
    expect(firstOffer.status).toBe(200);
    expect(firstOffer.headers.get("x-rtc-rid")).toBe(first["x-rtc-rid"]);
    expect(await firstOffer.text()).toBe("v=0\r\na=first\r\n");

    const secondOffer = await fetch(
      `${url}/rtc/offer?target=${OFFER_HEADERS["x-rtc-target"]}`,
    );
    expect(secondOffer.status).toBe(200);
    expect(secondOffer.headers.get("x-rtc-rid")).toBe(second["x-rtc-rid"]);
    expect(await secondOffer.text()).toBe("v=0\r\na=second\r\n");
  });

  test("rejects malformed offer requests and unknown answer sessions", async () => {
    const { url } = await startRelay();

    const badOffer = await fetch(`${url}/rtc/offer`, {
      body: " \r\n",
      headers: {
        "content-type": "application/sdp",
      },
      method: "POST",
    });
    expect(badOffer.status).toBe(400);

    const unknownAnswer = await fetch(
      `${url}/rtc/answer?rid=${"aa".repeat(16)}&token=${"bb".repeat(16)}`,
      {
        body: ANSWER_SDP,
        headers: {
          "content-type": "application/sdp",
        },
        method: "POST",
      },
    );
    expect(unknownAnswer.status).toBe(404);

    const badTarget = await fetch(`${url}/rtc/offer?target=not-hex`);
    expect(badTarget.status).toBe(400);
  });

  test("serves an in-memory gwebcache on the relay base url", async () => {
    const { url } = await startRelay();
    const normalizedUrl = new URL(url).toString();

    const emptyBootstrap = await requestGWebCache(url, {
      timeoutMs: 1000,
    });
    expect(emptyBootstrap.status).toBe(200);
    expect(emptyBootstrap.spec).toBe(2);
    expect(emptyBootstrap.peers).toEqual([]);
    expect(emptyBootstrap.caches).toEqual([]);

    const reported = await reportSelfToGWebCaches({
      caches: [url],
      ip: "66.132.55.12:6346",
      leafCount: 4,
      state: {},
      timeoutMs: 1000,
      uptimeSec: 123,
    });
    expect(reported.referenceCache).toBe(normalizedUrl);
    expect(reported.attemptedCaches).toEqual([normalizedUrl]);
    expect(reported.reportedCaches).toEqual([normalizedUrl]);
    expect(reported.errors).toEqual([]);

    const bootstrap = await fetchBootstrapData({
      caches: [url],
      maxCaches: 4,
      maxPeers: 4,
      timeoutMs: 1000,
    });
    expect(bootstrap.peers).toEqual(["66.132.55.12:6346"]);
    expect(bootstrap.caches).toEqual([normalizedUrl]);
    expect(bootstrap.errors).toEqual([]);

    const detailed = await requestGWebCache(url, {
      getLeaves: true,
      getUptime: true,
      getVendors: true,
      timeoutMs: 1000,
    });
    expect(detailed.hostEntries).toMatchObject([
      {
        leafCount: 4,
        peer: "66.132.55.12:6346",
        uptimeSec: 123,
        vendor: "GBUN/GnutellaBun/0.6",
      },
    ]);
  });
});
