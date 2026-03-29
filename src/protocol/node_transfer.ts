import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { LOCAL_ROUTE, TYPE } from "../const";
import { ensureDir, errMsg, fileExists, ts } from "../shared";
import type { SearchHit, ShareFile } from "../types";
import {
  buildGetRequest,
  buildUriResRequest,
  encodePush,
  encodeQuery,
  parseByteRange,
  parseHttpDownloadHeader,
} from "./codec";
import {
  findHeaderEnd,
  hasToken,
  parseHttpHeaders,
  socketCanEnd,
} from "./handshake";
import type { GnutellaServent } from "./node";
import type { ExistingGetRequest, HttpDownloadState } from "./node_types";

type OutgoingQueryParts = {
  search: string;
  urns: string[];
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

function splitOutgoingQuery(search: string): OutgoingQueryParts {
  if (!search.trim()) {
    return {
      search,
      urns: [],
    };
  }
  const parts = search.trim().split(/\s+/).filter(Boolean);
  const textParts: string[] = [];
  const urns: string[] = [];
  const seenUrns = new Set<string>();
  for (const part of parts) {
    if (!/^urn:[^\s]+$/i.test(part)) {
      textParts.push(part);
      continue;
    }
    const key = part.toLowerCase();
    if (seenUrns.has(key)) continue;
    seenUrns.add(key);
    urns.push(part);
  }
  return {
    search: textParts.join(" "),
    urns,
  };
}

function recordDownloadSuccess(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
  mode: "direct" | "push",
): void {
  node.emitEvent({
    type: "DOWNLOAD_SUCCEEDED",
    at: ts(),
    mode,
    resultNo: hit.resultNo,
    fileName: hit.fileName,
    destPath,
    remoteHost: hit.remoteHost,
    remotePort: hit.remotePort,
  });
  node.downloads.push({
    at: ts(),
    fileName: hit.fileName,
    bytes: hit.fileSize,
    host: hit.remoteHost,
    port: hit.remotePort,
    mode,
    destPath,
  });
}

export async function handleIncomingGet(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
): Promise<boolean> {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  let match =
    /^(GET|HEAD)\s+\/get\/(\d+)\/(.+?)(?:\/)?\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (match) {
    const fileIndex = Number(match[2]);
    const share = node.sharesByIndex.get(fileIndex);
    if (!share) {
      socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
      return false;
    }
    return await node.handleExistingGet(socket, head, share.abs, share);
  }

  match =
    /^(GET|HEAD)\s+\/uri-res\/N2R\?([^\s]+)\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (match && node.config().serveUriRes) {
    const urn = decodeURIComponent(match[2]).toLowerCase();
    const share = node.sharesByUrn.get(urn);
    if (!share) {
      socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
      return false;
    }
    return await node.handleExistingGet(socket, head, share.abs, share);
  }

  socket.end("HTTP/1.0 400 Bad Request\r\n\r\n");
  return false;
}

export function parseExistingGetRequest(
  _node: GnutellaServent,
  head: string,
): ExistingGetRequest {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  const method =
    /^(GET|HEAD)\s+/i.exec(first)?.[1]?.toUpperCase() || "GET";
  const httpVersion =
    /^([A-Z]+)\s+\S+\s+HTTP\/(\d+\.\d+)$/i.exec(first)?.[2] || "1.0";
  const headers = parseHttpHeaders(head);
  return {
    method,
    responseVersion: httpVersion === "1.1" ? "HTTP/1.1" : "HTTP/1.0",
    headers,
    keepAlive: !hasToken(headers["connection"], "close"),
  };
}

export function writeInvalidRangeResponse(
  _node: GnutellaServent,
  socket: net.Socket,
  request: ExistingGetRequest,
  size: number,
): boolean {
  socket.write(
    [
      `${request.responseVersion} 416 Range Not Satisfiable`,
      "Server: Gnutella",
      "Content-Type: application/binary",
      "Content-Length: 0",
      `Content-Range: bytes */${size}`,
      `Connection: ${request.keepAlive ? "Keep-Alive" : "close"}`,
      "",
      "",
    ].join("\r\n"),
  );
  if (!request.keepAlive && socketCanEnd(socket)) socket.end();
  return request.keepAlive;
}

export function existingGetBodyLength(
  _node: GnutellaServent,
  range: { start: number; end: number },
): number {
  return range.end >= range.start ? range.end - range.start + 1 : 0;
}

export function buildExistingGetResponseHeaders(
  _node: GnutellaServent,
  request: ExistingGetRequest,
  range: { start: number; end: number; partial: boolean },
  size: number,
  remaining: number,
  share?: ShareFile,
): string {
  return [
    range.partial
      ? `${request.responseVersion} 206 Partial Content`
      : `${request.responseVersion} 200 OK`,
    "Server: Gnutella",
    "Content-Type: application/binary",
    `Content-Length: ${remaining}`,
    ...(range.partial
      ? [`Content-Range: bytes ${range.start}-${range.end}/${size}`]
      : []),
    ...(share ? [`X-Gnutella-Content-URN: ${share.sha1Urn}`] : []),
    `Connection: ${request.keepAlive ? "Keep-Alive" : "close"}`,
    "",
    "",
  ].join("\r\n");
}

export function finishExistingGetResponse(
  _node: GnutellaServent,
  socket: net.Socket,
  keepAlive: boolean,
): boolean {
  if (!keepAlive && socketCanEnd(socket)) socket.end();
  return keepAlive;
}

export async function streamExistingGetBody(
  _node: GnutellaServent,
  socket: net.Socket,
  absPath: string,
  range: { start: number; end: number },
  keepAlive: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rs = fs.createReadStream(absPath, {
      start: range.start,
      end: range.end,
    });
    let done = false;
    const cleanup = () => {
      rs.off("error", onError);
      rs.off("end", onEnd);
      socket.off("close", onClose);
      socket.off("error", onSocketError);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      reject(toError(error));
    };
    const onError = (error: unknown) => fail(error);
    const onSocketError = (error: unknown) => fail(error);
    const onClose = () => finish();
    const onEnd = () => {
      if (!keepAlive && socketCanEnd(socket)) socket.end();
      finish();
    };
    rs.on("error", onError);
    rs.on("end", onEnd);
    socket.once("close", onClose);
    socket.once("error", onSocketError);
    rs.pipe(socket, { end: false });
  });
}

