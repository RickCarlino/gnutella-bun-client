import net from "node:net";
import type { GnutellaServentCollaborators } from "../../src/types";

type Exchange = {
  id: number;
  direction: "inbound" | "outbound";
  received: string[];
};

/** Create a network factory that records received wire bytes. */
export function captureNetwork() {
  const exchanges: Exchange[] = [];
  function observe(
    socket: net.Socket,
    direction: Exchange["direction"],
  ): net.Socket {
    const exchange: Exchange = {
      id: exchanges.length + 1,
      direction,
      received: [],
    };
    exchanges.push(exchange);
    socket.on("data", (chunk) =>
      exchange.received.push(Buffer.from(chunk).toString("base64")),
    );
    return socket;
  }
  const netFactory: GnutellaServentCollaborators["netFactory"] = {
    createConnection: (options) =>
      observe(
        net.createConnection(
          "port" in options
            ? { ...options, localAddress: "10.44.0.1" }
            : options,
        ),
        "outbound",
      ),
    createServer: (listener) =>
      net.createServer((socket) => listener(observe(socket, "inbound"))),
  };
  return { exchanges, netFactory };
}
