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

const KNOWN_CACHE_LIST = [
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
      // H|IP:port|age[|cluster][|leaves][|vendor][|uptime]
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
      // U|http://cache.url[:port]/path|age
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
      // I|pong|..., I|update|..., I|WARNING|...
      result.info.push(line);
    }
  }

  return result;
}

// Given a list of URLs, fetches a list of IP addresses on the gnutella network.
// This function will recursively call "U" entries and add them to the returned `caches` set
// if the call succeeds.
// Errors are collected in the `failed` array.
// "I" entries are logged to the console.
// Please hard code a "ping" param in your request.
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

    // Skip if already visited
    if (visited.has(url)) {
      continue;
    }
    visited.add(url);

    try {
      // Build request URL with spec 2 parameters
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

      // Log info lines
      for (const info of parsed.info) {
        console.log(`[${url}] ${info}`);
      }

      // Add hosts to results
      for (const host of parsed.hosts) {
        results.peers.add(host.ip);
      }

      // Add caches to results and queue for recursive fetch
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

    // Add spec 2 update parameters
    requestUrl.searchParams.set("update", "1");
    requestUrl.searchParams.set("net", input.network.toLowerCase());
    requestUrl.searchParams.set("ip", input.ip);
    requestUrl.searchParams.set("client", "GNUT");
    requestUrl.searchParams.set("version", "0.1.0");
    requestUrl.searchParams.set("ping", "1");

    const response = await fetch(requestUrl.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const parsed = parseSpec2Response(text);

    // Log all info lines (includes update status)
    for (const info of parsed.info) {
      console.log(`[${input.url}] ${info}`);
    }

    // Check for update confirmation
    const updateStatus = parsed.info.find((line) => line.includes("update"));
    if (updateStatus && !updateStatus.includes("|OK")) {
      throw new Error(`Update failed: ${updateStatus}`);
    }
  } catch (error) {
    console.error(`Failed to update cache at ${input.url}:`, error);
    throw error;
  }
}

console.log(await cacheGet(KNOWN_CACHE_LIST));