export async function handleExistingGet(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  absPath: string,
  share?: ShareFile,
): Promise<boolean> {
  const request = node.parseExistingGetRequest(head);
  const stat = await fsp.stat(absPath);
  const range = parseByteRange(request.headers["range"], stat.size);
  if (!range)
    return node.writeInvalidRangeResponse(socket, request, stat.size);
  const remaining = node.existingGetBodyLength(range);
  socket.write(
    node.buildExistingGetResponseHeaders(
      request,
      range,
      stat.size,
      remaining,
      share,
    ),
  );
  if (request.method === "HEAD" || remaining === 0) {
    return node.finishExistingGetResponse(socket, request.keepAlive);
  }
  await node.streamExistingGetBody(
    socket,
    absPath,
    range,
    request.keepAlive,
  );
  return request.keepAlive;
}

export async function handleIncomingGiv(
  node: GnutellaServent,
  socket: net.Socket,
  giv: string,
) {
  const text = giv.replace(/\r\n/g, "\n");
  const match = /^GIV\s+\d+:([0-9a-fA-F]{32})\/.+\n\n$/s.exec(text);
  if (!match) {
    socket.destroy();
    return;
  }
  const serventIdHex = match[1].toLowerCase();
  const pending = node.shiftPendingPush(serventIdHex);
  if (!pending) {
    socket.destroy();
    return;
  }
  try {
    const result = await node.downloadOverSocket(
      socket,
      pending.result.fileIndex,
      pending.result.fileName,
      pending.destPath,
    );
    pending.resolve(result);
  } catch (error) {
    pending.reject(error);
  }
}

export async function downloadOverSocket(
  node: GnutellaServent,
  socket: net.Socket,
  fileIndex: number,
  fileName: string,
  destPath: string,
): Promise<unknown> {
  await ensureDir(path.dirname(destPath));
  const existing = (await fileExists(destPath))
    ? (await fsp.stat(destPath)).size
    : 0;
  socket.write(
    buildGetRequest(
      fileIndex,
      fileName,
      existing,
      socket.remoteAddress || undefined,
      socket.remotePort || undefined,
    ),
  );
  const result = await node.readHttpDownload(
    socket,
    destPath,
    `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`,
    existing,
  );
  if (socketCanEnd(socket)) socket.end();
  return result;
}

