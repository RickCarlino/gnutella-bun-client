import { describe, expect, test } from "bun:test";

import {
  buildGWebCacheUrl,
  connectBootstrapPeers,
  fetchBootstrapData,
  getMorePeers,
  KNOWN_CACHES,
  parseGWebCacheResponse,
  reportSelfToGWebCaches,
  requestGWebCache,
} from "../../src/gwebcache_client";
import {
  describeHttpError,
  describeUpdateError,
} from "../../src/gwebcache/response";

describe("gwebcache client", () => {
  test("builds spec2 request URLs with update parameters", () => {
    const built = new URL(
      buildGWebCacheUrl(KNOWN_CACHES[0], {
        mode: "get",
        network: "gnutella",
        client: "gbun",
        version: "0.6-test",
        ip: "66.132.55.12:6346",
        url: "https://cache.example.net/gcache.php",
        cluster: "up",
        getLeaves: true,
        getClusters: true,
        getVendors: true,
        getUptime: true,
        spec: 2,
      }),
    );

    expect(built.searchParams.get("get")).toBe("1");
    expect(built.searchParams.get("net")).toBe("gnutella");
    expect(built.searchParams.get("client")).toBe("GBUN");
    expect(built.searchParams.get("version")).toBe("0.6-test");
    expect(built.searchParams.get("ping")).toBe("1");
    expect(built.searchParams.get("update")).toBe("1");
    expect(built.searchParams.get("ip")).toBe("66.132.55.12:6346");
    expect(built.searchParams.get("url")).toBe(
      "https://cache.example.net/gcache.php",
    );
    expect(built.searchParams.get("cluster")).toBe("up");
    expect(built.searchParams.get("getleaves")).toBe("1");
    expect(built.searchParams.get("getclusters")).toBe("1");
    expect(built.searchParams.get("getvendors")).toBe("1");
    expect(built.searchParams.get("getuptime")).toBe("1");
    expect(built.searchParams.get("spec")).toBe("2");
  });

  test("ignores legacy or malformed response lines", () => {
    const result = parseGWebCacheResponse(`
      PONG ExampleCache 1.0
      66.132.55.12:6346
      WARNING: legacy cache
    `);

    expect(result.spec).toBeUndefined();
    expect(result.pong).toBeUndefined();
    expect(result.peers).toEqual([]);
    expect(result.caches).toEqual([]);
  });

  test("parses spec2 responses, warnings, and extended host fields", () => {
    const result = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella-gnutella2
      I|update|OK|Already present
      I|WARNING|You came back too early
      H|66.132.55.12:6346|3600|core|45|LIME/5.5|7200|stable
      H|10.0.0.1:6346|120
      U|http://cache1.example.net/gcache.php|7200
    `);

    expect(result.spec).toBe(2);
    expect(result.pong).toEqual({
      name: "ExampleCache 2.0",
      networks: ["gnutella", "gnutella2"],
    });
    expect(result.update).toEqual({
      ok: true,
      warning: "Already present",
      values: ["OK", "Already present"],
    });
    expect(result.warnings).toEqual([
      "Already present",
      "You came back too early",
    ]);
    expect(result.peers).toEqual(["66.132.55.12:6346"]);
    expect(result.hostEntries).toEqual([
      {
        peer: "66.132.55.12:6346",
        ageSec: 3600,
        cluster: "core",
        leafCount: 45,
        vendor: "LIME/5.5",
        uptimeSec: 7200,
        extraFields: ["stable"],
      },
    ]);
    expect(result.caches).toEqual([
      "http://cache1.example.net/gcache.php",
    ]);
  });

  test("describes update errors and fallback update warnings", () => {
    const warningResult = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella
      I|update|WARNING|Slow down
    `);
    expect(warningResult.update).toEqual({
      ok: false,
      warning: "Slow down",
      values: ["WARNING", "Slow down"],
    });

    const fallbackResult = parseGWebCacheResponse(`
      I|pong|ExampleCache 2.0|gnutella
      I|update|queued|OK|WARNING: Try later
    `);
    expect(fallbackResult.update).toEqual({
      ok: true,
      warning: "queued|OK|WARNING: Try later",
      values: ["queued", "OK", "WARNING: Try later"],
    });

    expect(
      describeHttpError({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        rawLines: ["Required network not accepted"],
      } as never),
    ).toBe("HTTP 503: Required network not accepted");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
        update: warningResult.update,
      } as never),
    ).toBe("Slow down");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
        update: fallbackResult.update,
      } as never),
    ).toBe("queued|OK|WARNING: Try later");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
      } as never),
    ).toBe("unexpected non-spec2 gwebcache response");
    expect(
      describeUpdateError({
        ok: true,
        status: 200,
        statusText: "OK",
        rawLines: [],
        spec: 2,
      } as never),
    ).toBe("missing spec2 gwebcache update response");
  });

  test("fetches and parses a gwebcache response", async () => {
    const seen: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(
        "I|pong|ExampleCache 2.0|gnutella\nH|66.132.55.12:6346|5\n",
        { status: 200, statusText: "OK" },
      );
    };

    const result = await requestGWebCache("http://cache.example/gwc.php", {
      fetchImpl,
      timeoutMs: 1000,
    });

    expect(seen).toHaveLength(1);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.peers).toEqual(["66.132.55.12:6346"]);
    expect(new URL(seen[0]).searchParams.get("get")).toBe("1");
  });

  test("propagates external aborts and request timeouts", async () => {
    const preAborted = new AbortController();
    preAborted.abort(new Error("stopped"));
    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        signal: preAborted.signal,
        timeoutMs: 0,
        fetchImpl: async (_input, init) => {
          const signal = init?.signal as AbortSignal;
          expect(signal.aborted).toBe(true);
          throw signal.reason;
        },
      }),
    ).rejects.toThrow("stopped");

    const externalAbort = new AbortController();
    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        signal: externalAbort.signal,
        timeoutMs: 0,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
            queueMicrotask(() =>
              externalAbort.abort(new Error("cancelled")),
            );
          }),
      }),
    ).rejects.toThrow("cancelled");

    await expect(
      requestGWebCache("http://cache.example/gwc.php", {
        timeoutMs: 1,
        fetchImpl: async (_input, init) =>
          await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal;
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      }),
    ).rejects.toThrow("gwebcache request timed out after 1ms");
  });

  test("bootstraps peers from spec2 caches only", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());

      if (
        url.hostname === "cache-a.example" &&
        url.searchParams.get("get") === "1"
      ) {
        return new Response("Required network not accepted", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }

      if (
        url.hostname === "cache-b.example" &&
        url.searchParams.get("get") === "1"
      ) {
        return new Response(
          "I|pong|ModernCache 2.0|gnutella\nH|72.14.201.10:6346|120\nU|https://cache-d.example/gcache.php|300\n",
          {
            status: 200,
            statusText: "OK",
          },
        );
      }

      throw new Error(`unexpected request: ${url.toString()}`);
    };

    const result = await fetchBootstrapData({
      caches: [
        "http://cache-a.example/gwc.php",
        "http://cache-b.example/gwc.php",
      ],
      fetchImpl,
      maxPeers: 2,
      maxCaches: 4,
    });

    expect(result.peers).toEqual(["72.14.201.10:6346"]);
    expect(result.caches).toEqual(["https://cache-d.example/gcache.php"]);
    expect(result.queriedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.errors).toEqual([
      {
        cache: "http://cache-a.example/gwc.php",
        message: "HTTP 503: Required network not accepted",
      },
    ]);
    expect(calls).toHaveLength(2);

    const first = new URL(calls[0]);
    expect(first.searchParams.get("get")).toBe("1");
    expect(first.searchParams.get("net")).toBe("gnutella");
    expect(first.searchParams.get("ping")).toBe("1");
    expect(first.searchParams.get("client")).toBe("GBUN");
    expect(first.searchParams.get("version")).toBe("GnutellaBun/0.6");
  });

  test("fetchBootstrapData records thrown cache request errors", async () => {
    const result = await fetchBootstrapData({
      caches: ["http://cache-a.example/gwc.php"],
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    expect(result.peers).toEqual([]);
    expect(result.caches).toEqual([]);
    expect(result.queriedCaches).toEqual([
      "http://cache-a.example/gwc.php",
    ]);
    expect(result.errors).toEqual([
      {
        cache: "http://cache-a.example/gwc.php",
        message: "network down",
      },
    ]);
  });

  test("getMorePeers returns only the bootstrap peers", async () => {
    const fetchImpl = async (_input: string | URL | Request) =>
      new Response(
        "I|pong|ModernCache 2.0|gnutella\nH|66.132.55.12:6346|5\n",
      );

    await expect(
      getMorePeers({
        caches: ["http://cache-a.example/gwc.php"],
        fetchImpl,
        maxPeers: 1,
      }),
    ).resolves.toEqual(["66.132.55.12:6346"]);
  });

  test("connectBootstrapPeers queries every cache when bootstrapping", async () => {
    const fetchCalls: string[] = [];
    const addedPeers: string[] = [];
    const dialedPeers: string[] = [];
    const state: {
      aliveCaches?: string[];
      active?: boolean;
      lastExhaustedPeerSet?: string;
    } = {};

    const fetchImpl = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      fetchCalls.push(url.toString());

      if (url.hostname === "cache-a.example") {
        return new Response(
          "I|pong|ModernCache 2.0|gnutella\nH|66.132.55.12:6346|5\n",
        );
      }
      if (url.hostname === "cache-b.example") {
        return new Response(
          "I|pong|ModernCache 2.0|gnutella\nH|72.14.201.10:6346|5\nH|66.132.55.12:6346|1\n",
        );
      }

      throw new Error(`unexpected request: ${url.toString()}`);
    };

    const result = await connectBootstrapPeers({
      peers: [],
      caches: [
        "http://cache-a.example/gwc.php",
        "http://cache-b.example/gwc.php",
      ],
      fetchImpl,
      connectTimeoutMs: 2500,
      connectConcurrency: 2,
      connectedCount: () => 0,
      availableSlots: () => 2,
      connectPeer: async (
        host: string,
        port: number,
        timeoutMs: number,
      ) => {
        dialedPeers.push(`${host}:${port}:${timeoutMs}`);
        throw new Error("offline");
      },
      addPeer: (peer: string) => {
        addedPeers.push(peer);
      },
      state,
    });

    expect(fetchCalls).toHaveLength(2);
    expect(result.fetchedFromCaches).toBe(true);
    expect(result.queriedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.addedPeers).toEqual([
      "66.132.55.12:6346",
      "72.14.201.10:6346",
    ]);
    expect(addedPeers).toEqual(["66.132.55.12:6346", "72.14.201.10:6346"]);
    expect(state.aliveCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(dialedPeers).toEqual([
      "66.132.55.12:6346:2500",
      "72.14.201.10:6346:2500",
    ]);
  });

  test("connectBootstrapPeers skips repeated gwebcache lookups for the same exhausted peer set", async () => {
    const fetchCalls: string[] = [];
    const state = {};

    const fetchImpl = async (input: string | URL | Request) => {
      fetchCalls.push(String(input));
      return new Response("I|pong|ModernCache 2.0|gnutella\n");
    };

    const run = () =>
      connectBootstrapPeers({
        peers: ["11.22.33.44:6346"],
        caches: ["http://cache-a.example/gwc.php"],
        fetchImpl,
        connectTimeoutMs: 2500,
        connectConcurrency: 1,
        connectedCount: () => 0,
        availableSlots: () => 1,
        connectPeer: async () => {
          throw new Error("offline");
        },
        state,
      });

    await run();
    await run();

    expect(fetchCalls).toHaveLength(1);
  });

  test("reportSelfToGWebCaches uses the cache list even without learned alive caches", async () => {
    const calls: string[] = [];
    const result = await reportSelfToGWebCaches({
      caches: [
        "http://cache-a.example/gwc.php",
        "http://cache-b.example/gwc.php",
      ],
      ip: "66.132.55.12:6346",
      state: {},
      fetchImpl: async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("I|update|OK|Added", {
          status: 200,
          statusText: "OK",
        });
      },
    });

    expect(result.referenceCache).toBe("http://cache-a.example/gwc.php");
    expect(result.attemptedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.reportedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.errors).toEqual([]);

    const first = new URL(calls[0]);
    expect(first.searchParams.get("url")).toBe(
      "http://cache-b.example/gwc.php",
    );

    const second = new URL(calls[1]);
    expect(second.searchParams.get("url")).toBe(
      "http://cache-a.example/gwc.php",
    );
  });

  test("reportSelfToGWebCaches sends v2 updates using a known alive cache url", async () => {
    const calls: string[] = [];
    const state = {
      aliveCaches: [
        "http://cache-a.example/gwc.php",
        "http://cache-c.example/gwc.php",
      ],
    };

    const result = await reportSelfToGWebCaches({
      caches: [
        "http://cache-a.example/gwc.php",
        "http://cache-b.example/gwc.php",
      ],
      ip: "66.132.55.12:6346",
      state,
      fetchImpl: async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response("I|update|OK|Added", {
          status: 200,
          statusText: "OK",
        });
      },
    });

    expect(result.referenceCache).toBe("http://cache-a.example/gwc.php");
    expect(result.attemptedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.reportedCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);
    expect(result.errors).toEqual([]);
    expect(state.aliveCaches).toEqual([
      "http://cache-a.example/gwc.php",
      "http://cache-c.example/gwc.php",
      "http://cache-b.example/gwc.php",
    ]);

    const first = new URL(calls[0]);
    expect(first.searchParams.get("update")).toBe("1");
    expect(first.searchParams.get("spec")).toBe("2");
    expect(first.searchParams.get("ip")).toBe("66.132.55.12:6346");
    expect(first.searchParams.get("url")).toBe(
      "http://cache-c.example/gwc.php",
    );

    const second = new URL(calls[1]);
    expect(second.searchParams.get("update")).toBe("1");
    expect(second.searchParams.get("spec")).toBe("2");
    expect(second.searchParams.get("ip")).toBe("66.132.55.12:6346");
    expect(second.searchParams.get("url")).toBe(
      "http://cache-a.example/gwc.php",
    );
  });

  test("reportSelfToGWebCaches handles empty and rejected cache updates", async () => {
    await expect(
      reportSelfToGWebCaches({
        ip: "66.132.55.12:6346",
        caches: ["not-a-cache-url"],
      }),
    ).resolves.toEqual({
      referenceCache: undefined,
      attemptedCaches: [],
      reportedCaches: [],
      errors: [],
    });

    const rejected = await reportSelfToGWebCaches({
      ip: "66.132.55.12:6346",
      caches: ["http://cache-a.example/gwc.php"],
      fetchImpl: async () =>
        new Response(
          "I|pong|ModernCache 2.0|gnutella\nI|update|WARNING|Try later\n",
          {
            status: 200,
            statusText: "OK",
          },
        ),
    });

    expect(rejected.referenceCache).toBe("http://cache-a.example/gwc.php");
    expect(rejected.reportedCaches).toEqual([]);
    expect(rejected.errors).toEqual([
      {
        cache: "http://cache-a.example/gwc.php",
        message: "Try later",
      },
    ]);
  });
});
