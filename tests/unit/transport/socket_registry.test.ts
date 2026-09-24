import { expect, test } from "bun:test";
import net from "node:net";
import { SocketRegistry } from "../../../src/transport/socket_registry";

test("socket handoff leaves only the destination responsible for shutdown", () => {
  const ingress = new SocketRegistry();
  const transfers = new SocketRegistry();
  const socket = ingress.add(new net.Socket());
  ingress.release(socket);
  transfers.add(socket);
  expect(socket.listenerCount("close")).toBe(1);
  ingress.close();
  expect(socket.destroyed).toBe(false);
  transfers.close();
  expect(socket.destroyed).toBe(true);
  expect(socket.listenerCount("close")).toBe(0);
});

test("late handoffs cannot leave sockets alive after owner shutdown", () => {
  const owner = new SocketRegistry();
  owner.close();
  const late = new net.Socket();
  expect(() => owner.add(late)).toThrow("socket owner stopped");
  expect(late.destroyed).toBe(true);
  expect(late.listenerCount("close")).toBe(0);
  owner.close();
});