export async function directDownloadViaRequest(
  node: GnutellaServent,
  host: string,
  port: number,
  request: string,
  destPath: string,
  existing: number,
): Promise<unknown> {
  const socket = node.createConnection({ host, port });
  socket.setNoDelay(true);
  socket.setTimeout(node.config().downloadTimeoutMs, () =>
    socket.destroy(new Error("download timeout")),
  );
  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      socket.removeListener("connect", onConnect);
      reject(toError(error));
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      socket.write(request);
      resolve();
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
  const result = await node.readHttpDownload(
    socket,
    destPath,
    `${host}:${port}`,
    existing,
  );
  if (socketCanEnd(socket)) socket.end();
  return result;
}

export async function directDownload(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
): Promise<unknown> {
  await ensureDir(path.dirname(destPath));
  const existing = (await fileExists(destPath))
    ? (await fsp.stat(destPath)).size
    : 0;

  if (hit.sha1Urn && node.config().serveUriRes) {
    try {
      return await node.directDownloadViaRequest(
        hit.remoteHost,
        hit.remotePort,
        buildUriResRequest(
          hit.sha1Urn,
          existing,
          hit.remoteHost,
          hit.remotePort,
        ),
        destPath,
        existing,
      );
    } catch {
      // fall through to /get/ path
    }
  }

  return await node.directDownloadViaRequest(
    hit.remoteHost,
    hit.remotePort,
    buildGetRequest(
      hit.fileIndex,
      hit.fileName,
      existing,
      hit.remoteHost,
      hit.remotePort,
    ),
    destPath,
    existing,
  );
}

export function initializeHttpDownloadState(
  _node: GnutellaServent,
  state: HttpDownloadState,
  destPath: string,
  requestedStart: number,
  onWriteError: (error: Error) => void,
): void {
  const raw = state.buf.toString("latin1");
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;

  state.headerDone = true;
  const parsed = parseHttpDownloadHeader(
    raw.slice(0, cut),
    requestedStart,
  );
  state.remaining = parsed.remaining;
  state.finalStart = parsed.finalStart;
  state.ws = fs.createWriteStream(destPath, {
    flags: state.finalStart > 0 ? "r+" : "w",
    start: state.finalStart,
  });
  state.ws.on("error", onWriteError);
  state.buf = state.buf.subarray(cut);
}

export function writeHttpDownloadBody(
  _node: GnutellaServent,
  state: HttpDownloadState,
): void {
  if (!state.ws) return;
  const take = Math.min(state.remaining, state.buf.length);
  if (take <= 0) return;
  const chunkOut = state.buf.subarray(0, take);
  state.ws.write(chunkOut);
  state.bodyBytes += chunkOut.length;
  state.remaining -= take;
  state.buf = state.buf.subarray(take);
}

export function consumeHttpDownloadChunk(
  node: GnutellaServent,
  state: HttpDownloadState,
  destPath: string,
  requestedStart: number,
  onWriteError: (error: Error) => void,
  chunk: Buffer,
): void {
  state.buf = Buffer.concat([state.buf, chunk]);
  if (!state.headerDone) {
    node.initializeHttpDownloadState(
      state,
      destPath,
      requestedStart,
      onWriteError,
    );
  }
  node.writeHttpDownloadBody(state);
}

export async function readHttpDownload(
  node: GnutellaServent,
  socket: net.Socket,
  destPath: string,
  label: string,
  requestedStart: number,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const state: HttpDownloadState = {
      buf: Buffer.alloc(0),
      headerDone: false,
      remaining: 0,
      ws: null,
      finalStart: requestedStart,
      bodyBytes: 0,
    };
    let done = false;
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("data", onData);
      socket.off("end", onEnd);
      state.ws?.off("error", onWriteError);
    };
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      try {
        state.ws?.destroy();
      } catch {
        // ignore
      }
      socket.destroy();
      reject(toError(error));
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      const meta = {
        destPath,
        bytes: state.finalStart + state.bodyBytes,
        label,
      };
      if (!state.ws) {
        resolve(meta);
        return;
      }
      state.ws.end(() => resolve(meta));
    };
    const onWriteError = (error: Error) => fail(error);
    const onError = (error: unknown) => fail(error);
    const onData = (chunk: string | Buffer) => {
      if (done) return;
      try {
        node.consumeHttpDownloadChunk(
          state,
          destPath,
          requestedStart,
          onWriteError,
          Buffer.from(chunk),
        );
      } catch (error) {
        fail(error);
        return;
      }
      if (state.headerDone && state.remaining === 0) finish();
    };
    const onEnd = () => {
      if (!done && state.headerDone && state.remaining === 0) finish();
      else if (!done)
        fail(new Error("connection closed before full body received"));
    };
    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("end", onEnd);
  });
}

