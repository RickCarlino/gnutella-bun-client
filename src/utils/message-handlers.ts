import { createPong, type GnutellaObject } from "../parser";
import type { Sender } from "../types";

export type HandshakeContext = {
  localPort: number;
  localIp: string;
  send: Sender;
};

export function handlePing(
  msg: GnutellaObject & { type: "ping" },
  context: HandshakeContext,
  isHandshakeComplete: boolean
): void {
  if (isHandshakeComplete) {
    context.send(
      createPong(
        msg.header.descriptorId,
        context.localPort,
        context.localIp,
        0,
        0,
        msg.header.ttl
      )
    );
  }
}

export function extractPeersFromHandshakeError(
  msg: GnutellaObject & { type: "handshake_error" },
  addPeer: (ip: string, port: number) => void
): void {
  const tryHeaders = ["X-Try", "X-Try-Ultrapeers", "X-Try-Hubs"];

  for (const header of tryHeaders) {
    const alternatives = msg.headers?.[header];
    if (alternatives) {
      const peers = alternatives
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);

      for (const peer of peers) {
        const peerAddress = header === "X-Try-Hubs" ? peer.split(" ")[0] : peer;
        const [ip, port] = peerAddress.split(":");
        if (ip && port) {
          addPeer(ip, parseInt(port, 10));
        }
      }
    }
  }
}
