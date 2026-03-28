import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";

import { upgradeSocketToTls } from "../../../../src/protocol/node_tls";
import { makeNode, withTempDir } from "./helpers";

class FakeTlsSocket extends EventEmitter {
  noDelay = false;
  resumed = false;
  startCalls = 0;

  setNoDelay(_noDelay: boolean): this {
    this.noDelay = true;
    return this;
  }

  resume(): this {
    this.resumed = true;
    return this;
  }

  _start(): void {
    this.startCalls += 1;
    throw new Error("client TLS upgrade should not call _start()");
  }
}

describe("protocol node TLS", () => {
  test("client upgrades do not manually start tls.connect sockets", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const timeoutCalls: number[] = [];
      const socket = {
        pause() {
          return this;
        },
        setTimeout(timeoutMs: number) {
          timeoutCalls.push(timeoutMs);
          return this;
        },
        unshift(_chunk: Uint8Array) {
          return this;
        },
      } as unknown as net.Socket;
      const originalConnect = tls.connect;
      const upgraded = new FakeTlsSocket();
      let connectOptions: Record<string, unknown> | undefined;
      tls.connect = ((...args: unknown[]) => {
        connectOptions = args[0] as Record<string, unknown>;
        queueMicrotask(() => upgraded.emit("secureConnect"));
        return upgraded as unknown as tls.TLSSocket;
      }) as typeof tls.connect;

      try {
        const wrapped = await upgradeSocketToTls(node, socket, "client");
        expect(wrapped).toBe(upgraded as unknown as tls.TLSSocket);
        expect(upgraded.startCalls).toBe(0);
        expect(upgraded.noDelay).toBe(true);
        expect(upgraded.resumed).toBe(true);
        expect(timeoutCalls).toEqual([0]);
        expect(connectOptions?.minVersion).toBe("TLSv1.2");
        expect("maxVersion" in (connectOptions || {})).toBe(false);
      } finally {
        tls.connect = originalConnect;
      }
    });
  });
});
