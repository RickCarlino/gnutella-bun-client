import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { LOCAL_ROUTE, TYPE } from "../const";
import { ensureDir, errMsg, fileExists, ts } from "../shared";
import {
  directDownloadAttempts,
  type DirectDownloadAttempt,
} from "../transfers";
import type { DownloadJob } from "../downloads/types";
import { DownloadTimeoutError } from "../transfers/errors";
import type {
  HttpDownloadResult,
  TransferOptions,
} from "../transfers/types";
import type { PendingPush, SearchHit } from "../types";
import {
  buildGetRequest,
  buildUriResRequest,
  encodePush,
  encodeQuery,
  parseHttpDownloadHeader,
} from "./codec";
import { findHeaderEnd } from "./handshake";
import { readHttpDownloadSource } from "./http_download_reader";
import {
  connectDownloadSocket,
  downloadHttpSession,
} from "./http_download_session";
import { browsePeer as browsePeerImpl } from "./browse_host";
import { parseMagnetUri } from "./magnet";
import type { GnutellaServent } from "./node";
import type { HttpDownloadState } from "./node_types";
import { splitQuerySearch } from "./query_search";

type OutgoingQueryParts = {
  search: string;
  urns: string[];
};

function abortError(): Error {
  return new Error("download aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function downloadOptions(
  hit: SearchHit,
  options: TransferOptions = {},
): TransferOptions {
  return { ...options, expectedSize: hit.fileSize || undefined };
}

async function existingDownloadBytes(destPath: string): Promise<number> {
  await ensureDir(path.dirname(destPath));
  return (await fileExists(destPath))
    ? (await fsp.stat(destPath)).size
    : 0;
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
      downloadOptions(pending.result, pending.transferOptions),
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
  options: TransferOptions = {},
): Promise<unknown> {
  throwIfAborted(options.signal);
  const existing = await existingDownloadBytes(destPath);
  return await downloadHttpSession({
    node,
    socket,
    destPath,
    options,
    label: `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`,
    start: existing,
    request: (start) =>
      buildGetRequest(
        fileIndex,
        fileName,
        start,
        socket.remoteAddress || undefined,
        socket.remotePort || undefined,
      ),
  });
}

export async function directDownloadViaRequest(
  node: GnutellaServent,
  host: string,
  port: number,
  request: string,
  destPath: string,
  existing: number,
  options: TransferOptions = {},
): Promise<unknown> {
  const reconnect = () => connectDownloadSocket(node, host, port, options);
  return await downloadHttpSession({
    node,
    socket: await reconnect(),
    reconnect,
    destPath,
    options,
    label: `${host}:${port}`,
    start: existing,
    request: (start) =>
      request.replace(
        /^Range: bytes=\d+-\r$/m,
        `Range: bytes=${start}-\r`,
      ),
  });
}

export async function directDownload(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
  options: TransferOptions = {},
): Promise<unknown> {
  throwIfAborted(options.signal);
  const existing = await existingDownloadBytes(destPath);

  const errors: string[] = [];
  const attempts = directDownloadAttempts({
    fileIndex: hit.fileIndex,
    fileName: hit.fileName,
    remoteHost: hit.remoteHost,
    remotePort: hit.remotePort,
    sha1Urn: hit.sha1Urn,
    existingBytes: existing,
    serveUriRes: node.config().serveUriRes,
  });
  for (const planned of attempts) {
    const attempt = {
      ...planned,
      existingBytes: await existingDownloadBytes(destPath),
    };
    try {
      return await node.directDownloadViaRequest(
        hit.remoteHost,
        hit.remotePort,
        directDownloadRequest(attempt, hit.remoteHost, hit.remotePort),
        destPath,
        attempt.existingBytes,
        downloadOptions(hit, options),
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const method = attempt.kind === "uri-res" ? "uri-res" : "/get";
      errors.push(`${method}: ${errMsg(error)}`);
      if (error instanceof DownloadTimeoutError) {
        throw new DownloadTimeoutError(error.phase, errors.join("; "));
      }
      if (!attempt.fallbackOnFailure) break;
    }
  }
  throw new Error(errors.join("; "));
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
  state.range = parsed.range;
  state.connectionClose = parsed.connectionClose;
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
  options: TransferOptions = {},
): Promise<HttpDownloadResult> {
  return await readHttpDownloadSource({
    attach: ({ onChunk, onEnd, onError, onTimeout }) => {
      const onData = (chunk: string | Buffer) =>
        onChunk(Buffer.from(chunk));
      socket.on("error", onError);
      socket.on("data", onData);
      socket.on("end", onEnd);
      socket.on("close", onEnd);
      socket.on("timeout", onTimeout);
      socket.setTimeout(node.config().downloadTimeoutMs);
      return () => {
        socket.off("timeout", onTimeout);
        socket.setTimeout(0);
        socket.off("error", onError);
        socket.off("data", onData);
        socket.off("end", onEnd);
        socket.off("close", onEnd);
      };
    },
    consumeChunk: (state, targetPath, start, onWriteError, chunk) => {
      const wasReadingHeaders = !state.headerDone;
      node.consumeHttpDownloadChunk(
        state,
        targetPath,
        start,
        onWriteError,
        chunk,
      );
      if (wasReadingHeaders && state.headerDone) {
        socket.setTimeout(node.config().downloadIdleTimeoutMs);
      }
    },
    destPath,
    destroyOnFailure: () => socket.destroy(),
    incompleteMessage: "connection closed before full body received",
    label,
    options,
    requestedStart,
    timeoutMs: node.config().downloadTimeoutMs,
    bodyTimeoutMs: node.config().downloadIdleTimeoutMs,
  });
}

export async function sendPush(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
  options: TransferOptions = {},
): Promise<unknown> {
  throwIfAborted(options.signal);
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
  let pendingEntry: PendingPush | undefined;
  const pending = new Promise((resolve, reject) => {
    pendingEntry = {
      serventIdHex: hit.serventIdHex,
      result: hit,
      destPath,
      transferOptions: options,
      createdAt: node.now(),
      resolve,
      reject,
    };
    node.enqueuePendingPush(pendingEntry);
  });
  const removePending = () => {
    if (!pendingEntry) return;
    const queue = node.pendingPushes.get(pendingEntry.serventIdHex);
    if (!queue) return;
    const keep = queue.filter((candidate) => candidate !== pendingEntry);
    if (keep.length)
      node.pendingPushes.set(pendingEntry.serventIdHex, keep);
    else node.pendingPushes.delete(pendingEntry.serventIdHex);
  };
  const onAbort = () => {
    removePending();
    pendingEntry?.reject(abortError());
  };
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  node.sendToPeer(
    peer,
    TYPE.PUSH,
    descriptorId,
    Math.max(1, hit.queryHops + 2),
    0,
    payload,
  );
  try {
    return await pending;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function downloadResult(
  node: GnutellaServent,
  resultNo: number,
  destOverride?: string,
): Promise<DownloadJob> {
  return await node.queueDownloadResult(resultNo, destOverride);
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
