import { DEFAULT_PORT, SERVENT_ID } from "./src/const";
import { Message, Connection } from "./src/interfaces";
import { PeerStore } from "./src/peer_store";
import { GnutellaServer } from "./src/gnutella_server";
import { SharedFileManager } from "./src/shared_files";
import { QrpTable } from "./src/qrp_table";
import {
  log,
  adjustHopsAndTtl,
  buildPong,
  buildQueryHit,
  buildQrpReset,
  buildQrpPatch,
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

  // Set up shared files
  const sharedFiles = new SharedFileManager();
  const targetFile = "bird watchers handbook audio 01jy9ysw 2.mp3";
  const fileSize = 1 * 1024 * 1024; // 1MB dummy size
  sharedFiles.addFile(targetFile, fileSize);
  log(`[MAIN] Sharing file: ${targetFile}`);
  // Also add some common test files for easier searching
  sharedFiles.addFile("test.mp3", 2 * 1024 * 1024);
  sharedFiles.addFile("music.mp3", 3 * 1024 * 1024);
  log(`[MAIN] Also sharing test.mp3 and music.mp3 for testing`);

  // Test QRP hash function
  log("[MAIN] Testing QRP hash function...");
  QrpTable.testHash();
  // Initialize QRP table
  const qrpTable = new QrpTable();
  const keywords = sharedFiles.getKeywords();
  qrpTable.addKeywords(keywords);
  log(`[MAIN] QRP table initialized with keywords: ${keywords.join(", ")}`);

  // Track connections for QRP updates
  const activeConnections = new Set<Connection>();

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
        if (msg.extensions) {
          log(`[MAIN] Query has extensions (GGEP/HUGE)`);
        }

        // Always try to search even if QRP might filter it
        log(`[MAIN] Bypassing QRP check - searching anyway`);

        // Search our shared files
        const matches = sharedFiles.searchFiles(msg.searchCriteria);
        if (matches.length > 0) {
          log(`[MAIN] Found ${matches.length} matches for query`);
          const hits = matches.map((file) => ({
            index: file.index,
            size: file.size,
            filename: file.filename,
          }));

          const queryHit = buildQueryHit(
            msg.header!.descriptorId,
            localPort,
            localIp,
            hits,
            SERVENT_ID
          );

          conn.send(queryHit);
          log(`[MAIN] Sent query hit with ${hits.length} results`);
        } else {
          log(`[MAIN] No matches found for query: "${msg.searchCriteria}"`);
        }
        break;

      case "qrp_reset":
        log(
          `[MAIN] Received QRP RESET from ${conn.id}, table size: ${msg.tableLength}, infinity: ${msg.infinity}`
        );
        break;

      case "qrp_patch":
        log(
          `[MAIN] Received QRP PATCH from ${conn.id}, seq ${msg.seqNo}/${msg.seqCount}, compression: ${msg.compression}, bits: ${msg.entryBits}`
        );
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

  const sendQrpTable = (conn: Connection) => {
    log(`[MAIN] Sending QRP table to ${conn.id}`);

    // Send RESET
    const reset = buildQrpReset(65536);
    conn.send(reset);

    // Send table as patches
    const tableData = qrpTable.toBuffer();
    const chunkSize = 1024; // Send 1KB chunks
    const totalChunks = Math.ceil(tableData.length / chunkSize);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, tableData.length);
      const chunk = tableData.slice(start, end);

      log(
        `[MAIN] Sending QRP PATCH ${i + 1}/${totalChunks}, size: ${
          chunk.length
        } bytes`
      );
      const patch = buildQrpPatch(i + 1, totalChunks, 1, chunk);
      conn.send(patch);
    }

    log(
      `[MAIN] Sent QRP table (${tableData.length} bytes) in ${totalChunks} patches`
    );
  };

  const server = new GnutellaServer({
    onMessage: (conn, msg) => {
      handleMessage(conn, msg);
      // For server connections, send QRP after they complete handshake
      if (
        msg.type === "handshake_ok" &&
        conn.isServer &&
        conn.handshake &&
        !activeConnections.has(conn)
      ) {
        activeConnections.add(conn);
        sendQrpTable(conn);
      }
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
