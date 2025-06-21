import {
  DEFAULT_PORT,
  TARGET_CONNECTIONS,
  CONNECTION_CHECK_INTERVAL,
} from "./src/const";
import { Message, Connection } from "./src/interfaces";
import { PeerStore } from "./src/peer_store";
import { ConnectionPool } from "./src/connection_pool";
import { GnutellaServer } from "./src/gnutella_server";
import {
  log,
  isDuplicate,
  adjustHopsAndTtl,
  buildPong,
  getPublicIp,
} from "./src/util";

async function main() {
  log("[MAIN] Starting Gnutella v2 protocol client...");
  const localIp = await getPublicIp();
  const localPort = DEFAULT_PORT;
  log(`[MAIN] Local IP: ${localIp}, Port: ${localPort}`);

  const headers = {
    "User-Agent": "GnutellaBun/0.1",
    "X-Ultrapeer": "False",
    "X-Query-Routing": "0.2",
    "Accept-Encoding": "deflate",
    "Listen-IP": `${localIp}:${localPort}`,
    "Bye-Packet": "0.1",
  };

  const peerStore = new PeerStore();
  await peerStore.load();

  const handleMessage = (conn: Connection, msg: Message) => {
    log(`[MAIN] Processing ${msg.type} from ${conn.id}`);

    // Handle duplicate detection and hop accounting for routable messages
    if (
      msg.header &&
      ["ping", "pong", "query", "queryhits", "push"].includes(msg.type)
    ) {
      if (isDuplicate(msg.header)) {
        log(`[MAIN] Dropping duplicate ${msg.type} from ${conn.id}`);
        return;
      }

      // Don't forward if TTL exhausted
      if (!adjustHopsAndTtl(msg.header)) {
        log(`[MAIN] Dropping ${msg.type} from ${conn.id} - TTL exhausted`);
        return;
      }
    }

    switch (msg.type) {
      case "ping":
        if (conn.handshake) {
          log(`[MAIN] Responding to PING from ${conn.id} with PONG`);
          // Use ping.hops + 1 as TTL for the pong
          const pongTtl = Math.max(msg.header!.hops + 1, 7);
          conn.send(
            buildPong(
              msg.header!.descriptorId,
              localPort,
              localIp,
              0,
              0,
              pongTtl,
            ),
          );
        } else {
          log(`[MAIN] Ignoring PING from ${conn.id} - handshake not complete`);
        }
        break;

      case "pong":
        log(
          `[MAIN] Received PONG from ${conn.id}: ${msg.ipAddress}:${msg.port}`,
        );
        peerStore.add(msg.ipAddress, msg.port);
        log(`[MAIN] Added peer ${msg.ipAddress}:${msg.port} to store`);
        break;

      case "query":
        log(
          `[MAIN] Query from ${conn.id}: "${msg.searchCriteria.slice(0, 2)}..."`,
        );
        if (msg.extensions) {
          log(`[MAIN] Query has extensions (GGEP/HUGE)`);
        }
        break;

      case "qrp_reset":
        log(
          `[MAIN] Received QRP RESET from ${conn.id}, table size: ${msg.tableLength}`,
        );
        break;

      case "qrp_patch":
        log(
          `[MAIN] Received QRP PATCH from ${conn.id}, seq ${msg.seqNo}/${msg.seqCount}`,
        );
        break;

      case "bye":
        log(
          `[MAIN] Received BYE from ${conn.id}: ${msg.code} - ${msg.message}`,
        );
        break;

      case "handshake_error":
        log(
          `[MAIN] Handshake error from ${conn.id}: ${msg.code} - ${msg.message}`,
        );
        break;
      default:
        log(`[MAIN] Unhandled message type: ${msg.type} from ${conn.id}`);
    }
  };

  const server = new GnutellaServer({ onMessage: handleMessage, headers });
  await server.start(localPort);
  log(`[MAIN] Server listening on ${localIp}:${localPort}`);

  const pool = new ConnectionPool({
    targetCount: TARGET_CONNECTIONS,
    onMessage: handleMessage,
    headers,
    localIp,
    localPort,
  });

  const maintainConnections = async () => {
    const activeCount = pool.getActiveCount();
    log(`[MAINTAIN] Active connections: ${activeCount}/${TARGET_CONNECTIONS}`);

    if (!pool.needsConnections()) {
      log(`[MAINTAIN] Target connections reached, skipping`);
      return;
    }

    const peers = peerStore.get(10);
    log(`[MAINTAIN] Found ${peers.length} peers in store`);

    for (const peer of peers) {
      log(`[MAINTAIN] Attempting to connect to ${peer.ip}:${peer.port}`);
      pool.connectToPeer(peer.ip, peer.port);
      if (!pool.needsConnections()) break;
    }
  };

  setInterval(maintainConnections, CONNECTION_CHECK_INTERVAL);
  setInterval(() => {
    log("[MAIN] Saving peer store...");
    peerStore.save();
  }, 60000);
  setInterval(() => {
    log("[MAIN] Pruning old peers...");
    peerStore.prune();
  }, 3600000);

  await maintainConnections();

  process.on("SIGINT", async () => {
    log("\n[MAIN] Shutting down...");
    log("[MAIN] Closing connection pool...");
    pool.close();
    log("[MAIN] Stopping server...");
    await server.stop();
    log("[MAIN] Saving peer store...");
    await peerStore.save();
    log("[MAIN] Shutdown complete");
    process.exit(0);
  });
}

main().catch(log);
