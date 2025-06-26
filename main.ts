import { CONFIG } from "./src/config";
import { GnutellaNode } from "./src/gnutella-node";

if (import.meta.main) {
  Bun.serve({
    port: CONFIG.httpPort,
    fetch(req) {
      console.log(req);
      throw new Error("HTTP server not implemented");
    },
  });

  const node = new GnutellaNode();
  await node.start();
}
