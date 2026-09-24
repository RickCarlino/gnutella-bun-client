import type net from "node:net";

/** Check whether a socket can still be ended cleanly. */
export function socketCanEnd(socket: net.Socket): boolean {
  return (
    !socket.destroyed &&
    !(socket as net.Socket & { writableEnded?: boolean }).writableEnded &&
    !(socket as net.Socket & { ended?: boolean }).ended
  );
}
