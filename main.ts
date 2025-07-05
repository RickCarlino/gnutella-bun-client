import { serve } from "bun";
import { CONFIG } from "./src/config";
import { GnutellaNode } from "./src/gnutella-node";
import { createServer } from "./src/http";

if (import.meta.main) {
  const node = new GnutellaNode();
  const app = createServer(node);
  serve({
    port: CONFIG.httpPort,
    fetch: app.fetch,
  });
  await node.start();
  // Test comment - testing hook again
}
