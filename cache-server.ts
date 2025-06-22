#!/usr/bin/env bun

interface Host {
  ip: string;
  port: number;
  network: string;
  addedAt: number;
  cluster?: string;
}

interface Cache {
  url: string;
  network: string;
  addedAt: number;
}

interface RateLimit {
  lastAccess: number;
  count: number;
}

const hosts: Host[] = [];
const caches: Cache[] = [];
const rateLimits = new Map<string, RateLimit>();

const CONFIG = {
  MAX_HOSTS: 500,
  MAX_CACHES: 20,
  MAX_HOSTS_PER_RESPONSE: 20,
  MAX_CACHES_PER_RESPONSE: 10,
  HOST_EXPIRY_SECONDS: 3 * 24 * 60 * 60,
  CACHE_EXPIRY_SECONDS: 14 * 24 * 60 * 60,
  RATE_LIMIT_SECONDS: 1,
  CACHE_NAME: "LastCache",
  CACHE_VERSION: "1.0",
  SUPPORTED_NETWORKS: ["gnutella", "gnutella2"],
  TEXT_PLAIN: { "Content-Type": "text/plain" },
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 8080,
};

function getClientIP(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "127.0.0.1";
}

function isValidIP(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;

  const nums = parts.map((p) => parseInt(p));
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return false;

  const [first, second] = nums;
  const isPrivate =
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);

  return !isPrivate;
}

function isValidPort(port: number): boolean {
  return port > 0 && port <= 65535;
}

function checkRateLimit(clientIP: string): {
  allowed: boolean;
  warning?: string;
} {
  // Skip rate limiting in test mode
  if (process.env.TEST_MODE === "true") {
    return { allowed: true };
  }

  const now = Date.now();
  const limit = rateLimits.get(clientIP);

  if (!limit) {
    rateLimits.set(clientIP, { lastAccess: now, count: 1 });
    return { allowed: true };
  }

  const timeSinceLastAccess = (now - limit.lastAccess) / 1000;
  if (timeSinceLastAccess < CONFIG.RATE_LIMIT_SECONDS) {
    return { allowed: false, warning: "You came back too early" };
  }

  limit.lastAccess = now;
  limit.count++;
  return { allowed: true };
}

function cleanupOldEntries() {
  const now = Date.now();

  const removeExpired = <T extends { addedAt: number }>(
    arr: T[],
    expirySeconds: number
  ) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if ((now - arr[i].addedAt) / 1000 > expirySeconds) {
        arr.splice(i, 1);
      }
    }
  };

  removeExpired(hosts, CONFIG.HOST_EXPIRY_SECONDS);
  removeExpired(caches, CONFIG.CACHE_EXPIRY_SECONDS);
}

function validateAndAdd<T>({
  item,
  collection,
  validator,
  finder,
  maxSize,
  updateMessage = "updated",
}: {
  item: T;
  collection: T[];
  validator: () => string | null;
  finder: (items: T[]) => number;
  maxSize: number;
  updateMessage?: string;
}): string {
  const error = validator();
  if (error) return error;

  const existingIndex = finder(collection);
  if (existingIndex !== -1) {
    (collection[existingIndex] as any).addedAt = Date.now();
    return `OK|${updateMessage}`;
  }

  collection.push(item);

  if (collection.length > maxSize) {
    collection.sort((a: any, b: any) => a.addedAt - b.addedAt);
    collection.shift();
  }

  return "OK";
}

export function addPeer(
  ip: string,
  port: number,
  network: string,
  cluster?: string
): string {
  const newHost: Host = { ip, port, network, addedAt: Date.now() };
  if (cluster) newHost.cluster = cluster;

  return validateAndAdd({
    item: newHost,
    collection: hosts,
    validator: () => {
      if (!isValidIP(ip)) return "WARNING|Invalid IP";
      if (!isValidPort(port)) return "WARNING|Invalid port";
      if (!CONFIG.SUPPORTED_NETWORKS.includes(network))
        return "WARNING|Unsupported network";
      return null;
    },
    finder: (items) =>
      items.findIndex(
        (h) => h.ip === ip && h.port === port && h.network === network
      ),
    maxSize: CONFIG.MAX_HOSTS,
    updateMessage: "Host updated",
  });
}

export function resetState() {
  hosts.length = 0;
  caches.length = 0;
  rateLimits.clear();
}

export function addCache(url: string, network: string): string {
  const newCache: Cache = { url, network, addedAt: Date.now() };

  return validateAndAdd({
    item: newCache,
    collection: caches,
    validator: () => {
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return "WARNING|Invalid URL protocol";
        }
      } catch {
        return "WARNING|Invalid URL";
      }
      if (!CONFIG.SUPPORTED_NETWORKS.includes(network))
        return "WARNING|Unsupported network";
      return null;
    },
    finder: (items) =>
      items.findIndex((c) => c.url === url && c.network === network),
    maxSize: CONFIG.MAX_CACHES,
    updateMessage: "Cache updated",
  });
}

function getRandomItems<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return [...items].sort(() => Math.random() - 0.5).slice(0, limit);
}

