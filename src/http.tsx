import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import Index from "../templates/index.tsx";
import { GnutellaNode } from "./gnutella-node.ts";

export function createServer(gnutella: GnutellaNode) {
  const app = new Hono();
  const staticConf = serveStatic({
    root: "../gnutella-library",
    rewriteRequestPath(path) {
      console.log(`==== ??? Rewriting request path: ${path}`);
      const files = gnutella.getSharedFiles();

      // Example of incoming request:
      // /uri-res/N2R?urn:sha1:XKMJALOQS2SFZA442DDWMSXQEAPEABQQ
      const file = files.find((file) => {
        file.sha1 === path.replace(/^\/uri-res\/N2R\?urn:sha1:/, "");
      });
      if (!file) {
        throw new Error(`File not found for path: ${path}`);
      }
      console.log(`==== ??? File not found for path: ${path}`);
      return file?.filename;
    },
  });
  // Static files → http://localhost:3000/static/…
  app.use("/uri-res/*", staticConf);

  // Home page
  app.get("/", async (c) => {
    return c.html(<Index />);
  });

  return app;
}
