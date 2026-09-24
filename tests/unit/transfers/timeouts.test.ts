import { expect, test } from "bun:test";
import type net from "node:net";
import path from "node:path";
import { connectDownloadSocket } from "../../../src/transfers/http_download_session";
import { makeNode, MockSocket, withTempDir } from "../../helpers/protocol";

test("connect timeout identifies the endpoint and removes its timer", async () => {
  await withTempDir(async (dir) => {
    const socket = new MockSocket();
    const node = makeNode(path.join(dir, "config.json"), {
      runtimeConfig: { downloadTimeoutMs: 25 },
      collaborators: {
        netFactory: {
          createConnection: () => socket as unknown as net.Socket,
        },
      },
    });
    const connected = connectDownloadSocket(
      node.transfers,
      "127.0.0.1",
      6346,
      {},
    );
    socket.emit("timeout");
    await expect(connected).rejects.toMatchObject({
      phase: "connect",
      message: "download connect timeout to 127.0.0.1:6346 after 25ms",
    });
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("timeout")).toBe(0);
  });
});

test("a successful connection removes its connect-timeout handler", async () => {
  await withTempDir(async (dir) => {
    const socket = new MockSocket();
    const node = makeNode(path.join(dir, "config.json"), {
      collaborators: {
        netFactory: {
          createConnection: () => socket as unknown as net.Socket,
        },
      },
    });
    const connected = connectDownloadSocket(
      node.transfers,
      "127.0.0.1",
      6346,
      {},
    );
    socket.emit("connect");
    expect(await connected).toBe(socket as unknown as net.Socket);
    expect(socket.listenerCount("timeout")).toBe(0);
    socket.emit("timeout");
    expect(socket.destroyed).toBe(false);
  });
});
