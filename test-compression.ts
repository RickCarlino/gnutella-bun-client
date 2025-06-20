import { startCompressedConnection } from "./src/gnutella-connection-compressed";
import { createHandshakeConnect, createPing } from "./src/parser";

async function testCompression() {
  console.log("Testing compression by connecting to localhost...");
  
  try {
    const { socket, send, compressionState } = await startCompressedConnection({
      ip: "127.0.0.1",
      port: 6346,
      onMessage: (send, msg) => {
        console.log("Received message:", msg.type);
        
        if (msg.type === "handshake_ok") {
          console.log("Handshake successful!");
          console.log("Compression state:", {
            isCompressed: compressionState.isCompressed,
            peerSendsCompressed: compressionState.peerSendsCompressed,
            peerAcceptsCompression: compressionState.peerAcceptsCompression
          });
          
          // Send a ping to test compression
          console.log("Sending ping...");
          send(createPing());
        }
        
        if (msg.type === "pong") {
          console.log("Received pong! Compression is working.");
          socket.destroy();
        }
      },
      onError: (_, error) => {
        console.error("Connection error:", error);
      },
      onClose: () => {
        console.log("Connection closed");
        process.exit(0);
      }
    });
    
    // Send handshake
    const headers = {
      "User-Agent": "CompressionTest/0.1",
      "X-Ultrapeer": "False",
      "Accept-Encoding": "deflate",
      "X-Query-Routing": "0.2"
    };
    
    send(createHandshakeConnect(headers));
    console.log("Handshake sent, waiting for response...");
    
  } catch (error) {
    console.error("Failed to connect:", error);
    process.exit(1);
  }
}

// First start the server in another terminal with: bun run main.ts
// Then run this test
testCompression();