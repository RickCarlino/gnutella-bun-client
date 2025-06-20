#!/usr/bin/env bun
import net from "net";

// Simple test client to verify handshake order
const client = net.createConnection({ host: "127.0.0.1", port: 6346 });

client.on("connect", () => {
  console.log("Connected, sending GNUTELLA CONNECT");
  client.write("GNUTELLA CONNECT/0.6\r\n");
  client.write("User-Agent: TestClient/1.0\r\n");
  client.write("Accept-Encoding: deflate\r\n");
  client.write("\r\n");
});

let receivedData = "";
client.on("data", (chunk) => {
  receivedData += chunk.toString();
  console.log("Received chunk:", chunk.toString().replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
  
  // Check if we received the server's 200 OK
  if (receivedData.includes("GNUTELLA/0.6 200 OK") && !receivedData.includes("sent_final_ok")) {
    console.log("\nServer sent 200 OK, now sending our final 200 OK");
    client.write("GNUTELLA/0.6 200 OK\r\n");
    client.write("User-Agent: TestClient/1.0\r\n");
    client.write("\r\n");
    receivedData += "sent_final_ok"; // Mark that we sent it
    
    // Wait a bit to see if we get any data
    setTimeout(() => {
      console.log("\nWaiting for data after handshake...");
    }, 1000);
  }
});

client.on("error", (err) => {
  console.error("Client error:", err);
});

client.on("close", () => {
  console.log("\nConnection closed");
  process.exit(0);
});

// Exit after 5 seconds
setTimeout(() => {
  console.log("\nTimeout - closing connection");
  client.end();
}, 5000);