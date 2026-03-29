import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  GWEBCACHE_REPORT_DELAY_SEC,
  MAX_PEER_AGE_SEC,
  MAX_TRACKED_PEERS,
} from "../../../../src/const";
import { KNOWN_CACHES } from "../../../../src/gwebcache_client";
import {
  makeNode,
  makePeer,
  overrideRuntimeConfig,
  peerState,
  withMockNetworkInterfaces,
  withTempDir,
} from "./helpers";

describe("protocol node", () => {
  test("markPeerSeenIfStable updates peer timestamps only after the stability threshold", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        node.doc.state.peers = peerState([
          ["9.8.7.6:4321", 0],
          ["5.6.7.8:6347", 0],
        ]);

        const peer = makePeer("9.8.7.6:4321");
        peer.dialTarget = "9.8.7.6:4321";
        peer.capabilities.listenIp = {
          host: "5.6.7.8",
          port: 6347,
        };

        const connectedAt = 1_700_000_000_000;
        peer.connectedAt = connectedAt;
        node.markPeerSeenIfStable(peer as never, connectedAt + 59_000);

        expect(node.doc.state.peers).toEqual({
          "9.8.7.6:4321": 0,
          "5.6.7.8:6347": 0,
        });

        node.markPeerSeenIfStable(peer as never, connectedAt + 61_000);

        expect(node.doc.state.peers).toEqual({
          "5.6.7.8:6347": 1700000061,
          "9.8.7.6:4321": 1700000061,
        });
        expect(node.getKnownPeers()).toEqual([
          "5.6.7.8:6347",
          "9.8.7.6:4321",
        ]);
      });
    });
  });

  test("addKnownPeer refreshes zero-timestamp priority and evicts the lowest priority tracked peer", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        node.doc.state.peers = peerState(
          Array.from({ length: MAX_TRACKED_PEERS }, (_value, index) => [
            `44.0.0.${index + 1}:6346`,
            0,
          ]),
        );

        node.addKnownPeer("44.0.0.1", 6346);
        expect(node.getKnownPeers()[0]).toBe("44.0.0.1:6346");

        node.addKnownPeer("44.0.0.41", 6346);
        expect(Object.keys(node.doc.state.peers)).toHaveLength(
          MAX_TRACKED_PEERS,
        );
        expect(node.getKnownPeers()).not.toContain("44.0.0.40:6346");
        expect(node.getKnownPeers()[0]).toBe("44.0.0.41:6346");
      });
    });
  });

  test("connectKnownPeers prioritizes the most recently stable peers", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const nowSec = Math.floor(Date.now() / 1000);
      node.doc.state.peers = peerState([
        ["9.9.9.9:9999", nowSec],
        ["8.8.8.8:8888", nowSec - 100],
        ["1.1.1.1:1111", 0],
        ["2.2.2.2:2222", 0],
      ]);
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        maxConnections: 2,
        connectTimeoutMs: 5000,
      });

      const started: string[] = [];
      const releases: Array<() => void> = [];

      node.connectPeer = async (host: string, port: number) => {
        const target = `${host}:${port}`;
        started.push(target);
        node.dialing.add(target);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            node.dialing.delete(target);
            resolve();
          });
        });
      };

      const bootstrap = node.connectKnownPeers();

      expect(started).toEqual(["9.9.9.9:9999", "8.8.8.8:8888"]);

      while (releases.length) {
        releases.shift()?.();
        await Promise.resolve();
      }

      await bootstrap;
      expect(started).toEqual([
        "9.9.9.9:9999",
        "8.8.8.8:8888",
        "1.1.1.1:1111",
        "2.2.2.2:2222",
      ]);
    });
  });

  test("pruneExpiredKnownPeers drops week-old peers but keeps recent and zero-confidence entries", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const nowSec = 1_700_000_000;
      node.doc.state.peers = peerState([
        ["9.9.9.9:9999", nowSec - 60],
        ["8.8.8.8:8888", nowSec - MAX_PEER_AGE_SEC],
        ["7.7.7.7:7777", nowSec - MAX_PEER_AGE_SEC - 1],
        ["6.6.6.6:6666", 0],
      ]);

      expect(node.pruneExpiredKnownPeers(nowSec)).toBe(true);
      expect(node.doc.state.peers).toEqual({
        "9.9.9.9:9999": nowSec - 60,
        "8.8.8.8:8888": nowSec - MAX_PEER_AGE_SEC,
        "6.6.6.6:6666": 0,
      });
    });
  });

  test("connectKnownPeers bootstraps multiple peer dials in parallel", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const nowSec = Math.floor(Date.now() / 1000);
      node.doc.state.peers = peerState([
        ["1.1.1.1:1111", nowSec],
        ["2.2.2.2:2222", nowSec - 1],
        ["3.3.3.3:3333", nowSec - 2],
        ["4.4.4.4:4444", nowSec - 3],
        ["5.5.5.5:5555", nowSec - 4],
      ]);
      overrideRuntimeConfig(node, {
        ultrapeer: true,
        nodeMode: "ultrapeer",
        maxConnections: 3,
        connectTimeoutMs: 5000,
      });
      const expectedPeers = node.getKnownPeers();

      const started: string[] = [];
      const timeouts: number[] = [];
      const releases: Array<() => void> = [];
      let inFlight = 0;
      let maxInFlight = 0;

      node.connectPeer = async (
        host: string,
        port: number,
        timeoutMs = 0,
      ) => {
        const target = `${host}:${port}`;
        started.push(target);
        timeouts.push(timeoutMs);
        node.dialing.add(target);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => {
          releases.push(() => {
            node.dialing.delete(target);
            inFlight -= 1;
            resolve();
          });
        });
      };

      const bootstrap = node.connectKnownPeers();

      expect(started).toEqual([
        "1.1.1.1:1111",
        "2.2.2.2:2222",
        "3.3.3.3:3333",
      ]);
      expect(maxInFlight).toBe(
        Math.min(
          BOOTSTRAP_CONNECT_CONCURRENCY,
          node.config().maxConnections,
        ),
      );
      expect(timeouts).toEqual([2500, 2500, 2500]);

      while (releases.length) {
        releases.shift()?.();
        await Promise.resolve();
      }

      await bootstrap;
      expect(started).toEqual(expectedPeers);
      expect(timeouts).toEqual(
        expectedPeers.map(() =>
          Math.floor(
            node.config().connectTimeoutMs /
              BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
          ),
        ),
      );
    });
  });

  test("connectKnownPeers skips all-zero peers and fetches fresh gwebcaches", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        node.doc.state.peers = peerState([["1.1.1.1:1111", 0]]);
        overrideRuntimeConfig(node, {
          maxConnections: 2,
          connectTimeoutMs: 5000,
        });

        const dialed: string[] = [];
        const fetchCalls: string[] = [];
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async (input: string | URL | Request) => {
          const url = new URL(String(input));
          fetchCalls.push(url.toString());
          if (url.origin + url.pathname === KNOWN_CACHES[0]) {
            return new Response(
              "I|pong|ModernCache 2.0|gnutella\nH|66.132.55.12:6346|5\nH|72.14.201.10:6346|5\n",
            );
          }
          return new Response("I|pong|ModernCache 2.0|gnutella\n");
        }) as typeof fetch;

        node.connectPeer = async (
          host: string,
          port: number,
          timeoutMs = 0,
        ) => {
          dialed.push(`${host}:${port}:${timeoutMs}`);
          throw new Error("offline");
        };

        try {
          await node.connectKnownPeers();
        } finally {
          globalThis.fetch = originalFetch;
        }

        expect(fetchCalls).toHaveLength(KNOWN_CACHES.length);
        expect(dialed).toEqual([
          "66.132.55.12:6346:2500",
          "72.14.201.10:6346:2500",
        ]);
        expect(node.getKnownPeers()).toEqual([
          "72.14.201.10:6346",
          "66.132.55.12:6346",
          "1.1.1.1:1111",
        ]);
      });
    });
  });

  test("connectKnownPeers avoids repeating gwebcache bootstraps for the same exhausted peers", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        node.doc.state.peers = peerState([["1.1.1.1:1111", 123]]);
        overrideRuntimeConfig(node, {
          maxConnections: 1,
          connectTimeoutMs: 5000,
        });

        const fetchCalls: string[] = [];
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async (input: string | URL | Request) => {
          fetchCalls.push(String(input));
          return new Response("I|pong|ModernCache 2.0|gnutella\n");
        }) as typeof fetch;

        node.connectPeer = async () => {
          throw new Error("offline");
        };

        try {
          await node.connectKnownPeers();
          await node.connectKnownPeers();
        } finally {
          globalThis.fetch = originalFetch;
        }

        expect(fetchCalls).toHaveLength(KNOWN_CACHES.length);
      });
    });
  });

  test("refreshGWebCacheReport waits five minutes of connectivity and cancels when peers drop to zero", async () => {
    await withTempDir(async (dir) => {
      const scheduled: Array<{
        ms: number;
        fn: () => void;
        timer: NodeJS.Timeout;
      }> = [];
      const canceled: NodeJS.Timeout[] = [];
      const node = makeNode(path.join(dir, "protocol.json"), {
        collaborators: {
          scheduler: {
            setTimeout: (fn: () => void, ms: number) => {
              const timer = {} as NodeJS.Timeout;
              scheduled.push({ ms, fn, timer });
              return timer;
            },
            clearTimeout: (timer: NodeJS.Timeout) => {
              canceled.push(timer);
            },
          },
        },
      });

      node.peers.set("peer-1", makePeer("6.6.6.6:6346"));
      node.refreshGWebCacheReport();
      node.refreshGWebCacheReport();

      expect(scheduled.map((entry) => entry.ms)).toEqual([
        GWEBCACHE_REPORT_DELAY_SEC * 1000,
      ]);

      node.peers.clear();
      node.refreshGWebCacheReport();

      expect(canceled).toEqual([scheduled[0].timer]);
    });
  });

  test("gwebcache self-report only gets one session attempt", async () => {
    await withTempDir(async (dir) => {
      const scheduled: Array<{ ms: number; fn: () => void }> = [];
      const reportedIps: string[] = [];
      const node = makeNode(path.join(dir, "protocol.json"), {
        runtimeConfig: {
          advertisedHost: "66.132.55.12",
          advertisedPort: 6346,
        },
        collaborators: {
          scheduler: {
            setTimeout: (fn: () => void, ms: number) => {
              scheduled.push({ ms, fn });
              return {} as NodeJS.Timeout;
            },
          },
          bootstrapClient: {
            reportSelfToGWebCaches: async ({ ip }) => {
              reportedIps.push(ip);
              return {
                attemptedCaches: [],
                reportedCaches: [],
                errors: [],
              };
            },
          },
        },
      });

      node.peers.set("peer-1", makePeer("6.6.6.6:6346"));
      node.refreshGWebCacheReport();
      expect(scheduled.map((entry) => entry.ms)).toEqual([
        GWEBCACHE_REPORT_DELAY_SEC * 1000,
      ]);

      scheduled[0].fn();
      await Promise.resolve();
      node.refreshGWebCacheReport();

      expect(node.gwebCacheReportAttempted).toBe(true);
      expect(reportedIps).toEqual(["66.132.55.12:6346"]);
      expect(scheduled).toHaveLength(1);
    });
  });

  test("announceSelfToGWebCaches reports once using the configured v2 cache list", async () => {
    await withTempDir(async (dir) => {
      await withMockNetworkInterfaces(async () => {
        const node = makeNode(path.join(dir, "protocol.json"));
        overrideRuntimeConfig(node, {
          advertisedHost: "66.132.55.12",
          advertisedPort: 6346,
        });

        const fetchCalls: string[] = [];
        const originalFetch = globalThis.fetch;

        globalThis.fetch = (async (input: string | URL | Request) => {
          fetchCalls.push(String(input));
          return new Response("I|update|OK|Added", {
            status: 200,
            statusText: "OK",
          });
        }) as typeof fetch;

        try {
          await node.announceSelfToGWebCaches();
        } finally {
          globalThis.fetch = originalFetch;
        }

        expect(node.gwebCacheReported).toBe(true);
        expect(fetchCalls).toHaveLength(KNOWN_CACHES.length);

        const first = new URL(fetchCalls[0]);
        expect(first.searchParams.get("update")).toBe("1");
        expect(first.searchParams.get("spec")).toBe("2");
        expect(first.searchParams.get("ip")).toBe("66.132.55.12:6346");
        expect(first.searchParams.get("url")).toBe(KNOWN_CACHES[1]);
      });
    });
  });
});
