import { expect, test } from "bun:test";
import { PeerSession } from "../../../src/connections/session";
import { makePeer, MockSocket } from "../../helpers/protocol";

test("peer session cancels deferred work and releases streams and listeners on close", () => {
  const peer = makePeer();
  const socket = peer.socket as unknown as MockSocket;
  peer.capabilities.compressIn = true;
  peer.capabilities.compressOut = true;
  const dropped: string[] = [];
  const timers = new Map<NodeJS.Timeout, () => void>();
  const session = new PeerSession(peer, {
    consume: () => {},
    dropped: (_peer, message) => dropped.push(message),
    scheduler: {
      setTimeout: (callback) => {
        const timer = {} as NodeJS.Timeout;
        timers.set(timer, callback);
        return timer;
      },
      clearTimeout: (timer) => {
        timers.delete(timer);
      },
    },
  });
  session.start(Buffer.alloc(0));
  session.schedule(500, () => {
    throw new Error("closed session fired");
  });
  expect(timers.size).toBe(1);
  socket.destroy();
  expect(timers.size).toBe(0);
  expect(peer.inflater?.destroyed).toBe(true);
  expect(peer.deflater?.destroyed).toBe(true);
  expect(socket.listenerCount("data")).toBe(0);
  expect(socket.listenerCount("close")).toBe(0);
  session.close("again");
  expect(dropped).toEqual(["socket closed"]);
});

test("peer session preserves initial bytes and subsequent fragments", () => {
  const peer = makePeer();
  const socket = peer.socket as unknown as MockSocket;
  const buffers: Buffer[] = [];
  const session = new PeerSession(peer, {
    consume: (peer) => {
      buffers.push(Buffer.from(peer.buf));
    },
    dropped: () => {},
    scheduler: { setTimeout, clearTimeout },
  });
  session.start(Buffer.from([1, 2]));
  socket.emit("data", Buffer.from([3]));
  expect(buffers).toEqual([Buffer.from([1, 2]), Buffer.from([1, 2, 3])]);
  session.close("done");
  socket.emit("data", Buffer.from([4]));
  expect(buffers.length).toBe(2);
});
