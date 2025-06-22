import { describe, test, expect, afterEach } from "bun:test";
import net from "net";
import { GnutellaServer } from "./gnutella_server";
import { PeerStore } from "./peer_store";
import { QRPManager } from "./qrp_manager";
import { IDGenerator } from "./id_generator";
import { Protocol } from "./constants";
import { NodeContext } from "./core_types";

let remote: net.Server | null = null;

afterEach(() => {
  remote?.close();
  remote = null;
});

describe("GnutellaServer.connectPeer", () => {
  test("sends handshake to remote peer", async () => {
    const chunks: Buffer[] = [];
    remote = net.createServer((socket) => {
      socket.on("data", (d) => chunks.push(d));
    });
    await new Promise<void>((res) => remote!.listen(0, res));
    const port = (remote!.address() as net.AddressInfo).port;

    const context: NodeContext = {
      localIp: "127.0.0.1",
      localPort: Protocol.PORT,
      peerStore: new PeerStore(),
      qrpManager: new QRPManager(),
      serventId: IDGenerator.servent(),
    };

    const server = new GnutellaServer(context);
    const conn = await server.connectPeer("127.0.0.1", port);
    expect(conn.id).toContain("127.0.0.1");

    await Bun.sleep(50);
    const data = Buffer.concat(chunks).toString("ascii");
    expect(data.startsWith(`GNUTELLA CONNECT/${Protocol.VERSION}`)).toBe(true);

    conn.socket.destroy();
  });
});
