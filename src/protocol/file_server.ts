import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";

import { errMsg } from "../shared";
import { parseByteRange } from "../transfers";
import type { ShareFile } from "../types";
import { hasToken, parseHttpHeaders, socketCanEnd } from "./handshake";
import {
  handleBrowseHostGet,
  isBrowseHostGetRequest,
} from "./browse_host";
import type { GnutellaServent } from "./node";
import type { ExistingGetRequest } from "./node_types";
import { sha1UrnFromUrn } from "./content_urn";

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(errMsg(error));
}

async function handleGetByFileIndex(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  first: string,
): Promise<boolean | undefined> {
  const match =
    /^(GET|HEAD)\s+\/get\/(\d+)\/(.+?)(?:\/)?\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (!match) return undefined;
  const fileIndex = Number(match[2]);
  const share = node.sharesByIndex.get(fileIndex);
  if (!share) {
    socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
    return false;
  }
  return await node.handleExistingGet(socket, head, share.abs, share);
}

async function handleUriResGet(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  first: string,
): Promise<boolean | undefined> {
  const match =
    /^(GET|HEAD)\s+\/uri-res\/N2R\?([^\s]+)\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
  if (!match || !node.config().serveUriRes) return undefined;
  const rawUrn = decodeURIComponent(match[2]);
  const urn = (sha1UrnFromUrn(rawUrn) || rawUrn).toLowerCase();
  const share = node.sharesByUrn.get(urn);
  if (!share) {
    socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
    return false;
  }
  return await node.handleExistingGet(socket, head, share.abs, share);
}

export async function handleIncomingGet(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  _body: Buffer = Buffer.alloc(0),
): Promise<boolean> {
  if (isBrowseHostGetRequest(head)) {
    return await handleBrowseHostGet(node, socket, head);
  }
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  const byIndex = await handleGetByFileIndex(node, socket, head, first);
  if (byIndex != null) return byIndex;
  const byUrn = await handleUriResGet(node, socket, head, first);
  if (byUrn != null) return byUrn;

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
    ...(share?.sha1Urn
      ? [
          `X-Gnutella-Content-URN: ${share.sha1Urn}`,
          `X-Content-URN: ${share.sha1Urn}`,
        ]
      : []),
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
