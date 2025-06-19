interface CacheResults {
  /** List of peers found. `127.0.0.1:4321` */
  peers: Set<string>;
  /** Caches found during search `https://mycache.net/` */
  caches: Set<string>;
  /** List of URLs that failed to fetch */
  failed: { url: string; error: string }[];
}

interface CacheInput {
  url: string;
  network: "Gnutella" | "Gnutella2";
  ip: string;
}

interface ParsedSpec2Response {
  hosts: Array<{ ip: string; age: number }>;
  caches: Array<{ url: string; age: number }>;
  info: string[];
}

export const KNOWN_CACHE_LIST = [
  "http://cache.jayl.de/g2/gwc.php",
  "http://cache.jayl.de/g2/gwc.php/",
  "http://gweb.4octets.co.uk/skulls.php",
  "http://gweb3.4octets.co.uk/gwc.php",
  "http://gweb4.4octets.co.uk/",
  "http://midian.jayl.de/g2/bazooka.php",
  "http://midian.jayl.de/g2/gwc.php",
  "http://p2p.findclan.net/skulls.php",
  "http://paper.gwc.dyslexicfish.net:3709/",
  "http://rock.gwc.dyslexicfish.net:3709/",
  "http://scissors.gwc.dyslexicfish.net:3709/",
  "http://skulls.gwc.dyslexicfish.net/skulls.php",
];

function parseSpec2Response(text: string): ParsedSpec2Response {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const result: ParsedSpec2Response = {
    hosts: [],
    caches: [],
    info: [],
  };

  for (const line of lines) {
    if (line.startsWith("H|")) {
      const parts = line.split("|");
      if (parts.length >= 3) {
        result.hosts.push({
          ip: parts[1],
          age: parseInt(parts[2], 10),
        });
      }
      continue;
    }

    if (line.startsWith("U|")) {
      const parts = line.split("|");
      if (parts.length >= 3) {
        result.caches.push({
          url: parts[1],
          age: parseInt(parts[2], 10),
        });
      }
      continue;
    }

    if (line.startsWith("I|")) {
      result.info.push(line);
    }
  }

  return result;
}

