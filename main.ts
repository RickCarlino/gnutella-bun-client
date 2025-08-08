import { serve } from "bun";
import { CONFIG } from "./src/const";
import { GnutellaNode } from "./src/gnutella-node";
import { createServer } from "./src/http";
import { log } from "./src/log";

if (import.meta.main) {
  log.info("Main", "Starting Gnutella Bun client...");
  const node = new GnutellaNode();
  const app = createServer(node);
  serve({
    port: CONFIG.httpPort,
    fetch: app.fetch,
  });
  log.info("Main", "HTTP server listening", { port: CONFIG.httpPort });
  log.info("Main", "Starting Gnutella node...");
  await node.start();
  log.info("Main", "Gnutella node started");
}
