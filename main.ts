import { DEFAULT_PORT } from "./src/const";
import { Message, Connection } from "./src/interfaces";
import { PeerStore } from "./src/peer_store";
import { GnutellaServer } from "./src/gnutella_server";
import {
  log,
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
  log(`[MAIN] Also sharing test.mp3 and music.mp3 for testing`);

  const handleMessage = (conn: Connection, msg: Message) => {
    log(`[MAIN] Processing ${msg.type} from ${conn.id}`);
    // Log all messages with details
    if (msg.type === "query") {
      log(
        `[DEBUG] Query: "${msg.searchCriteria}" MinSpeed: ${msg.minimumSpeed}`
      );
    }

    // Handle duplicate detection and hop accounting for routable messages
    if (
      msg.header &&
      ["pong", "query", "queryhits", "push"].includes(msg.type)
    ) {
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
              pongTtl
            )
          );
        } else {
          log(`[MAIN] Ignoring PING from ${conn.id} - handshake not complete`);
        }
        break;

      case "pong":
        log(
          `[MAIN] Received PONG from ${conn.id}: ${msg.ipAddress}:${msg.port}`
        );
        peerStore.add(msg.ipAddress, msg.port);
        log(`[MAIN] Added peer ${msg.ipAddress}:${msg.port} to store`);
        break;

      case "query":
        log(`[MAIN] Query from ${conn.id}: "${msg.searchCriteria}"`);
        break;

      case "bye":
        log(
          `[MAIN] Received BYE from ${conn.id}: ${msg.code} - ${msg.message}`
        );
        break;

      case "handshake_error":
        log(
          `[MAIN] Handshake error from ${conn.id}: ${msg.code} - ${msg.message}`
        );
        break;

      case "handshake_ok":
        log(`[MAIN] Handshake OK from ${conn.id}`);
        break;

      default:
        log(`[MAIN] Unhandled message type: ${msg.type} from ${conn.id}`);
    }
  };

  const server = new GnutellaServer({
    onMessage: (conn, msg) => {
      handleMessage(conn, msg);
    },
    headers,
  });
  await server.start(localPort);
  log(`[MAIN] Server listening on ${localIp}:${localPort}`);

  setInterval(() => {
    log("[MAIN] Saving peer store...");
    peerStore.save();
  }, 60000);
  setInterval(() => {
    log("[MAIN] Pruning old peers...");
    peerStore.prune();
  }, 3600000);
  process.on("SIGINT", async () => {
    log("\n[MAIN] Shutting down...");
    log("[MAIN] Closing connection pool...");
    log("[MAIN] Stopping server...");
    await server.stop();
    log("[MAIN] Saving peer store...");
    await peerStore.save();
    log("[MAIN] Shutdown complete");
    process.exit(0);
  });
}

main().catch(log);
