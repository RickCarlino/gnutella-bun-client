import net from "net";
import { GnutellaObject, parseGnutella } from "./parser";
import os from "os";
import { createHandshakeOk, createHandshakeError, createPong } from "./parser";

type Sender = (message: Buffer) => void;

interface InboundConnectionHandler {
  onMessage: (clientId: string, send: Sender, message: GnutellaObject) => void;
  onError: (clientId: string, send: Sender, error: Error) => void;
  onClose: (clientId: string) => void;
  onConnect: (clientId: string, send: Sender) => void;
}

interface ServerConfig {
  port: number;
  host?: string;
  maxConnections?: number;
  headers?: Record<string, string>;
  handler: InboundConnectionHandler;
}

interface ClientInfo {
  socket: net.Socket;
  handshake: boolean;
  version?: string;
}

interface GnutellaServerState {
  server: net.Server;
  clients: Map<string, ClientInfo>;
  config: ServerConfig;
}

const handshakeSize = (buf: Buffer): number => {
  const s = buf.toString("ascii");
  const v06 = s.indexOf("\r\n\r\n");
  if (v06 !== -1) return v06 + 4;
  return 0;
};

const binarySize = (parsed: GnutellaObject): number => {
  switch (parsed.type) {
    case "handshake_connect":
    case "handshake_ok":
    case "handshake_error":
      throw new Error("Invalid message type for binary size calculation");
    default:
      return 23 + parsed.header.payloadLength;
  }
};

const messageSize = (m: GnutellaObject, buf: Buffer): number =>
  ["handshake_connect", "handshake_ok", "handshake_error"].includes(m.type)
    ? handshakeSize(buf)
    : binarySize(m);

const handleConnection = (state: GnutellaServerState, socket: net.Socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`New connection from ${clientId}`);

  const send: Sender = (data) => socket.write(data);
  let buf = Buffer.alloc(0);

  state.clients.set(clientId, { socket, handshake: false });
  state.config.handler.onConnect(clientId, send);

  const process = () => {
    while (buf.length) {
      const parsed = parseGnutella(buf);
      if (!parsed) return;

      const size = messageSize(parsed, buf);
      if (size === 0 || buf.length < size) return;

      state.config.handler.onMessage(clientId, send, parsed);
      buf = buf.subarray(size);
    }
  };

  socket.on("data", (chunk) => {
    console.log(`Received data from ${clientId}: ${chunk.length} bytes`);
    console.log(chunk.toString("ascii"));
    buf = Buffer.concat([buf, chunk]);
    try {
      process();
    } catch (e) {
      state.config.handler.onError(clientId, send, e as Error);
    }
  });

  socket.on("error", (e) => {
    state.config.handler.onError(clientId, send, e);
    state.clients.delete(clientId);
  });

  socket.on("close", () => {
    state.config.handler.onClose(clientId);
    state.clients.delete(clientId);
  });
};

export function createGnutellaServer(config: ServerConfig) {
  const state: GnutellaServerState = {
    server: net.createServer(),
    clients: new Map(),
    config,
  };

  state.server.on("connection", (socket) => handleConnection(state, socket));
  state.server.on("error", (err) => console.error("Server error:", err));

  if (config.maxConnections) {
    state.server.maxConnections = config.maxConnections;
  }

  return {
    start: (): Promise<void> =>
      new Promise((resolve, reject) => {
        state.server.listen(config.port, config.host || "0.0.0.0", () => {
          const addr = state.server.address();
          if (addr && typeof addr === "object") {
            console.log(
              `Gnutella server listening on ${addr.address}:${addr.port}`
            );
          }
          resolve();
        });
        state.server.on("error", reject);
      }),

    stop: (): Promise<void> =>
      new Promise((resolve) => {
        state.clients.forEach((client) => client.socket.destroy());
        state.clients.clear();

        state.server.close(() => {
          console.log("Gnutella server stopped");
          resolve();
        });
      }),

    getClients: () =>
      Array.from(state.clients.entries()).map(([id, client]) => ({
        id,
        handshake: client.handshake,
        version: client.version,
      })),

    setClientHandshake: (clientId: string, version?: string) => {
      const client = state.clients.get(clientId);
      if (client) {
        client.handshake = true;
        client.version = version;
      }
    },
  };
}

const localIp = (): string =>
  Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address ??
  "127.0.0.1";

const LOCAL_IP = localIp();
const LOCAL_PORT = 6346;
const MAX_CONNECTIONS = 10;

const HEADERS = {
  "User-Agent": "GnutellaBun/0.1",
  "X-Ultrapeer": "False",
  "Listen-IP": `${LOCAL_IP}:${LOCAL_PORT}`,
  "Remote-IP": LOCAL_IP,
};

const server = createGnutellaServer({
  port: LOCAL_PORT,
  host: "0.0.0.0",
  maxConnections: MAX_CONNECTIONS,
  headers: HEADERS,
  handler: {
    onConnect: (clientId) => {
      console.log(`[${clientId}] Connected`);
    },

    onMessage: (clientId, send, msg) => {
      console.log(`[${clientId}] Received:`, msg.type);

      switch (msg.type) {
        case "handshake_connect":
          console.log(`[${clientId}] Handshake request v${msg.version}`);

          switch (msg.version) {
            case "0.6":
              send(createHandshakeOk(HEADERS));
              server.setClientHandshake(clientId, msg.version);
              console.log(`[${clientId}] Handshake accepted`);
              break;
            default:
              send(
                createHandshakeError(503, "Service Unavailable", {
                  "X-Try": "gnutella.com:6346",
                })
              );
              console.log(
                `[${clientId}] Handshake rejected - unsupported version`
              );
              break;
          }
          break;

        case "ping":
          if (server.getClients().find((c) => c.id === clientId)?.handshake) {
            send(
              createPong(
                msg.header.descriptorId,
                LOCAL_PORT,
                LOCAL_IP,
                0,
                0,
                msg.header.ttl
              )
            );
            console.log(`[${clientId}] Responded to ping`);
          }
          break;

        case "pong":
          console.log(`[${clientId}] Pong from ${msg.ipAddress}:${msg.port}`);
          break;

        case "query":
          console.log(`[${clientId}] Query: "${msg.searchCriteria}"`);
          break;

        case "queryhits":
          console.log(`[${clientId}] QueryHits: ${msg.numberOfHits} results`);
          break;

        case "push":
          console.log(`[${clientId}] Push request`);
          break;

        case "bye":
          console.log(`[${clientId}] Bye: ${msg.code} ${msg.message}`);
          break;
      }
    },

    onError: (clientId, _, error) => {
      console.error(`[${clientId}] Error:`, error.message);
    },

    onClose: (clientId) => {
      console.log(`[${clientId}] Disconnected`);
    },
  },
});

server.start().then(() => {
  console.log(`Gnutella server running on ${LOCAL_IP}:${LOCAL_PORT}`);
  console.log(`Max connections: ${MAX_CONNECTIONS}`);
});

setInterval(() => {
  const clients = server.getClients();
  console.log(`\nActive connections: ${clients.length}`);
  clients.forEach((client) => {
    console.log(
      `  ${client.handshake ? "✓" : "…"} ${client.id}${
        client.version ? ` (v${client.version})` : ""
      }`
    );
  });
}, 10000);

process.on("SIGINT", async () => {
  console.log("\nShutting down server...");
  await server.stop();
  process.exit(0);
});
