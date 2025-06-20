import { createGnutellaServer } from "./src/server";
import {
  createHandshakeOk,
  createHandshakeError,
} from "./src/parser";
import { cachePut } from "./src/cache-client";
import { getCache } from "./src/cache-client";
import { createConnectionManager } from "./src/connection-manager";
import { handlePing } from "./src/utils/message-handlers";

export const localIp = async () => {
  const response = await fetch(CHECK_URL);
  const ip = await response.text();
  return ip.trim();
};

const CHECK_URL = "https://wtfismyip.com/text";
const LOCAL_IP = await localIp();
const LOCAL_PORT = 6346;
const MAX_CONNECTIONS = 10;
const TARGET_OUTBOUND_CONNECTIONS = 4;
const CONNECTION_CHECK_INTERVAL = 10000; // 10 seconds
const HANDSHAKE_TIMEOUT = 5000; // 5 seconds

const HEADERS = {
  "User-Agent": "GnutellaBun/0.1",
  "X-Ultrapeer": "False",
  "Listen-IP": `${LOCAL_IP}:${LOCAL_PORT}`,
  "Remote-IP": LOCAL_IP,
};

async function main() {
  console.log("Starting Gnutella node...");
  console.log(`Local IP: ${LOCAL_IP}`);

  // Initialize cache
  const cache = await getCache();
  console.log("Cache loaded");

  // Bootstrap peer list
  console.log("Bootstrapping peer list...");
  await cache.pullHostsFromCache();
  const hosts = cache.getHosts();
  console.log(`Found ${hosts.length} peers`);

  // Create server with handler
  const server = createGnutellaServer({
    port: LOCAL_PORT,
    host: "0.0.0.0",
    maxConnections: MAX_CONNECTIONS,
    headers: HEADERS,
    handler: {
      onConnect: (clientId) => {
        console.log(`[${clientId}] Connected`);
      },

      onMessage: (clientId, send, msg) => {
        console.log(`[${clientId}] Received:`, msg.type);

        switch (msg.type) {
          case "handshake_connect":
            console.log(`[${clientId}] Handshake request v${msg.version}`);

            switch (msg.version) {
              case "0.6":
                send(createHandshakeOk(HEADERS));
                server.setClientHandshake(clientId, msg.version);
                console.log(`[${clientId}] Handshake accepted`);
                break;
              default:
                send(
                  createHandshakeError(503, "Service Unavailable", {
                    "X-Try": "gnutella.com:6346",
                  })
                );
                console.log(
                  `[${clientId}] Handshake rejected - unsupported version`
                );
                break;
            }
            break;

          case "ping":
            const isHandshakeComplete = server.getClients().find((c) => c.id === clientId)?.handshake || false;
            handlePing(msg, {
              localPort: LOCAL_PORT,
              localIp: LOCAL_IP,
              send,
            }, isHandshakeComplete);
            if (isHandshakeComplete) {
              console.log(`[${clientId}] Responded to ping`);
            }
            break;

          case "pong":
            console.log(`[${clientId}] Pong from ${msg.ipAddress}:${msg.port}`);
            cache.addPeer(msg.ipAddress, msg.port);
            break;

          case "query":
            console.log(`[${clientId}] Query: "${msg.searchCriteria}"`);
            break;

          case "queryhits":
            console.log(`[${clientId}] QueryHits: ${msg.numberOfHits} results`);
            break;

          case "push":
            console.log(`[${clientId}] Push request`);
            break;

          case "bye":
            console.log(`[${clientId}] Bye: ${msg.code} ${msg.message}`);
            break;
        }
      },

      onError: (clientId, _, error) => {
        console.error(`[${clientId}] Error:`, error.message);
      },

      onClose: (clientId) => {
        console.log(`[${clientId}] Disconnected`);
      },
    },
  });

  // Start server
  await server.start();
  console.log(`Gnutella server listening on ${LOCAL_IP}:${LOCAL_PORT}`);
  console.log(`Max connections: ${MAX_CONNECTIONS}`);

  // Push IP to all GWebCaches
  console.log("Pushing IP to GWebCaches...");
  let successCount = 0;
  const cacheUrls = cache.getCacheUrls();

  for (const url of cacheUrls) {
    if (cache.canPushToCache(url)) {
      try {
        await cachePut({
          url,
          network: "Gnutella",
          ip: LOCAL_IP,
        });
        cache.updateCachePushTime(url);
        successCount++;
        console.log(`✓ Pushed to ${url}`);
      } catch (error) {
        console.error(`✗ Failed to push to ${url}:`, error);
      }
    }
  }

  console.log(`Pushed IP to ${successCount} caches`);
  await cache.store();

  // Start connection manager for outbound connections
  const connectionManager = createConnectionManager({
    targetConnections: TARGET_OUTBOUND_CONNECTIONS,
    checkInterval: CONNECTION_CHECK_INTERVAL,
    handshakeTimeout: HANDSHAKE_TIMEOUT,
    localIp: LOCAL_IP,
    localPort: LOCAL_PORT,
    headers: HEADERS,
    onConnectionsChanged: (activeCount) => {
      console.log(
        `[Outbound] Active connections: ${activeCount}/${TARGET_OUTBOUND_CONNECTIONS}`
      );
    },
  });

  await connectionManager.start();
  console.log("Connection manager started");

  // Status monitoring
  const statusInterval = setInterval(() => {
    const inboundClients = server.getClients();
    const outboundConnections = connectionManager.getConnections();

    console.log(`\n=== Connection Status ===`);
    console.log(`Inbound connections: ${inboundClients.length}`);
    inboundClients.forEach((client) => {
      console.log(
        `  [IN]  ${client.handshake ? "✓" : "…"} ${client.id}${
          client.version ? ` (v${client.version})` : ""
        }`
      );
    });

    console.log(`\nOutbound connections: ${outboundConnections.length}`);
    outboundConnections.forEach((conn) => {
      const duration = Math.floor(conn.duration / 1000);
      console.log(
        `  [OUT] ${conn.handshake ? "✓" : "…"} ${conn.address}${
          conn.version ? ` (v${conn.version})` : ""
        } (${duration}s)`
      );
    });
  }, 30000); // Every 30 seconds

  // Periodic cache update (every hour)
  const cacheUpdateInterval = setInterval(async () => {
    console.log("\nUpdating caches...");

    for (const url of cache.getCacheUrls()) {
      if (cache.canPushToCache(url)) {
        try {
          await cachePut({
            url,
            network: "Gnutella",
            ip: LOCAL_IP,
          });
          cache.updateCachePushTime(url);
          console.log(`✓ Updated cache: ${url}`);
        } catch (error) {
          console.error(`✗ Failed to update cache ${url}:`, error);
        }
      }
    }

    await cache.store();
  }, 60 * 60 * 1000); // Every hour

  // Periodic peer discovery (every 2 hours)
  const peerDiscoveryInterval = setInterval(async () => {
    console.log("\nDiscovering new peers...");
    await cache.pullHostsFromCache();
    await cache.evictHosts(); // Remove stale hosts
    await cache.store();
    const hosts = cache.getHosts();
    console.log(`Active peers: ${hosts.length}`);
  }, 1.01 * 60 * 60 * 1000); // Every hour

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\nShutting down Gnutella node...");
    clearInterval(statusInterval);
    clearInterval(cacheUpdateInterval);
    clearInterval(peerDiscoveryInterval);
    connectionManager.stop();
    await server.stop();
    await cache.store();
    console.log("Goodbye!");
    process.exit(0);
  });

  console.log("\nGnutella node is running. Press Ctrl+C to stop.");
}

// Run the main function
main().catch((error) => {
  console.error("Failed to start Gnutella node:", error);
  process.exit(1);
});
