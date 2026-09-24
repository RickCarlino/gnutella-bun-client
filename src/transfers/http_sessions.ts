import type net from "node:net";
import { errMsg, toBuffer, ts } from "../shared";
import { socketCanEnd } from "../transport/socket_utils";
import { parsePush } from "../wire/codec";
import { findHeaderEnd } from "../wire/handshake";
import { parseHttpHeaders } from "../wire/http";
import type { PendingTransfer, TransferService } from "./service";
import type { HttpSession, HttpSessionRequest } from "./session_types";

const MAX_HTTP_REQUEST_BODY_BYTES = 256 * 1024;

/** Attach handlers and serve requests on an incoming socket. */
export function startHttpSession(
  transfers: TransferService,
  socket: net.Socket,
  firstHead: string,
  initialBuf: Buffer = Buffer.alloc(0),
): void {
  transfers.trackSocket(socket);
  const session: HttpSession = {
    socket,
    buf: Buffer.from(initialBuf),
    busy: false,
    closed: false,
  };

  const closeSession = () => {
    if (session.closed) return;
    session.closed = true;
    socket.off("data", onData);
    socket.off("close", closeSession);
    socket.off("end", closeSession);
    socket.off("error", onError);
  };

  const onData = (chunk: string | Buffer) => {
    if (session.closed) return;
    session.buf = Buffer.concat([session.buf, toBuffer(chunk)]);
    void transfers.drainHttpSession(session, closeSession);
  };

  const onError = () => closeSession();

  socket.on("data", onData);
  socket.on("close", closeSession);
  socket.on("end", closeSession);
  socket.on("error", onError);

  void transfers.drainHttpSession(session, closeSession, firstHead);
}

/** Find the end of the next buffered HTTP header. */
export function pendingHttpSessionHeadEnd(
  _transfers: TransferService,
  session: HttpSession,
): number {
  return findHeaderEnd(session.buf.toString("latin1"));
}

/** Remove and return a complete buffered HTTP header. */
export function shiftHttpSessionHead(
  transfers: TransferService,
  session: HttpSession,
): string | undefined {
  const cut = transfers.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  session.buf = session.buf.subarray(cut);
  return head;
}

function httpRequestContentLength(head: string): number {
  const raw = parseHttpHeaders(head)["content-length"];
  if (!raw) return 0;
  const length = Number(raw);
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("invalid http content-length");
  }
  if (length > MAX_HTTP_REQUEST_BODY_BYTES) {
    throw new Error("http request body too large");
  }
  return length;
}

/** Remove and return a complete buffered HTTP request. */
export function shiftHttpSessionRequest(
  transfers: TransferService,
  session: HttpSession,
): HttpSessionRequest | undefined {
  const cut = transfers.pendingHttpSessionHeadEnd(session);
  if (cut === -1) return undefined;
  const raw = session.buf.toString("latin1");
  const head = raw.slice(0, cut);
  const contentLength = httpRequestContentLength(head);
  if (session.buf.length < cut + contentLength) return undefined;
  const body = Buffer.from(session.buf.subarray(cut, cut + contentLength));
  session.buf = session.buf.subarray(cut + contentLength);
  return { head, body };
}

/** Serve buffered requests in order while reusable. */
export async function processHttpSessionRequests(
  transfers: TransferService,
  session: HttpSession,
  closeSession: () => void,
  nextHead?: string,
): Promise<void> {
  let pendingHead = nextHead;
  let queued: HttpSessionRequest | undefined;
  while (!session.closed) {
    if (!queued && pendingHead) {
      const contentLength = httpRequestContentLength(pendingHead);
      if (session.buf.length < contentLength) return;
      queued = {
        head: pendingHead,
        body: Buffer.from(session.buf.subarray(0, contentLength)),
      };
      session.buf = session.buf.subarray(contentLength);
      pendingHead = undefined;
    }
    queued ||= transfers.shiftHttpSessionRequest(session);
    if (!queued) return;
    const keepAlive = await transfers.handleIncomingGet(
      session.socket,
      queued.head,
      queued.body,
    );
    queued = undefined;
    if (keepAlive) continue;
    closeSession();
    if (socketCanEnd(session.socket)) session.socket.end();
    return;
  }
}