function getHostsForNetwork(network: string, limit: number): Host[] {
  return getRandomItems(
    hosts.filter((h) => h.network === network),
    limit
  );
}

function getCachesForNetwork(network: string, limit: number): Cache[] {
  return getRandomItems(
    caches.filter((c) => c.network === network),
    limit
  );
}

function formatSpec2Response(params: URLSearchParams, network: string): string {
  const lines: string[] = [];
  const now = Date.now();

  if (params.has("ping")) {
    const networks = CONFIG.SUPPORTED_NETWORKS.join("-");
    lines.push(
      `I|pong|${CONFIG.CACHE_NAME} ${CONFIG.CACHE_VERSION}|${networks}`
    );
  }

  const hostList = getHostsForNetwork(network, CONFIG.MAX_HOSTS_PER_RESPONSE);
  const cacheList = getCachesForNetwork(
    network,
    CONFIG.MAX_CACHES_PER_RESPONSE
  );

  hostList.forEach((host) => {
    const age = Math.floor((now - host.addedAt) / 1000);
    const cluster =
      host.cluster && params.has("getclusters") ? `|${host.cluster}` : "";
    lines.push(`H|${host.ip}:${host.port}|${age}${cluster}`);
  });

  cacheList.forEach((cache) => {
    const age = Math.floor((now - cache.addedAt) / 1000);
    lines.push(`U|${cache.url}|${age}`);
  });

  return lines.join("\n");
}

let server: any;

export function startServer() {
  server = Bun.serve({
    port: CONFIG.PORT,
    fetch(req) {
      const url = new URL(req.url);
      const params = url.searchParams;
      const clientIP = getClientIP(req);

      if (req.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      cleanupOldEntries();

    const rateCheck = checkRateLimit(clientIP);
    const hasUpdate =
      params.has("ip") || params.has("url") || params.has("update");
    const network = params.get("net") || "gnutella";

    if (!CONFIG.SUPPORTED_NETWORKS.includes(network)) {
      return new Response("Required network not accepted", { status: 503 });
    }

    const responseLines: string[] = [];

    if (!rateCheck.allowed && !hasUpdate) {
      return new Response(`I|WARNING|${rateCheck.warning}\n`, {
        headers: CONFIG.TEXT_PLAIN,
      });
    }

    if (hasUpdate) {
      const updateResults: string[] = [];

      if (params.has("ip")) {
        const ipParam = params.get("ip")!;
        const [ip, portStr] = ipParam.split(":");
        const port = parseInt(portStr);

        updateResults.push(
          ip && !isNaN(port)
            ? addPeer(ip, port, network, params.get("cluster") || undefined)
            : "WARNING|Invalid IP format"
        );
      }

      if (params.has("url")) {
        updateResults.push(addCache(params.get("url")!, network));
      }

      updateResults.forEach((result) => {
        const formattedResult = result.startsWith("OK")
          ? `I|update|OK`
          : `I|update|${result}`;
        responseLines.push(formattedResult);
      });

      if (!params.has("get")) {
        return new Response(responseLines.join("\n") + "\n", {
          headers: CONFIG.TEXT_PLAIN,
        });
      }
    }

    if (params.toString() === "") {
      return new Response(generateIndexHTML(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    const spec2Response = formatSpec2Response(params, network);
    const fullResponse =
      responseLines.length > 0
        ? `${responseLines.join("\n")}\n${spec2Response}\n`
        : `${spec2Response}\n`;

    return new Response(fullResponse, { headers: CONFIG.TEXT_PLAIN });
  },
});
  return server;
}

function generateIndexHTML(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>GWebCache - ${CONFIG.CACHE_NAME}</title>
  <style>
    body { font-family: monospace; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 24px; }
    h2 { font-size: 18px; margin-top: 30px; }
    pre { background: #f4f4f4; padding: 10px; overflow-x: auto; }
    .stats { margin: 20px 0; }
  </style>
</head>
<body>
  <h1>GWebCache - ${CONFIG.CACHE_NAME} v${CONFIG.CACHE_VERSION}</h1>
  <p>A simple GWebCache implementation for Gnutella/Gnutella2 networks.</p>
  
  <div class="stats">
    <strong>Current Status:</strong><br>
    Active Hosts: ${hosts.length}<br>
    Active Caches: ${caches.length}<br>
    Supported Networks: ${CONFIG.SUPPORTED_NETWORKS.join(", ")}
  </div>

  <h2>Usage Examples</h2>
  
  <h3>Get hosts:</h3>
  <pre>GET /?get=1&net=gnutella</pre>
  
  <h3>Update and get:</h3>
  <pre>GET /?ip=192.168.1.1:6346&get=1&net=gnutella2</pre>
  
  <h3>Ping cache:</h3>
  <pre>GET /?ping=1</pre>

  <h2>Documentation</h2>
  <p>This cache implements GWebCache Spec 2.0 protocol.</p>
  <p>For detailed specifications, see the GWebCache documentation.</p>
</body>
</html>`;
}

// Only start server when run directly, not when imported
if (import.meta.main) {
  const server = startServer();
  console.log(`GWebCache running on http://localhost:${server.port}`);
}
