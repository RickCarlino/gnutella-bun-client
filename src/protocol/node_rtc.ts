import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { ensureDir, fileExists } from "../shared";
import type {
  QueryDescriptor,
  QueryHitDescriptor,
  SearchHit,
} from "../types";
import { buildGetRequest, parseByteRange } from "./codec";
import { parseGgep, type GgepItem } from "./ggep";
import { readHttpDownloadSource } from "./http_download_reader";
import type { GnutellaServent } from "./node";
import {
  advertisedRtcRendezvousEndpoints,
  cleanupRtcRendezvousState,
  parseRtcAnswerQuery,
  parseRtcRendezvousOfferRequest,
  pollRtcRendezvousOffer,
  postRtcRendezvousAnswer,
  postRtcRendezvousOffer,
  rtcRendezvousUrlForEndpoint,
  sanitizeRtcRendezvousUrls,
  storeRtcRendezvousAnswer,
  storeRtcRendezvousOffer,
  takeRtcRendezvousAnswer,
  takeRtcRendezvousOffer,
  type RtcRendezvousOffer,
  waitForRtcRendezvousAnswer,
} from "./rtc_rendezvous";
import {
  createRtcPeerConnection,
  encodeRtcHitGgep,
  encodeRtcQueryGgep,
  HttpByteStreamBuffer,
  parseRtcHitGgep,
  parseRtcQueryGgep,
  randomRtcId,
  RTC_CHANNEL_LABEL,
  RTC_CHANNEL_PROTOCOL,
  sanitizeRtcStunUrls,
  waitForRtcDataChannelOpen,
} from "./rtc_signal";
import type { RTCDataChannel, WeriftPeerConnection } from "./werift_local";

const RTC_COOKIE_LIFETIME_MS = 120_000;
const RTC_DATA_CHANNEL_MAX_CHUNK_BYTES = 16 * 1024;

function rtcCookie(node: GnutellaServent, queryId: Buffer): Buffer {
  const expirySeconds = Math.floor(
    (node.now() + RTC_COOKIE_LIFETIME_MS) / 1000,
  );
  const expiry = Buffer.alloc(4);
  expiry.writeUInt32BE(expirySeconds >>> 0, 0);
  const mac = crypto
    .createHmac("sha256", node.rtcCookieSecret)
    .update("rtc-upgrade/1-cookie")
    .update(queryId)
    .update(expiry)
    .digest()
    .subarray(0, 16);
  return Buffer.concat([expiry, mac]);
}

function validRtcCookie(
  node: GnutellaServent,
  queryId: Buffer,
  cookie: Buffer,
): boolean {
  if (cookie.length !== 20) return false;
  const expiry = cookie.subarray(0, 4);
  const expiresAtSeconds = expiry.readUInt32BE(0);
  if (expiresAtSeconds < Math.floor(node.now() / 1000)) return false;
  const expectedMac = crypto
    .createHmac("sha256", node.rtcCookieSecret)
    .update("rtc-upgrade/1-cookie")
    .update(queryId)
    .update(expiry)
    .digest()
    .subarray(0, 16);
  return crypto.timingSafeEqual(cookie.subarray(4), expectedMac);
}

function firstGgepItem(raw: Buffer): GgepItem {
  const [item] = parseGgep(raw);
  if (!item) throw new Error("missing GGEP item");
  return item;
}

function safeRtcQuery(
  rawExtensions: Buffer,
): ReturnType<typeof parseRtcQueryGgep> | undefined {
  try {
    return parseRtcQueryGgep(rawExtensions);
  } catch {
    return undefined;
  }
}

function safeRtcHit(
  rawPrivateArea: Buffer | undefined,
): ReturnType<typeof parseRtcHitGgep> | undefined {
  if (!rawPrivateArea?.length) return undefined;
  try {
    return parseRtcHitGgep(rawPrivateArea);
  } catch {
    return undefined;
  }
}

function channelDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  throw new Error("unsupported RTC data channel payload");
}

function sendRtcBuffer(
  channel: RTCDataChannel,
  payload: Buffer,
  maxChunkBytes = RTC_DATA_CHANNEL_MAX_CHUNK_BYTES,
): void {
  for (let off = 0; off < payload.length; off += maxChunkBytes) {
    channel.send(payload.subarray(off, off + maxChunkBytes));
  }
}

