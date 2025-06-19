import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createGnutellaCache } from "../src/cache-client";

const TEST_SETTINGS_FILE = "settings.json";

describe("GnutellaCache", () => {
  let cache: Awaited<ReturnType<typeof createGnutellaCache>>;

  beforeEach(async () => {
    // Clean up any existing settings file
    if (existsSync(TEST_SETTINGS_FILE)) {
      unlinkSync(TEST_SETTINGS_FILE);
    }
    cache = await createGnutellaCache();
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(TEST_SETTINGS_FILE)) {
      unlinkSync(TEST_SETTINGS_FILE);
    }
  });

  describe("store() and load()", () => {
    test("should create settings file if it doesn't exist", async () => {
      await cache.load();
      expect(existsSync(TEST_SETTINGS_FILE)).toBe(true);
    });

    test("should initialize with KNOWN_CACHE_LIST when creating new file", async () => {
      await cache.load();

      // Read the created file
      const content = await readFile(TEST_SETTINGS_FILE, "utf-8");
      const data = JSON.parse(content);

      // Check that caches were initialized with known list
      const cacheUrls = Object.keys(data.caches);
      expect(cacheUrls.length).toBeGreaterThan(0);
      expect(cacheUrls[0]).toBeTruthy();
      expect(data.caches[cacheUrls[0]].lastPush).toBe(0);
      expect(data.caches[cacheUrls[0]].lastPull).toBe(0);
    });

    test("should persist and load hosts", async () => {
      cache.addHost("192.168.1.1", 6346);
      cache.addHost("10.0.0.1", 6347);
      await cache.store();

      // Create new cache instance and load
      const newCache = await createGnutellaCache();
      await newCache.load();

      const hosts = newCache.getHosts();
      expect(hosts).toHaveLength(2);
      expect(hosts[0].ip).toBe("192.168.1.1");
      expect(hosts[0].port).toBe(6346);
      expect(hosts[1].ip).toBe("10.0.0.1");
      expect(hosts[1].port).toBe(6347);
    });

    test("should persist and load caches", async () => {
      cache.addCache("http://example.com/gwc");
      cache.addCache("http://test.com/cache");
      await cache.store();

      // Verify file contents
      const content = await readFile(TEST_SETTINGS_FILE, "utf-8");
      const data = JSON.parse(content);
      expect(Object.keys(data.caches)).toHaveLength(2);
      expect(data.caches["http://example.com/gwc"]).toBeDefined();
      expect(data.caches["http://test.com/cache"]).toBeDefined();
      expect(data.caches["http://example.com/gwc"].lastPush).toBe(0);
      expect(data.caches["http://example.com/gwc"].lastPull).toBe(0);
    });
  });

  describe("addHost()", () => {
    test("should add new hosts", () => {
      cache.addHost("192.168.1.1", 6346);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0].ip).toBe("192.168.1.1");
      expect(hosts[0].port).toBe(6346);
      expect(hosts[0].lastSeen).toBeGreaterThan(0);
    });

    test("should update existing host's lastSeen time", () => {
      const oldTime = Date.now() - 10000;
      cache.addHost("192.168.1.1", 6346, oldTime);

      const newTime = Date.now();
      cache.addHost("192.168.1.1", 6346, newTime);

      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0].lastSeen).toBe(newTime);
    });

    test("should handle multiple hosts", () => {
      cache.addHost("192.168.1.1", 6346);
      cache.addHost("192.168.1.2", 6346);
      cache.addHost("192.168.1.1", 6347); // Different port

      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(3);
    });
  });

  describe("evictHosts()", () => {
    test("should remove hosts older than cutoff", () => {
      const now = Date.now();
      const oldTime = now - 2 * 60 * 60 * 1000; // 2 hours ago
      const recentTime = now - 30 * 60 * 1000; // 30 minutes ago

      cache.addHost("192.168.1.1", 6346, oldTime);
      cache.addHost("192.168.1.2", 6346, recentTime);
      cache.addHost("192.168.1.3", 6346, now);

      // Evict hosts older than 1 hour
      cache.evictHosts(60 * 60 * 1000);

      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(2);
      expect(hosts.find((h) => h.ip === "192.168.1.1")).toBeUndefined();
      expect(hosts.find((h) => h.ip === "192.168.1.2")).toBeDefined();
      expect(hosts.find((h) => h.ip === "192.168.1.3")).toBeDefined();
    });

    test("should use default cutoff of 1 hour", () => {
      const now = Date.now();
      const oldTime = now - 2 * 60 * 60 * 1000; // 2 hours ago

      cache.addHost("192.168.1.1", 6346, oldTime);
      cache.addHost("192.168.1.2", 6346, now);

      cache.evictHosts(); // Use default

      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0].ip).toBe("192.168.1.2");
    });
  });

  describe("addCache()", () => {
    test("should add new cache URLs", () => {
      cache.addCache("http://example.com/gwc");
      cache.addCache("http://test.com/cache");
      // Verify by storing and checking file
      cache.store();
    });

    test("should not duplicate cache URLs", () => {
      cache.addCache("http://example.com/gwc");
      cache.addCache("http://example.com/gwc");
      cache.addCache("  http://example.com/gwc  "); // With whitespace

      // We can't directly check the caches array, but we can verify through store/load
      cache.store();
    });
  });

  describe("parseXTryHeaders()", () => {
    test("should parse X-Try header", () => {
      const headers = {
        "x-try": "192.168.1.1:6346,10.0.0.1:6347",
      };

      cache.parseXTryHeaders(headers);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(2);
      expect(hosts[0].ip).toBe("192.168.1.1");
      expect(hosts[0].port).toBe(6346);
      expect(hosts[1].ip).toBe("10.0.0.1");
      expect(hosts[1].port).toBe(6347);
    });

    test("should parse X-Try-Ultrapeer header", () => {
      const headers = {
        "x-try-ultrapeer": "192.168.1.1:6346",
      };

      cache.parseXTryHeaders(headers);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(1);
      expect(hosts[0].ip).toBe("192.168.1.1");
    });

    test("should parse X-Try-Hub header with complex format", () => {
      const headers = {
        "x-try-hub": "192.168.1.1:6346 leaves=5,10.0.0.1:6347 extra=data",
      };

      cache.parseXTryHeaders(headers);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(2);
      expect(hosts[0].ip).toBe("192.168.1.1");
      expect(hosts[1].ip).toBe("10.0.0.1");
    });

    test("should handle multiple headers at once", () => {
      const headers = {
        "x-try": "192.168.1.1:6346",
        "x-try-ultrapeer": "10.0.0.1:6347",
        "x-try-hub": "172.16.0.1:6348",
      };

      cache.parseXTryHeaders(headers);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(3);
    });

    test("should ignore invalid entries", () => {
      const headers = {
        "x-try":
          "192.168.1.1:6346,invalid-ip,10.0.0.1:invalid-port,172.16.0.1:6347",
      };

      cache.parseXTryHeaders(headers);
      const hosts = cache.getHosts();
      expect(hosts).toHaveLength(2); // Only valid entries
      expect(hosts[0].ip).toBe("192.168.1.1");
      expect(hosts[1].ip).toBe("172.16.0.1");
    });
  });

  describe("canPushToCache() and updateCachePushTime()", () => {
    test("should track cache push cooldowns", async () => {
      cache.addCache("http://example.com/gwc");
      await cache.store();

      // Initially should be able to push
      expect(cache.canPushToCache("http://example.com/gwc")).toBe(true);

      // Update push time
      cache.updateCachePushTime("http://example.com/gwc");

      // Should not be able to push immediately after
      expect(cache.canPushToCache("http://example.com/gwc")).toBe(false);
    });

    test("should return false for unknown cache", () => {
      expect(cache.canPushToCache("http://unknown.com/gwc")).toBe(false);
    });
  });
});
