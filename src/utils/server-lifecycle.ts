import net from "net";
import type { ServerConfig } from "../types";

export interface ServerLifecycle {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function createServerLifecycle(
  server: net.Server,
  config: ServerConfig,
  cleanup: () => void
): ServerLifecycle {
  return {
    start: (): Promise<void> =>
      new Promise((resolve, reject) => {
        server.listen(config.port, config.host || "0.0.0.0", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            console.log(
              `Gnutella server listening on ${addr.address}:${addr.port}`
            );
          }
          resolve();
        });
        server.on("error", reject);
      }),

    stop: (): Promise<void> =>
      new Promise((resolve) => {
        cleanup();
        server.close(() => {
          console.log("Gnutella server stopped");
          resolve();
        });
      }),
  };
}