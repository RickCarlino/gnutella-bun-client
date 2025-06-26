import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import Index from "../templates/index.tsx";
import { GnutellaNode } from "./gnutella-node.ts";
import { Binary } from "./binary.ts";

export function createServer(gnutella: GnutellaNode) {
  const app = new Hono();

  app.get("/uri-res/N2R", async (c) => {
    const url = new URL(c.req.url);
    const query = url.search.slice(1); // Remove the leading '?'

    console.log(`Handling URN request: ${query}`);

    const sha1Match = query.match(/^urn:sha1:([A-Z2-7=]+)/i);
    if (!sha1Match) {
      return c.text("Invalid URN format", 400);
    }

    const requestedSha1 = sha1Match[1];
    const files = gnutella.getSharedFiles();

    const file = files.find((file) => {
      return Binary.toBase32(file.sha1) === requestedSha1;
    });

    if (!file) {
      return c.text(`File not found for SHA1: ${requestedSha1}`, 404);
    }

    const handler = serveStatic({
      root: "./gnutella-library",
      rewriteRequestPath: () => file.filename,
    });

    return handler(c, async () => {});
  });

  const staticConf = serveStatic({
    root: "./gnutella-library",
    rewriteRequestPath(path) {
      return path.replace(/^\/file/, "");
    },
  });

  app.use("/file/*", staticConf);

  // Home page
  app.get("/", async (c) => {
    return c.html(<Index />);
  });

  return app;
}
