import { startConnection } from "./gnutella-connection";
import {
  createHandshakeConnect,
  createHandshakeOk,
  createPong,
  GnutellaObject,
} from "./parser";
import os from "os";

const peers: string[] = [
  // Create this list via cache-client.ts
];

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const localIP = getLocalIP();
const localPort = 6346; // Standard Gnutella port

type Session = {
  handshakeComplete: boolean;
  version: string | undefined;
};
// Track active connections
const activeConnections = new Map<string, Session>();

async function connectToPeer(peerAddress: string) {
  const [ip, port] = peerAddress.split(":");
  const portNum = parseInt(port);

  try {
    const socket = await startConnection({
      ip,
      port: portNum,
      onMessage(send, message) {
        handleMessage(peerAddress, send, message);
      },
      onError(_send, error) {
        console.error(`Error from ${peerAddress}:`, error.message);
        activeConnections.delete(peerAddress);
      },
      onClose() {
        console.log(`Disconnected from ${peerAddress}`);
        activeConnections.delete(peerAddress);
      },
    });

    // Store connection info
    activeConnections.set(peerAddress, {
      handshakeComplete: false,
      version: undefined,
    });

    // Send Gnutella handshake
    const handshake = createHandshakeConnect("0.6", {
      "User-Agent": "GnutellaBun/0.1",
      "X-Degree": "10",
      "X-Max-TTL": "3",
      "X-Ultrapeer": "True",
      "X-Dynamic-Querying": "0.1",
      "X-Query-Routing": "True",
    });
    socket.write(handshake);
  } catch (error) {
    console.error(`Failed to connect to ${peerAddress}:`, error);
  }
}

function handleMessage(
  peerAddress: string,
  send: (data: Buffer) => void,
  message: GnutellaObject
) {
  const connection = activeConnections.get(peerAddress);
  if (!connection) return;

  switch (message.type) {
    case "handshake_connect":
      // Peer is initiating handshake (shouldn't happen as client)
      console.log(`${peerAddress} sent handshake connect v${message.version}`);
      const okResponse = createHandshakeOk(message.version, {
        "User-Agent": "MinimalGnutellaClient/0.1",
        "X-Ultrapeer": "False",
        "X-Dynamic-Querying": "0.1",
        "X-Query-Routing": "0.1",
      });
      send(okResponse);
      break;

    case "handshake_ok":
      // Handshake accepted
      console.log(`${peerAddress} accepted handshake`);
      connection.handshakeComplete = true;
      connection.version = message.version;
      break;

    case "handshake_error":
      // Handshake rejected
      console.log(`${peerAddress} rejected handshake: ${message.message}`);
      if (message.headers?.["X-Try"]) {
        console.log(`Alternative hosts: ${message.headers["X-Try"]}`);
      }
      if (message.headers?.["X-Try-Ultrapeers"]) {
        console.log(
          `=== Ultrapeers found: ${message.headers["X-Try-Ultrapeers"]}`
        );
      }

      ["x-Try", "X-Try-Ultrapeers", "X-Try-Hubs"].forEach((header) => {
        if (message.headers?.[header]) {
          const alternativePeers = message.headers[header]
            .split(",")
            .map((p) => p.trim());
          console.log(`Alternative peers from ${header}:`, alternativePeers);
          alternativePeers.forEach((altPeer) => {
            if (!activeConnections.has(altPeer)) {
              console.log(`Trying alternative peer: ${altPeer}`);
              if (header === "X-Try-hubs") {
                connectToPeer(altPeer.split(" ")[0]);
              } else {
                connectToPeer(altPeer);
              }
            } else {
              console.log(`Already connected to alternative peer: ${altPeer}`);
            }
          });
        }
      });
      activeConnections.delete(peerAddress);
      break;

    case "ping":
      // Respond to ping with pong
      if (connection.handshakeComplete) {
        console.log(`${peerAddress} sent ping, responding with pong`);
        const pong = createPong(
          message.header.descriptorId,
          localPort,
          localIP,
          0, // No files shared
          0, // No KB shared
          message.header.ttl
        );
        send(pong);
      }
      break;

    case "pong":
      console.log(
        `${peerAddress} sent pong from ${message.ipAddress}:${message.port}`
      );
      break;

    case "query":
      console.log(`${peerAddress} sent query: "${message.searchCriteria}"`);
      // We don't share files, so no QueryHits response
      break;

    case "queryhits":
      console.log(`${peerAddress} sent ${message.numberOfHits} query hits`);
      break;

    case "push":
      console.log(`${peerAddress} sent push request`);
      // We don't support push
      break;

    case "bye":
      console.log(
        `${peerAddress} sent bye: ${message.code} ${message.message}`
      );
      break;

    default:
      console.log(`${peerAddress} sent unknown message type`);
  }
}

// Connect to all peers
console.log(`Starting Gnutella client as ${localIP}:${localPort}`);
console.log(`Connecting to ${peers.length} peers...`);
function shuffle(array: string[]) {
  let currentIndex = array.length;

  // While there remain elements to shuffle...
  while (currentIndex != 0) {
    // Pick a remaining element...
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
}
shuffle(peers);

for (const peer of peers) {
  try {
    await connectToPeer(peer);
  } catch (error) {
    console.error(`Error connecting to ${peer}:`, error);
  }
}

setInterval(() => {
  console.log(`Active connections: ${activeConnections.size}`);
  activeConnections.forEach((conn, peer) => {
    if (!conn.handshakeComplete) {
      console.log(`Handshake not complete with ${peer}`);
    } else {
      console.log(`Connected to ${peer} (v${conn.version})`);
    }
  });
}, 5000);
