import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { LOCAL_ROUTE, TYPE } from "../const";
import { ensureDir, errMsg, fileExists, ts } from "../shared";
import {
  buildDownloadRecord,
  directDownloadAttempts,
  shouldTryPushFallback,
  type DirectDownloadAttempt,
} from "../transfers";
import type { SearchHit } from "../types";
import {
  buildGetRequest,
  buildUriResRequest,
  encodePush,
  encodeQuery,
  parseHttpDownloadHeader,
} from "./codec";
import { findHeaderEnd, socketCanEnd } from "./handshake";
import { readHttpDownloadSource } from "./http_download_reader";
import { browsePeer as browsePeerImpl } from "./browse_host";
import { parseMagnetUri } from "./magnet";
import type { GnutellaServent } from "./node";
import type { HttpDownloadState } from "./node_types";
import { splitQuerySearch } from "./query_search";

type OutgoingQueryParts = {
  search: string;
  urns: string[];
};

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

function splitOutgoingQuery(search: string): OutgoingQueryParts {
  const magnet = parseMagnetUri(search);
  if (magnet) {
    return {
      search: magnet.search || "",
      urns: magnet.urns,
    };
  }
  return splitQuerySearch(search);
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
  node.downloads.push(buildDownloadRecord(hit, destPath, mode, ts()));
}

function directDownloadRequest(
  attempt: DirectDownloadAttempt,
  host: string,
  port: number,
): string {
  if (attempt.kind === "uri-res") {
    return buildUriResRequest(
      attempt.urn,
      attempt.existingBytes,
      host,
      port,
    );
  }
  return buildGetRequest(
    attempt.fileIndex,
    attempt.fileName,
    attempt.existingBytes,
    host,
    port,
  );
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

  let lastError: unknown;
  const attempts = directDownloadAttempts({
    fileIndex: hit.fileIndex,
    fileName: hit.fileName,
    remoteHost: hit.remoteHost,
    remotePort: hit.remotePort,
    sha1Urn: hit.sha1Urn,
    existingBytes: existing,
    serveUriRes: node.config().serveUriRes,
  });
  for (const attempt of attempts) {
    try {
      return await node.directDownloadViaRequest(
        hit.remoteHost,
        hit.remotePort,
        directDownloadRequest(attempt, hit.remoteHost, hit.remotePort),
        destPath,
        attempt.existingBytes,
      );
    } catch (error) {
      lastError = error;
      if (!attempt.fallbackOnFailure) throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(errMsg(lastError));
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
  return await readHttpDownloadSource({
    attach: ({ onChunk, onEnd, onError }) => {
      const onData = (chunk: string | Buffer) =>
        onChunk(Buffer.from(chunk));
      socket.on("error", onError);
      socket.on("data", onData);
      socket.on("end", onEnd);
      return () => {
        socket.off("error", onError);
        socket.off("data", onData);
        socket.off("end", onEnd);
      };
    },
    consumeChunk: (state, targetPath, start, onWriteError, chunk) =>
      node.consumeHttpDownloadChunk(
        state,
        targetPath,
        start,
        onWriteError,
        chunk,
      ),
    destPath,
    destroyOnFailure: () => socket.destroy(),
    incompleteMessage: "connection closed before full body received",
    label,
    requestedStart,
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

    if (shouldTryPushFallback(hit)) {
      await node.sendPush(hit, destPath);
      recordDownloadSuccess(node, hit, destPath, "push");
    }
  } finally {
    if (!destOverride) node.activeAutoDownloadPaths.delete(destPath);
  }
}

export async function browsePeer(
  node: GnutellaServent,
  peerKey: string,
): Promise<number> {
  return await browsePeerImpl(node, peerKey);
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