function sendRtcUtf8(
  channel: RTCDataChannel,
  payload: string,
  maxChunkBytes = RTC_DATA_CHANNEL_MAX_CHUNK_BYTES,
): void {
  sendRtcBuffer(channel, Buffer.from(payload, "utf8"), maxChunkBytes);
}

function rtcIceServerConfig(
  stunUrls: string[],
): { iceServers: Array<{ urls: string }> } | undefined {
  const normalized = sanitizeRtcStunUrls(stunUrls);
  if (!normalized.length) return undefined;
  return {
    iceServers: normalized.map((url) => ({ urls: url })),
  };
}

function localRtcStunUrls(node: GnutellaServent): string[] {
  return sanitizeRtcStunUrls(node.config().rtcStunServers);
}

function configuredRtcRendezvousUrls(node: GnutellaServent): string[] {
  return sanitizeRtcRendezvousUrls(node.config().rtcRendezvousUrls);
}

function createUploaderRtcPeerConnection(
  node: GnutellaServent,
): WeriftPeerConnection {
  return createRtcPeerConnection(
    rtcIceServerConfig(localRtcStunUrls(node)) || {},
  );
}

function createDownloaderRtcPeerConnection(
  node: GnutellaServent,
): WeriftPeerConnection {
  return createRtcPeerConnection(
    rtcIceServerConfig(localRtcStunUrls(node)) || {},
  );
}

function readRtcWaitTimeoutMs(node: GnutellaServent): number {
  return Math.max(node.config().downloadTimeoutMs, 5_000);
}

async function closeRtcPeerConnection(
  peerConnection: WeriftPeerConnection,
  channel?: RTCDataChannel,
): Promise<void> {
  try {
    channel?.close();
  } catch {
    // ignore
  }
  try {
    await peerConnection.close();
  } catch {
    // ignore
  }
}

function waitForIncomingRtcDataChannel(
  peerConnection: WeriftPeerConnection,
  timeoutMs: number,
): Promise<RTCDataChannel> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for incoming rtc data channel"));
    }, timeoutMs);
    peerConnection.ondatachannel = ({ channel }) => {
      if (
        channel.label !== RTC_CHANNEL_LABEL ||
        channel.protocol !== RTC_CHANNEL_PROTOCOL
      ) {
        clearTimeout(timer);
        reject(
          new Error(
            `unexpected rtc data channel ${channel.label}/${channel.protocol}`,
          ),
        );
        return;
      }
      clearTimeout(timer);
      resolve(channel);
    };
  });
}

function waitForRtcHttpRequest(
  channel: RTCDataChannel,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timed out waiting for rtc http request"));
    }, timeoutMs);
    const buffer = new HttpByteStreamBuffer();
    channel.onmessage = (event) => {
      try {
        buffer.append(channelDataToBuffer(event.data));
        const request = buffer.takeRequest();
        if (!request) return;
        clearTimeout(timer);
        resolve(request);
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    };
    channel.onclose = () => {
      clearTimeout(timer);
      reject(new Error("rtc data channel closed before request"));
    };
  });
}

async function streamRtcResponseBody(
  channel: RTCDataChannel,
  absPath: string,
  range: { start: number; end: number },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const reader = fs.createReadStream(absPath, {
      start: range.start,
      end: range.end,
    });
    reader.on("data", (chunk) => {
      try {
        sendRtcBuffer(channel, Buffer.from(chunk));
      } catch (error) {
        reject(error);
      }
    });
    reader.on("end", () => resolve());
    reader.on("error", (error) => reject(error));
  });
}