/** Process pending requests without overlapping handlers. */
export async function drainHttpSession(
  transfers: TransferService,
  session: HttpSession,
  closeSession: () => void,
  nextHead?: string,
): Promise<void> {
  if (session.closed || session.busy) return;
  session.busy = true;
  try {
    await transfers.processHttpSessionRequests(
      session,
      closeSession,
      nextHead,
    );
  } catch (error) {
    closeSession();
    session.socket.destroy(error instanceof Error ? error : undefined);
  } finally {
    session.busy = false;
  }
  if (session.closed) return;
  if (transfers.pendingHttpSessionHeadEnd(session) !== -1) {
    void transfers.drainHttpSession(session, closeSession);
  }
}

/** Queue a waiting download under its remote servent ID. */
export function enqueuePendingPush(
  transfers: TransferService,
  pending: PendingTransfer,
): void {
  const queue = transfers.pendingPushes.get(pending.serventIdHex) || [];
  queue.push(pending);
  transfers.pendingPushes.set(pending.serventIdHex, queue);
}

/** Take the oldest waiting download for a servent. */
export function shiftPendingPush(
  transfers: TransferService,
  serventIdHex: string,
): PendingTransfer | undefined {
  const queue = transfers.pendingPushes.get(serventIdHex);
  if (!queue?.length) return undefined;
  const pending = queue.shift();
  if (queue.length) transfers.pendingPushes.set(serventIdHex, queue);
  else transfers.pendingPushes.delete(serventIdHex);
  return pending;
}

/** Connect back to a requester and offer the selected share. */
export async function fulfillPush(
  transfers: TransferService,
  push: ReturnType<typeof parsePush>,
): Promise<void> {
  const share = transfers.deps.shares.byIndex(push.fileIndex);
  if (!share) return;
  transfers.deps.emit({
    type: "PUSH_REQUESTED",
    at: ts(),
    fileIndex: share.index,
    fileName: share.name,
    ip: push.ip,
    port: push.port,
  });
  const socket = transfers.createConnection({
    host: push.ip,
    port: push.port,
  });
  socket.setNoDelay(true);
  socket.setTimeout(transfers.config().downloadTimeoutMs, () =>
    socket.destroy(new Error("push connect timeout")),
  );
  socket.on("error", (error) =>
    transfers.deps.emit({
      type: "PUSH_CALLBACK_FAILED",
      at: ts(),
      message: errMsg(error),
    }),
  );
  socket.on("connect", () => {
    socket.write(
      `GIV ${share.index}:${transfers.deps.serventId.toString("hex")}/${share.name}\n\n`,
    );
  });

  let buf = Buffer.alloc(0);
  const onData = (chunk: string | Buffer) => {
    buf = Buffer.concat([buf, toBuffer(chunk)]);
    const raw = buf.toString("latin1");
    const cut = findHeaderEnd(raw);
    if (cut === -1) return;
    const head = raw.slice(0, cut);
    const rest = buf.subarray(cut);
    socket.off("data", onData);
    transfers.startHttpSession(socket, head, rest);
  };
  socket.on("data", onData);
}

/** Reject and remove expired push callback requests. */
export function prunePendingPushQueues(
  transfers: TransferService,
  now: number,
  waitMs: number,
): void {
  for (const [key, queue] of transfers.pendingPushes) {
    const keep = queue.filter((pending) => {
      if (now - pending.createdAt <= waitMs) return true;
      pending.reject(new Error("push timed out"));
      return false;
    });
    if (keep.length) transfers.pendingPushes.set(key, keep);
    else transfers.pendingPushes.delete(key);
  }
}
