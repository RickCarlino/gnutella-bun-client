import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";

import { withFakeNet } from "../../helpers/fake_net";

describe("fake net helper", () => {
  test("provides connected sockets with addresses and idle timeouts", async () => {
    await withFakeNet(async () => {
      const connections: net.Socket[] = [];
      const server = net.createServer((socket) => {
        connections.push(socket);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "0.0.0.0", resolve),
      );

      const serverAddress = server.address() as net.AddressInfo;
      expect(serverAddress).toMatchObject({
        address: "0.0.0.0",
        family: "IPv4",
      });

      const client = net.createConnection({
        host: "127.0.0.1",
        port: serverAddress.port,
      });
      await once(client, "connect");
      expect(connections).toHaveLength(1);

      const clientAddress = client.address() as net.AddressInfo;
      expect(clientAddress).toMatchObject({
        address: "127.0.0.1",
        family: "IPv4",
      });
      expect(clientAddress.port).toBeGreaterThan(0);

      let callbackTimedOut = false;
      client.setTimeout(1, () => {
        callbackTimedOut = true;
      });
      await once(client, "timeout");
      expect(callbackTimedOut).toBe(true);

      client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  test("reports duplicate listeners and refused connections", async () => {
    await withFakeNet(async () => {
      const first = net.createServer();
      await new Promise<void>((resolve) =>
        first.listen(23456, "127.0.0.1", resolve),
      );

      const second = net.createServer();
      const listenErrorPromise = once(second, "error") as Promise<
        [NodeJS.ErrnoException]
      >;
      second.listen(23456, "127.0.0.1");
      const [listenError] = await listenErrorPromise;
      expect(listenError.code).toBe("EADDRINUSE");
      expect(listenError.message).toContain("127.0.0.1:23456");

      const missing = net.createConnection({
        host: "127.0.0.1",
        port: 23457,
      });
      const [connectError] = (await once(missing, "error")) as [
        NodeJS.ErrnoException,
      ];
      expect(connectError.code).toBe("ECONNREFUSED");
      expect(connectError.message).toContain("127.0.0.1:23457");

      await new Promise<void>((resolve) => first.close(() => resolve()));
    });
  });
});