async function serveRtcHttpRequest(
  node: GnutellaServent,
  channel: RTCDataChannel,
  requestHead: string,
  fileIndex: number,
): Promise<void> {
  const share = node.sharesByIndex.get(fileIndex);
  if (!share) {
    sendRtcUtf8(channel, "HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }
  const request = node.parseExistingGetRequest(requestHead);
  const stat = await fsp.stat(share.abs);
  const range = parseByteRange(request.headers["range"], stat.size);
  if (!range) {
    sendRtcUtf8(
      channel,
      [
        `${request.responseVersion} 416 Range Not Satisfiable`,
        "Server: Gnutella",
        "Content-Type: application/binary",
        "Content-Length: 0",
        `Content-Range: bytes */${stat.size}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    return;
  }
  const remaining = node.existingGetBodyLength(range);
  sendRtcUtf8(
    channel,
    node.buildExistingGetResponseHeaders(
      request,
      range,
      stat.size,
      remaining,
      share,
    ),
  );
  if (request.method === "HEAD" || remaining === 0) return;
  await streamRtcResponseBody(channel, share.abs, range);
}

function rtcHttpRequestTarget(head: string): URL | undefined {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0] || "";
  const match = /^[A-Z]+\s+(\S+)\s+HTTP\/\d+\.\d+$/i.exec(first);
  if (!match) return undefined;
  try {
    return new URL(match[1], "http://127.0.0.1");
  } catch {
    return undefined;
  }
}

function rtcHttpRequestMethod(head: string): string {
  return (
    /^([A-Z]+)\s+/i
      .exec(head.replace(/\r\n/g, "\n").split("\n", 1)[0] || "")?.[1]
      ?.toUpperCase() || "GET"
  );
}

function rtcHttpReason(statusCode: number): string {
  return statusCode === 200
    ? "OK"
    : statusCode === 202
      ? "Accepted"
      : statusCode === 204
        ? "No Content"
        : statusCode === 400
          ? "Bad Request"
          : statusCode === 404
            ? "Not Found"
            : "Error";
}

function rtcHttpResponse(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  statusCode: number,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
): boolean {
  const request = node.parseExistingGetRequest(head);
  const header = Buffer.from(
    [
      `${request.responseVersion} ${statusCode} ${rtcHttpReason(statusCode)}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      `Content-Length: ${body.length}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
    "latin1",
  );
  socket.write(body.length ? Buffer.concat([header, body]) : header);
  return false;
}

async function readRtcHttpDownload(
  node: GnutellaServent,
  channel: RTCDataChannel,
  destPath: string,
  requestedStart: number,
): Promise<unknown> {
  return await readHttpDownloadSource({
    attach: ({ onChunk, onEnd, onError }) => {
      channel.onmessage = (event) =>
        onChunk(channelDataToBuffer(event.data));
      channel.onclose = onEnd;
      channel.onerror = onError;
      return () => {
        channel.onclose = undefined;
        channel.onmessage = undefined;
        channel.onerror = undefined;
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
    incompleteMessage: "rtc data channel closed before full body received",
    label: `rtc:${channel.label}`,
    requestedStart,
  });
}

async function handleRtcOffer(
  node: GnutellaServent,
  offer: RtcRendezvousOffer,
  serverUrl: string,
): Promise<void> {
  if (!node.config().rtc) return;
  const queryId = Buffer.from(offer.queryIdHex, "hex");
  const cookie = Buffer.from(offer.cookieHex, "hex");
  if (!validRtcCookie(node, queryId, cookie)) return;
  const timeoutMs = readRtcWaitTimeoutMs(node);
  const peerConnection = createUploaderRtcPeerConnection(node);
  const incomingChannel = waitForIncomingRtcDataChannel(
    peerConnection,
    timeoutMs,
  );
  try {
    await peerConnection.setRemoteDescription({
      sdp: offer.sdp,
      type: "offer",
    });
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    const sdp = peerConnection.localDescription?.sdp;
    if (!sdp) throw new Error("missing rtc local answer");
    await postRtcRendezvousAnswer(
      serverUrl,
      {
        ridHex: offer.ridHex,
        sdp,
      },
      offer.tokenHex,
    );
    const channel = await incomingChannel;
    await waitForRtcDataChannelOpen(channel, timeoutMs);
    const requestHead = await waitForRtcHttpRequest(channel, timeoutMs);
    await serveRtcHttpRequest(node, channel, requestHead, offer.fileIndex);
    await closeRtcPeerConnection(peerConnection, channel);
  } catch (error) {
    await closeRtcPeerConnection(peerConnection);
    throw error;
  }
}

function handleRtcOfferPostHttp(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  body: Buffer,
): boolean {
  const request = node.parseExistingGetRequest(head);
  const offer = parseRtcRendezvousOfferRequest(request.headers, body);
  if (!offer) return rtcHttpResponse(node, socket, head, 400);
  storeRtcRendezvousOffer(node.rtcRendezvousState, offer);
  return rtcHttpResponse(node, socket, head, 202);
}

function handleRtcOfferGetHttp(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  target: URL,
): boolean {
  const targetServentIdHex =
    target.searchParams.get("target")?.toLowerCase() || "";
  if (!/^[0-9a-f]{32}$/.test(targetServentIdHex)) {
    return rtcHttpResponse(node, socket, head, 400);
  }
  const offer = takeRtcRendezvousOffer(
    node.rtcRendezvousState,
    targetServentIdHex,
  );
  if (!offer) return rtcHttpResponse(node, socket, head, 204);
  return rtcHttpResponse(
    node,
    socket,
    head,
    200,
    Buffer.from(offer.sdp, "utf8"),
    {
      "Content-Type": "application/sdp",
      "X-RTC-Cookie": offer.cookieHex,
      "X-RTC-File-Index": String(offer.fileIndex),
      "X-RTC-Query-ID": offer.queryIdHex,
      "X-RTC-RID": offer.ridHex,
      "X-RTC-Token": offer.tokenHex,
    },
  );
}

function handleRtcAnswerPostHttp(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  body: Buffer,
  target: URL,
): boolean {
  const query = parseRtcAnswerQuery(target);
  const sdp = body.toString("utf8");
  if (!query || !sdp.trim()) {
    return rtcHttpResponse(node, socket, head, 400);
  }
  return storeRtcRendezvousAnswer(
    node.rtcRendezvousState,
    {
      ridHex: query.ridHex,
      sdp,
    },
    query.tokenHex,
  )
    ? rtcHttpResponse(node, socket, head, 202)
    : rtcHttpResponse(node, socket, head, 404);
}

function handleRtcAnswerGetHttp(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  target: URL,
): boolean {
  const query = parseRtcAnswerQuery(target);
  if (!query) return rtcHttpResponse(node, socket, head, 400);
  const answer = takeRtcRendezvousAnswer(
    node.rtcRendezvousState,
    query.ridHex,
    query.tokenHex,
  );
  if (answer === null) return rtcHttpResponse(node, socket, head, 404);
  if (!answer) return rtcHttpResponse(node, socket, head, 204);
  return rtcHttpResponse(
    node,
    socket,
    head,
    200,
    Buffer.from(answer.sdp, "utf8"),
    {
      "Content-Type": "application/sdp",
    },
  );
}

export async function handleRtcRendezvousHttp(
  node: GnutellaServent,
  socket: net.Socket,
  head: string,
  body: Buffer,
): Promise<boolean | undefined> {
  const target = rtcHttpRequestTarget(head);
  if (!target || !target.pathname.startsWith("/rtc/")) return undefined;
  if (!node.config().rtc) return rtcHttpResponse(node, socket, head, 404);
  cleanupRtcRendezvousState(node.rtcRendezvousState, node.now());
  const routeKey = `${rtcHttpRequestMethod(head)} ${target.pathname}`;
  if (routeKey === "POST /rtc/offer") {
    return handleRtcOfferPostHttp(node, socket, head, body);
  }
  if (routeKey === "GET /rtc/offer") {
    return handleRtcOfferGetHttp(node, socket, head, target);
  }
  if (routeKey === "POST /rtc/answer") {
    return handleRtcAnswerPostHttp(node, socket, head, body, target);
  }
  if (routeKey === "GET /rtc/answer") {
    return handleRtcAnswerGetHttp(node, socket, head, target);
  }
  return rtcHttpResponse(node, socket, head, 404);
}

export function queryRtcGgepItems(node: GnutellaServent): GgepItem[] {
  if (!node.config().rtc) return [];
  return [firstGgepItem(encodeRtcQueryGgep())];
}

export function queryHitRtcGgepItems(
  node: GnutellaServent,
  query: QueryDescriptor,
  queryId: Buffer,
): GgepItem[] {
  if (!node.config().rtc) return [];
  const rendezvousEndpoints = advertisedRtcRendezvousEndpoints(
    configuredRtcRendezvousUrls(node),
  );
  if (!rendezvousEndpoints.length) return [];
  if (!safeRtcQuery(query.rawExtensions)) return [];
  return [
    firstGgepItem(
      encodeRtcHitGgep({
        cookie: rtcCookie(node, queryId),
        rendezvousEndpoints,
      }),
    ),
  ];
}

export function applyRtcCapabilityToHit(
  queryHit: QueryHitDescriptor,
  hit: SearchHit,
): void {
  const rtcHit = safeRtcHit(queryHit.qhdPrivateArea);
  if (!rtcHit) return;
  if (!rtcHit.rendezvousEndpoints.length) return;
  hit.rtc = {
    cookieHex: rtcHit.cookie.toString("hex"),
    rendezvousEndpoints: rtcHit.rendezvousEndpoints.map((endpoint) => ({
      host: endpoint.host,
      port: endpoint.port,
    })),
  };
}

export async function pollRtcRendezvousOffers(
  node: GnutellaServent,
): Promise<void> {
  if (!node.config().rtc) return;
  cleanupRtcRendezvousState(node.rtcRendezvousState, node.now());
  const urls = configuredRtcRendezvousUrls(node);
  if (!urls.length) return;
  await Promise.allSettled(
    urls.map(async (url) => {
      if (node.rtcRendezvousPollInflight.has(url)) return;
      node.rtcRendezvousPollInflight.add(url);
      try {
        const offer = await pollRtcRendezvousOffer(
          url,
          node.serventId.toString("hex"),
        );
        if (!offer) return;
        await handleRtcOffer(node, offer, url);
      } finally {
        node.rtcRendezvousPollInflight.delete(url);
      }
    }),
  );
}

async function downloadViaRtcEndpoint(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
  rendezvousUrl: string,
): Promise<unknown> {
  const existing = (await fileExists(destPath))
    ? (await fsp.stat(destPath)).size
    : 0;
  const timeoutMs = readRtcWaitTimeoutMs(node);
  const ridHex = randomRtcId().toString("hex");
  const tokenHex = crypto.randomBytes(16).toString("hex");
  const peerConnection = createDownloaderRtcPeerConnection(node);
  const channel = peerConnection.createDataChannel(RTC_CHANNEL_LABEL, {
    ordered: true,
    protocol: RTC_CHANNEL_PROTOCOL,
  });

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    const localSdp = peerConnection.localDescription?.sdp;
    if (!localSdp) throw new Error("missing rtc local offer");
    await postRtcRendezvousOffer(rendezvousUrl, {
      cookieHex: hit.rtc!.cookieHex,
      fileIndex: hit.fileIndex,
      queryIdHex: hit.queryIdHex,
      ridHex,
      sdp: localSdp,
      targetServentIdHex: hit.serventIdHex,
      tokenHex,
    });
    const answer = await waitForRtcRendezvousAnswer(
      rendezvousUrl,
      ridHex,
      tokenHex,
      timeoutMs,
      (ms) => node.sleep(ms),
    );
    await peerConnection.setRemoteDescription({
      sdp: answer.sdp,
      type: "answer",
    });
    await waitForRtcDataChannelOpen(channel, timeoutMs);
    const response = readRtcHttpDownload(
      node,
      channel,
      destPath,
      existing,
    );
    sendRtcUtf8(
      channel,
      buildGetRequest(hit.fileIndex, hit.fileName, existing),
    );
    const result = await response;
    await closeRtcPeerConnection(peerConnection, channel);
    return result;
  } catch (error) {
    await closeRtcPeerConnection(peerConnection, channel);
    throw error;
  }
}

export async function downloadViaRtc(
  node: GnutellaServent,
  hit: SearchHit,
  destPath: string,
): Promise<unknown> {
  const rtc = hit.rtc;
  if (!rtc) throw new Error("hit is not rtc capable");
  await ensureDir(path.dirname(destPath));
  const urls = rtc.rendezvousEndpoints.map((endpoint) =>
    rtcRendezvousUrlForEndpoint(endpoint),
  );
  if (!urls.length) throw new Error("no rtc rendezvous route");
  let lastError: unknown;
  for (const rendezvousUrl of urls) {
    try {
      return await downloadViaRtcEndpoint(
        node,
        hit,
        destPath,
        rendezvousUrl,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("rtc download failed");
}
