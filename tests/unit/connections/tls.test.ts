import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import {
  canUpgradeSocketToTls,
  clientAcceptedTlsUpgrade,
  peerAcceptedTlsUpgrade,
  peerRequestedTlsUpgrade,
  socketUsesTls,
  tlsUpgradeToken,
  upgradeSocketToTls,
} from "../../../src/connections/tls";
import { makeNode, withTempDir } from "../../helpers/protocol";

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

  destroy(): this {
    this.emit("close");
    return this;
  }

  _start(): void {
    this.startCalls += 1;
    throw new Error("client TLS upgrade should not call _start()");
  }
}

class FakeServerTlsSocket extends EventEmitter {
  noDelay = false;
  resumed = false;
  startCalls = 0;
  static lastOptions: Record<string, unknown> | undefined;

  constructor(_socket: net.Socket, options: Record<string, unknown>) {
    super();
    FakeServerTlsSocket.lastOptions = options;
    queueMicrotask(() => this.emit("secure"));
  }

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
    queueMicrotask(() => this.emit("secure"));
  }
}

describe("protocol node TLS", () => {
  test("detects tls upgrade headers and socket state", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const plainSocket = {} as net.Socket;
      const encryptedSocket = {
        encrypted: true,
      } as unknown as net.Socket;

      expect(tlsUpgradeToken(node.connections)).toBe("TLS/1.0");
      expect(
        peerRequestedTlsUpgrade(node.connections, {
          upgrade: "gzip, TLS/1.0",
        }),
      ).toBe(true);
      expect(
        peerRequestedTlsUpgrade(node.connections, {
          upgrade: "gzip",
        }),
      ).toBe(false);
      expect(
        peerAcceptedTlsUpgrade(node.connections, {
          upgrade: "tls/1.0",
          connection: "Keep-Alive, Upgrade",
        }),
      ).toBe(true);
      expect(
        peerAcceptedTlsUpgrade(node.connections, {
          upgrade: "tls/1.0",
          connection: "keep-alive",
        }),
      ).toBe(false);
      expect(
        clientAcceptedTlsUpgrade(node.connections, {
          connection: "keep-alive, Upgrade",
        }),
      ).toBe(true);
      expect(clientAcceptedTlsUpgrade(node.connections, {})).toBe(false);
      expect(socketUsesTls(node.connections, plainSocket)).toBe(false);
      expect(socketUsesTls(node.connections, encryptedSocket)).toBe(true);
      expect(canUpgradeSocketToTls(node.connections, plainSocket)).toBe(
        false,
      );
      expect(
        canUpgradeSocketToTls(node.connections, new net.Socket()),
      ).toBe(true);
    });
  });

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
        const wrapped = await upgradeSocketToTls(
          node.connections,
          socket,
          "client",
        );
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

  test("server upgrades preserve buffered bytes without calling private starters", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const timeoutCalls: number[] = [];
      const unshifted: Buffer[] = [];
      const socket = {
        pause() {
          return this;
        },
        setTimeout(timeoutMs: number) {
          timeoutCalls.push(timeoutMs);
          return this;
        },
        unshift(chunk: Uint8Array) {
          unshifted.push(Buffer.from(chunk));
          return this;
        },
      } as unknown as net.Socket;
      const originalTLSSocket = tls.TLSSocket;
      FakeServerTlsSocket.lastOptions = undefined;
      tls.TLSSocket =
        FakeServerTlsSocket as unknown as typeof tls.TLSSocket;

      try {
        const wrapped = await upgradeSocketToTls(
          node.connections,
          socket,
          "server",
          Buffer.from("preface"),
        );
        const upgraded = wrapped as unknown as FakeServerTlsSocket;
        expect(unshifted).toEqual([Buffer.from("preface")]);
        expect(timeoutCalls).toEqual([0]);
        expect(upgraded.startCalls).toBe(0);
        expect(upgraded.noDelay).toBe(true);
        expect(upgraded.resumed).toBe(true);
        expect(FakeServerTlsSocket.lastOptions).toMatchObject({
          isServer: true,
          requestCert: false,
          rejectUnauthorized: false,
        });
      } finally {
        tls.TLSSocket = originalTLSSocket;
      }
    });
  });

  test("client upgrades reject when the tls handshake errors", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = {
        pause() {
          return this;
        },
        setTimeout(_timeoutMs: number) {
          return this;
        },
        unshift(_chunk: Uint8Array) {
          return this;
        },
      } as unknown as net.Socket;
      const originalConnect = tls.connect;
      const upgraded = new FakeTlsSocket();
      tls.connect = (() => {
        queueMicrotask(() =>
          upgraded.emit("error", new Error("tls handshake failed")),
        );
        return upgraded as unknown as tls.TLSSocket;
      }) as typeof tls.connect;

      try {
        await expect(
          upgradeSocketToTls(node.connections, socket, "client"),
        ).rejects.toThrow("tls handshake failed");
      } finally {
        tls.connect = originalConnect;
      }
    });
  });

  test("client upgrades reject when resume triggers a synchronous tls error", async () => {
    await withTempDir(async (dir) => {
      const node = makeNode(path.join(dir, "protocol.json"));
      const socket = {
        pause() {
          return this;
        },
        setTimeout(_timeoutMs: number) {
          return this;
        },
        unshift(_chunk: Uint8Array) {
          return this;
        },
      } as unknown as net.Socket;
      const originalConnect = tls.connect;
      class SynchronousErrorTlsSocket extends FakeTlsSocket {
        override resume(): this {
          this.emit(
            "error",
            Object.assign(
              new Error(
                "Client network socket disconnected before secure TLS connection was established",
              ),
              { code: "ECONNRESET" },
            ),
          );
          return super.resume();
        }
      }
      tls.connect = (() => {
        return new SynchronousErrorTlsSocket() as unknown as tls.TLSSocket;
      }) as typeof tls.connect;

      try {
        await expect(
          upgradeSocketToTls(node.connections, socket, "client"),
        ).rejects.toThrow(
          "Client network socket disconnected before secure TLS connection was established",
        );
      } finally {
        tls.connect = originalConnect;
      }
    });
  });
});