export async function cacheGet(urls: string[]): Promise<CacheResults> {
  const results: CacheResults = {
    peers: new Set(),
    caches: new Set(),
    failed: [],
  };

  const visited = new Set<string>();
  const queue = [...urls];

  while (queue.length > 0) {
    const url = queue.shift()!;

    if (visited.has(url)) {
      continue;
    }
    visited.add(url);

    try {
      const requestUrl = new URL(url);
      requestUrl.searchParams.set("client", "GBUN");
      requestUrl.searchParams.set("get", "50");
      requestUrl.searchParams.set("net", "Gnutella");
      requestUrl.searchParams.set("ping", "1");
      requestUrl.searchParams.set("version", "0.1");

      const response = await fetch(requestUrl.toString());

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      const parsed = parseSpec2Response(text);

      for (const info of parsed.info) {
        console.log(`[${url}] ${info}`);
      }

      for (const host of parsed.hosts) {
        results.peers.add(host.ip);
      }

      for (const cache of parsed.caches) {
        results.caches.add(cache.url);
        if (!visited.has(cache.url)) {
          queue.push(cache.url);
        }
      }
    } catch (error) {
      results.failed.push({
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

export async function cachePut(input: CacheInput): Promise<void> {
  try {
    const requestUrl = new URL(input.url);

    requestUrl.searchParams.set("update", "1");
    requestUrl.searchParams.set("net", input.network.toLowerCase());
    requestUrl.searchParams.set("ip", input.ip);
    requestUrl.searchParams.set("client", "GBUN");
    requestUrl.searchParams.set("version", "0.1.0");
    requestUrl.searchParams.set("ping", "1");

    const response = await fetch(requestUrl.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const parsed = parseSpec2Response(text);

    for (const info of parsed.info) {
      console.log(`[${input.url}] ${info}`);
    }

    const updateStatus = parsed.info.find((line) => line.includes("update"));
    if (updateStatus && !updateStatus.includes("|OK")) {
      throw new Error(`Update failed: ${updateStatus}`);
    }
    console.log(`Cache updated successfully at ${input.url}`);
  } catch (error) {
    console.error(error);
  }
}

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

interface StoredHost {
  ip: string;
  port: number;
  lastSeen: number;
}

interface StoredCache {
  lastPush: number;
  lastPull: number;
}

interface CacheData {
  hosts: StoredHost[];
  caches: Record<string, StoredCache>;
}

const SETTINGS_FILE = "settings.json";
const CACHE_COOLDOWN_MS = 60 * 60 * 1000;

export async function createGnutellaCache() {
  let data: CacheData = {
    hosts: [],
    caches: {},
  };

  async function load(): Promise<void> {
    if (!existsSync(SETTINGS_FILE)) {
      for (const url of KNOWN_CACHE_LIST) {
        data.caches[url] = {
          lastPush: 0,
          lastPull: 0,
        };
      }
      await store();
      return;
    }

    try {
      const content = await readFile(SETTINGS_FILE, "utf-8");
      const parsed = JSON.parse(content);
      data = {
        hosts: parsed.hosts || [],
        caches: parsed.caches || {},
      };
    } catch (error) {
      console.error("Failed to load settings:", error);
      data = { hosts: [], caches: {} };
    }
  }

  async function store(): Promise<void> {
    try {
      const content = JSON.stringify(data, null, 2);
      await writeFile(SETTINGS_FILE, content, "utf-8");
    } catch (error) {
      console.error("Failed to save settings:", error);
      throw error;
    }
  }

  function addPeer(ip: string, port: number, seen = Date.now()): void {
    const existingIndex = data.hosts.findIndex(
      (h) => h.ip === ip && h.port === port
    );

    if (existingIndex >= 0) {
      data.hosts[existingIndex].lastSeen = seen;
    } else {
      data.hosts.push({ ip, port, lastSeen: seen });
    }
  }

  function getHosts(): StoredHost[] {
    return [...data.hosts];
  }

  function evictHosts(cutoffMS = 1000 * 60 * 60): void {
    const cutoffTime = Date.now() - cutoffMS;
    data.hosts = data.hosts.filter((host) => host.lastSeen > cutoffTime);
  }

  function addCache(url: string): void {
    const normalizedUrl = url.trim();

    if (!data.caches[normalizedUrl]) {
      data.caches[normalizedUrl] = {
        lastPush: 0,
        lastPull: 0,
      };
    }
  }

  async function pullHostsFromCache(): Promise<void> {
    const now = Date.now();

    const availableCacheUrls = Object.entries(data.caches)
      .filter(([url, cache]) => now - cache.lastPull >= CACHE_COOLDOWN_MS)
      .map(([url]) => url);

    if (availableCacheUrls.length === 0) {
      console.log("No caches available for pulling (cooldown period)");
      return;
    }

    try {
      console.log(`Pulling hosts from ${availableCacheUrls.length} caches`);
      // Call cacheGet once with all URLs to avoid duplicate requests
      const results = await cacheGet(availableCacheUrls);

      // Update pull times for all queried caches
      for (const cacheUrl of availableCacheUrls) {
        data.caches[cacheUrl].lastPull = now;
      }

      // Process discovered peers
      for (const peer of results.peers) {
        const [ip, portStr] = peer.split(":");
        const port = parseInt(portStr, 10);
        if (!isNaN(port)) {
          addPeer(ip, port, now);
        }
      }

      // Add newly discovered caches
      for (const newCacheUrl of results.caches) {
        addCache(newCacheUrl);
      }

      await store();
      
      console.log(`Found ${results.peers.size} peers from ${results.caches.size} caches`);
      if (results.failed.length > 0) {
        console.log(`Failed to query ${results.failed.length} caches`);
      }
    } catch (error) {
      console.error(`Failed to pull from caches:`, error);
    }
  }

  function parseXTryHeaders(headers: Record<string, string>): void {
    const now = Date.now();

    const tryHeaders = ["x-try", "x-try-ultrapeer"];
    for (const headerName of tryHeaders) {
      const value = headers[headerName];
      if (value) {
        const peers = value.split(",").map((p) => p.trim());
        for (const peer of peers) {
          const [ip, portStr] = peer.split(":");
          const port = parseInt(portStr, 10);
          if (!isNaN(port)) {
            addPeer(ip, port, now);
          }
        }
      }
    }

    const hubValue = headers["x-try-hub"];
    if (hubValue) {
      const peers = hubValue.split(",").map((p) => p.trim());
      for (const peer of peers) {
        const match = peer.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)/);
        if (match) {
          const ip = match[1];
          const port = parseInt(match[2], 10);
          if (!isNaN(port)) {
            addPeer(ip, port, now);
          }
        }
      }
    }
  }

  function canPushToCache(url: string): boolean {
    const cache = data.caches[url];
    if (!cache) return false;

    const now = Date.now();
    return now - cache.lastPush >= CACHE_COOLDOWN_MS;
  }

  function updateCachePushTime(url: string): void {
    if (data.caches[url]) {
      data.caches[url].lastPush = Date.now();
    }
  }

  function getCacheUrls(): string[] {
    return Object.keys(data.caches);
  }

  return {
    load,
    store,
    addPeer,
    getHosts,
    evictHosts,
    addCache,
    pullHostsFromCache,
    parseXTryHeaders,
    canPushToCache,
    updateCachePushTime,
    getCacheUrls,
  };
}

export type GnutellaCache = Awaited<ReturnType<typeof createGnutellaCache>>;
export type { StoredHost, StoredCache };