export async function sendPush(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
): Promise<unknown> {
  const route = node.pushRoutes.get(hit.serventIdHex);
  if (!route) throw new Error("no push route for servent");
  const peer = node.peers.get(route.peerKey);
  if (!peer) throw new Error("push route peer not connected");

  const payload = encodePush(
    node.rawHex16(hit.serventIdHex),
    hit.fileIndex,
    node.currentAdvertisedHost(),
    node.currentAdvertisedPort(),
  );
  const descriptorId = node.randomId16();
  const pending = new Promise((resolve, reject) => {
    node.enqueuePendingPush({
      serventIdHex: hit.serventIdHex,
      result: hit,
      destPath,
      createdAt: node.now(),
      resolve,
      reject,
    });
  });
  node.sendToPeer(
    peer,
    TYPE.PUSH,
    descriptorId,
    Math.max(1, hit.queryHops + 2),
    0,
    payload,
  );
  return await pending;
}

export async function downloadResult(
  node: GnutellaServent,
  resultNo: number,
  destOverride?: string,
): Promise<void> {
  const hit = node.lastResults.find(
    (candidate) => candidate.resultNo === resultNo,
  );
  if (!hit) throw new Error(`no such result ${resultNo}`);

  const destPath = destOverride
    ? path.resolve(destOverride)
    : await node.reserveAutoDownloadPath(hit.fileName);

  try {
    try {
      await node.directDownload(hit, destPath);
      recordDownloadSuccess(node, hit, destPath, "direct");
      return;
    } catch (error) {
      node.emitEvent({
        type: "DOWNLOAD_DIRECT_FAILED",
        at: ts(),
        resultNo: hit.resultNo,
        fileName: hit.fileName,
        destPath,
        remoteHost: hit.remoteHost,
        remotePort: hit.remotePort,
        message: errMsg(error),
      });
    }

    await node.sendPush(hit, destPath);
    recordDownloadSuccess(node, hit, destPath, "push");
  } finally {
    if (!destOverride) node.activeAutoDownloadPaths.delete(destPath);
  }
}

export function sendPing(node: GnutellaServent, ttl: number): void {
  if (!node.peers.size) return;
  const descriptorId = node.randomId16();
  const hex = descriptorId.toString("hex");
  node.markSeen(TYPE.PING, hex);
  node.pingRoutes.set(hex, LOCAL_ROUTE);
  const pingTtl = Math.max(0, Math.min(ttl, node.config().maxTtl));
  for (const peer of node.peers.values()) {
    if (node.nodeMode() === "ultrapeer" && node.isLeafPeer(peer)) continue;
    node.sendToPeer(
      peer,
      TYPE.PING,
      descriptorId,
      pingTtl,
      0,
      Buffer.alloc(0),
    );
  }
  node.emitEvent({
    type: "PING_SENT",
    at: ts(),
    descriptorIdHex: hex,
    ttl,
  });
}

export function sendQuery(
  node: GnutellaServent,
  search: string,
  ttl = node.config().defaultQueryTtl,
): void {
  if (!node.peers.size) {
    node.emitEvent({
      type: "QUERY_SKIPPED",
      at: ts(),
      reason: "NO_PEERS_CONNECTED",
    });
    return;
  }

  const descriptorId = node.randomId16();
  const hex = descriptorId.toString("hex");
  node.markSeen(TYPE.QUERY, hex);
  node.queryRoutes.set(hex, LOCAL_ROUTE);
  const query = splitOutgoingQuery(search);
  const payload = encodeQuery(query.search, {
    ggepHAllowed: !!node.config().enableGgep,
    maxHits: Math.min(0x1ff, node.config().maxResultsPerQuery),
    urns: query.urns,
  });
  node.broadcastQuery(
    descriptorId,
    Math.min(node.config().maxTtl, ttl),
    0,
    payload,
    search,
  );
  node.emitEvent({
    type: "QUERY_SENT",
    at: ts(),
    descriptorIdHex: hex,
    ttl,
    search,
  });
}
