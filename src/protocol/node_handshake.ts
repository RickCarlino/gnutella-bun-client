import net from "node:net";

import { DEFAULT_USER_AGENT, MAX_XTRY } from "../const";
import {
  errMsg,
  normalizeIpv4,
  normalizePeer,
  parsePeer,
  toBuffer,
  ts,
} from "../shared";
import type { PeerCapabilities, PeerRole } from "../types";
import {
  buildHandshakeBlock,
  describeHandshakeResponse,
  findHeaderEnd,
  hasToken,
  lowerCaseHeaders,
  mergeHeaders,
  parseBoolHeader,
  parseHandshakeBlock,
  parseListenIpHeader,
  parsePeerHeaderList,
} from "./handshake";
import type { GnutellaServent } from "./node";
import type { ProbeCtx } from "./node_types";

function clearProbeListeners(ctx: ProbeCtx): void {
  if (ctx.onData) ctx.socket.off("data", ctx.onData);
  if (ctx.onError) ctx.socket.off("error", ctx.onError);
}

function handshakePeerLabel(socket: net.Socket): string {
  return `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`;
}

function emitHandshakeDebug(
  node: GnutellaServent,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  message: string,
): void {
  node.emitEvent({
    type: "HANDSHAKE_DEBUG",
    at: ts(),
    direction,
    phase,
    peer,
    message,
  });
}

function emitHandshakeBlock(
  node: GnutellaServent,
  direction: "inbound" | "outbound",
  phase: string,
  peer: string,
  startLine: string,
  headers: Record<string, string>,
): void {
  emitHandshakeDebug(
    node,
    direction,
    phase,
    peer,
    describeHandshakeResponse(startLine, headers),
  );
}

function ultrapeerNeededHeader(node: GnutellaServent): string | undefined {
  if (node.nodeMode() !== "ultrapeer") return undefined;
  if (node.connectedMeshPeerCount() < node.config().maxConnections)
    return "True";
  if (node.connectedLeafCount() < node.config().maxLeafConnections)
    return "False";
  return undefined;
}

function baseRoleHeaders(node: GnutellaServent): Record<string, string> {
  const headers: Record<string, string> = {
    "x-ultrapeer": node.nodeMode() === "ultrapeer" ? "True" : "False",
  };
  const ultrapeerNeeded = ultrapeerNeededHeader(node);
  if (ultrapeerNeeded) headers["x-ultrapeer-needed"] = ultrapeerNeeded;
  if (node.nodeMode() === "ultrapeer")
    headers["x-ultrapeer-query-routing"] = "0.1";
  return headers;
}

function baseFeatureHeaders(
  node: GnutellaServent,
): Record<string, string> {
  const c = node.config();
  const headers: Record<string, string> = {};
  if (c.enableQrp)
    headers["x-query-routing"] = c.queryRoutingVersion || "0.1";
  if (c.enableCompression) headers["accept-encoding"] = "deflate";
  if (c.enablePongCaching) headers["pong-caching"] = "0.1";
  if (c.enableGgep) headers["ggep"] = "0.5";
  if (c.enableBye) headers["bye-packet"] = "0.1";
  return headers;
}

export function baseHandshakeHeaders(
  node: GnutellaServent,
  remoteIp?: string,
): Record<string, string> {
  const c = node.config();
  const advertisedHost = node.currentAdvertisedHost();
  const advertisedPort = node.currentAdvertisedPort();
  const headers: Record<string, string> = {
    "user-agent": c.userAgent || DEFAULT_USER_AGENT,
    "listen-ip": `${advertisedHost}:${advertisedPort}`,
    "x-max-ttl": String(c.maxTtl),
    ...baseRoleHeaders(node),
    ...baseFeatureHeaders(node),
  };
  const observedRemote = normalizeIpv4(remoteIp);
  if (observedRemote) headers["remote-ip"] = observedRemote;
  return headers;
}

export function buildServerHandshakeHeaders(
  node: GnutellaServent,
  requestHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  const headers = node.baseHandshakeHeaders(remoteIp);
  if (node.tlsEnabled() && node.peerRequestedTlsUpgrade(requestHeaders)) {
    headers.upgrade = node.tlsUpgradeToken();
    headers.connection = "Upgrade";
  }
  if (
    node.config().enableCompression &&
    hasToken(requestHeaders["accept-encoding"], "deflate")
  ) {
    headers["content-encoding"] = "deflate";
  }
  return headers;
}

export function buildClientFinalHeaders(
  node: GnutellaServent,
  serverHeaders: Record<string, string>,
  remoteIp?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const observedRemote = normalizeIpv4(remoteIp);
  if (observedRemote) headers["remote-ip"] = observedRemote;
  if (node.tlsEnabled() && node.peerAcceptedTlsUpgrade(serverHeaders))
    headers.connection = "Upgrade";
  if (
    node.config().enableCompression &&
    hasToken(serverHeaders["accept-encoding"], "deflate")
  ) {
    headers["content-encoding"] = "deflate";
  }
  return headers;
}

export function buildCapabilities(
  node: GnutellaServent,
  version: string,
  headers: Record<string, string>,
  compressIn: boolean,
  compressOut: boolean,
): PeerCapabilities {
  const h = lowerCaseHeaders(headers);
  return {
    version,
    headers: h,
    userAgent: h["user-agent"],
    supportsGgep: !!h["ggep"],
    supportsPongCaching: !!h["pong-caching"],
    supportsBye: !!h["bye-packet"],
    supportsTls: node.peerRequestedTlsUpgrade(h),
    supportsCompression:
      hasToken(h["accept-encoding"], "deflate") ||
      hasToken(h["content-encoding"], "deflate"),
    compressIn,
    compressOut,
    isUltrapeer: parseBoolHeader(h["x-ultrapeer"]),
    ultrapeerNeeded: parseBoolHeader(h["x-ultrapeer-needed"]),
    queryRoutingVersion: h["x-query-routing"],
    ultrapeerQueryRoutingVersion: h["x-ultrapeer-query-routing"],
    isCrawler: !!h["crawler"],
    listenIp: parseListenIpHeader(h["listen-ip"]),
  };
}

export function selectTryPeers(
  node: GnutellaServent,
  limit = MAX_XTRY,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (peerSpec?: string) => {
    if (!peerSpec) return;
    const addr = parsePeer(peerSpec);
    if (!addr) return;
    const peer = normalizePeer(addr.host, addr.port);
    if (node.isSelfPeer(addr.host, addr.port) || seen.has(peer)) return;
    seen.add(peer);
    out.push(peer);
  };

  for (const peer of node.peers.values()) {
    if (peer.capabilities.listenIp) {
      push(
        normalizePeer(
          peer.capabilities.listenIp.host,
          peer.capabilities.listenIp.port,
        ),
      );
    } else if (peer.dialTarget) {
      push(peer.dialTarget);
    } else {
      push(peer.remoteLabel);
    }
    if (out.length >= limit) return out;
  }

  for (const peerSpec of node.getKnownPeers()) {
    push(peerSpec);
    if (out.length >= limit) break;
  }
  return out;
}

export function maybeAbsorbTryHeaders(
  node: GnutellaServent,
  headers: Record<string, string>,
): void {
  for (const addr of [
    ...parsePeerHeaderList(headers["x-try"]),
    ...parsePeerHeaderList(headers["x-try-ultrapeers"]),
  ]) {
    node.addKnownPeer(addr.host, addr.port);
  }
}

export function reject06(
  node: GnutellaServent,
  socket: net.Socket,
  code: number,
  reason: string,
  extraHeaders: Record<string, string> = {},
): void {
  const tryPeers = node.selectTryPeers();
  const headers = lowerCaseHeaders(extraHeaders);
  const observedRemote = normalizeIpv4(socket.remoteAddress);
  if (observedRemote) headers["remote-ip"] = observedRemote;
  if (tryPeers.length) {
    headers["x-try"] = tryPeers.join(",");
    headers["x-try-ultrapeers"] = tryPeers.join(",");
  }
  emitHandshakeBlock(
    node,
    "inbound",
    "reject-sent",
    handshakePeerLabel(socket),
    `GNUTELLA/0.6 ${code} ${reason}`,
    headers,
  );
  socket.end(
    buildHandshakeBlock(`GNUTELLA/0.6 ${code} ${reason}`, headers),
  );
}

export function handleProbe(
  node: GnutellaServent,
  socket: net.Socket,
): void {
  const ctx: ProbeCtx = {
    socket,
    buf: Buffer.alloc(0),
    mode: "undecided",
  };
  socket.setNoDelay(true);
  ctx.onData = (chunk) => {
    if (ctx.mode === "done") return;
    ctx.buf = Buffer.concat([ctx.buf, toBuffer(chunk)]);
    try {
      node.tryDecideProbe(ctx);
    } catch (error) {
      emitHandshakeDebug(
        node,
        "inbound",
        "failed",
        handshakePeerLabel(socket),
        errMsg(error),
      );
      node.emitEvent({
        type: "PROBE_REJECTED",
        at: ts(),
        message: errMsg(error),
      });
      socket.destroy();
    }
  };
  ctx.onError = () => void 0;
  socket.on("data", ctx.onData);
  socket.on("error", ctx.onError);
}

export function handleUndecidedProbe(
  node: GnutellaServent,
  ctx: ProbeCtx,
): void {
  const raw = ctx.buf.toString("latin1");
  if (raw.startsWith("GNUTELLA CONNECT/0.6")) {
    node.handleInbound06Probe(ctx, raw);
    return;
  }
  if (/^GNUTELLA CONNECT\/0\./i.test(raw)) {
    node.rejectLegacyInboundProbe(raw);
    return;
  }
  if (/^(GET|HEAD|POST)\s+/i.test(raw)) {
    node.startHttpProbeSession(ctx, raw);
    return;
  }
  if (raw.startsWith("GIV ")) {
    node.startGivProbeSession(ctx, raw);
    return;
  }
  if (ctx.buf.length > 8192) throw new Error("unknown inbound protocol");
}

export function handleInbound06Probe(
  node: GnutellaServent,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  emitHandshakeBlock(
    node,
    "inbound",
    "connect-recv",
    handshakePeerLabel(ctx.socket),
    startLine,
    headers,
  );
  if (!/^GNUTELLA CONNECT\/0\.[0-9]+/i.test(startLine)) {
    throw new Error(`unexpected 0.6 start line: ${startLine}`);
  }
  node.absorbHandshakeHeaders(headers, ctx.socket.remoteAddress);
  const requestedCaps = node.buildCapabilities(
    "0.6",
    headers,
    false,
    false,
  );
  const requestedRole = node.classifyPeerRole(requestedCaps);
  const acceptance = node.canAcceptPeerRole(requestedRole);
  if (!acceptance.ok) {
    node.reject06(ctx.socket, acceptance.code, acceptance.reason);
    ctx.mode = "done";
    clearProbeListeners(ctx);
    return;
  }
  ctx.requestHeaders = headers;
  ctx.serverHeaders = node.buildServerHandshakeHeaders(
    headers,
    ctx.socket.remoteAddress,
  );
  ctx.socket.write(
    buildHandshakeBlock("GNUTELLA/0.6 200 OK", ctx.serverHeaders),
  );
  emitHandshakeBlock(
    node,
    "inbound",
    "response-sent",
    handshakePeerLabel(ctx.socket),
    "GNUTELLA/0.6 200 OK",
    ctx.serverHeaders,
  );
  ctx.buf = ctx.buf.subarray(cut);
  ctx.mode = "await-final-0.6";
  node.tryDecideProbe(ctx);
}

export function rejectLegacyInboundProbe(
  _node: GnutellaServent,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine } = parseHandshakeBlock(raw.slice(0, cut));
  throw new Error(`unsupported inbound handshake: ${startLine}`);
}

export function startHttpProbeSession(
  node: GnutellaServent,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  ctx.mode = "done";
  clearProbeListeners(ctx);
  node.startHttpSession(
    ctx.socket,
    raw.slice(0, cut),
    ctx.buf.subarray(cut),
  );
}

export function startGivProbeSession(
  node: GnutellaServent,
  ctx: ProbeCtx,
  raw: string,
): void {
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  ctx.mode = "done";
  clearProbeListeners(ctx);
  void node
    .handleIncomingGiv(ctx.socket, raw.slice(0, cut))
    .catch(() => ctx.socket.destroy());
}

function finalHandshakeCode(startLine: string): number {
  const match = /^GNUTELLA\/0\.[0-9]+\s+(\d+)/i.exec(startLine);
  if (!match) throw new Error(`unexpected final 0.6 line: ${startLine}`);
  return Number(match[1]);
}

function compressionAccepted(
  enabled: boolean,
  headers: Record<string, string>,
): boolean {
  return enabled && hasToken(headers["content-encoding"], "deflate");
}

type OutboundHandshakeResult = {
  caps: PeerCapabilities;
  role: PeerRole;
  rest: Buffer;
  finalHeadersWithRemote: Record<string, string>;
};

function shouldUpgradeSocketToTls(
  node: GnutellaServent,
  socket: net.Socket,
  acceptedByServer: boolean,
  acceptedByClient: boolean,
): boolean {
  return (
    node.tlsEnabled() &&
    node.canUpgradeSocketToTls(socket) &&
    acceptedByServer &&
    acceptedByClient
  );
}

function attachInbound06Peer(
  node: GnutellaServent,
  socket: net.Socket,
  remoteLabel: string,
  role: PeerRole,
  caps: PeerCapabilities,
  rest: Buffer,
  serverHeaders: Record<string, string>,
  clientHeaders: Record<string, string>,
): void {
  const upgradeToTls = shouldUpgradeSocketToTls(
    node,
    socket,
    node.peerAcceptedTlsUpgrade(serverHeaders),
    node.clientAcceptedTlsUpgrade(clientHeaders),
  );
  if (!upgradeToTls) {
    node.attachPeer(socket, false, remoteLabel, role, caps, rest);
    return;
  }
  emitHandshakeDebug(
    node,
    "inbound",
    "tls-upgrade-start",
    remoteLabel,
    "upgrading socket to TLS",
  );
  void node
    .upgradeSocketToTls(socket, "server", rest)
    .then((tlsSocket) => {
      emitHandshakeDebug(
        node,
        "inbound",
        "tls-upgrade-ok",
        remoteLabel,
        "TLS active",
      );
      node.attachPeer(tlsSocket, false, remoteLabel, role, caps);
    })
    .catch((error) => {
      emitHandshakeDebug(
        node,
        "inbound",
        "tls-upgrade-failed",
        remoteLabel,
        errMsg(error),
      );
      node.emitEvent({
        type: "PROBE_REJECTED",
        at: ts(),
        message: `TLS upgrade failed: ${errMsg(error)}`,
      });
      socket.destroy();
    });
}

function parseOutboundHandshakeResult(
  node: GnutellaServent,
  target: string,
  socket: net.Socket,
  buf: Buffer,
  compressionEnabled: boolean,
): OutboundHandshakeResult | undefined {
  const raw = buf.toString("latin1");
  const cut = findHeaderEnd(raw);
  if (cut === -1) return undefined;

  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  node.absorbHandshakeHeaders(headers, socket.remoteAddress);
  emitHandshakeBlock(
    node,
    "outbound",
    "response-recv",
    target,
    startLine,
    headers,
  );
  if (
    /^GNUTELLA OK/i.test(startLine) ||
    /^GNUTELLA\/0\.4 200/i.test(startLine)
  ) {
    throw new Error(
      `unsupported 0.4 handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const match = /^GNUTELLA\/0\.([0-9]+)\s+(\d+)/i.exec(startLine);
  if (!match) {
    throw new Error(
      `unexpected handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const code = Number(match[2]);
  if (code !== 200) {
    throw new Error(
      `0.6 handshake rejected by ${target}: ${describeHandshakeResponse(startLine, headers)}`,
    );
  }

  const finalHeadersWithRemote = node.buildClientFinalHeaders(
    headers,
    socket.remoteAddress,
  );
  const compressIn =
    hasToken(headers["content-encoding"], "deflate") && compressionEnabled;
  const compressOut =
    hasToken(finalHeadersWithRemote["content-encoding"], "deflate") &&
    compressionEnabled;
  const caps = node.buildCapabilities(
    `0.${match[1]}`,
    mergeHeaders(headers, finalHeadersWithRemote),
    compressIn,
    compressOut,
  );
  return {
    caps,
    role: node.classifyPeerRole(caps),
    rest: buf.subarray(cut),
    finalHeadersWithRemote,
  };
}

export function finishInbound06Probe(
  node: GnutellaServent,
  ctx: ProbeCtx,
): void {
  const raw = ctx.buf.toString("latin1");
  const cut = findHeaderEnd(raw);
  if (cut === -1) return;
  const { startLine, headers } = parseHandshakeBlock(raw.slice(0, cut));
  node.absorbHandshakeHeaders(headers, ctx.socket.remoteAddress);
  emitHandshakeBlock(
    node,
    "inbound",
    "final-recv",
    handshakePeerLabel(ctx.socket),
    startLine,
    headers,
  );
  if (finalHandshakeCode(startLine) !== 200) {
    throw new Error(`client rejected connection: ${startLine}`);
  }

  const requestHeaders = ctx.requestHeaders || {};
  const serverHeaders = ctx.serverHeaders || {};
  const compressionEnabled = !!node.config().enableCompression;
  const compressIn = compressionAccepted(compressionEnabled, headers);
  const compressOut = compressionAccepted(
    compressionEnabled,
    serverHeaders,
  );
  const caps = node.buildCapabilities(
    "0.6",
    mergeHeaders(requestHeaders, headers),
    compressIn,
    compressOut,
  );
  const role = node.classifyPeerRole(caps);
  const rest = ctx.buf.subarray(cut);
  ctx.mode = "done";
  clearProbeListeners(ctx);
  const remoteLabel = handshakePeerLabel(ctx.socket);
  attachInbound06Peer(
    node,
    ctx.socket,
    remoteLabel,
    role,
    caps,
    rest,
    serverHeaders,
    headers,
  );
}

export function tryDecideProbe(
  node: GnutellaServent,
  ctx: ProbeCtx,
): void {
  if (ctx.mode === "undecided") {
    node.handleUndecidedProbe(ctx);
    return;
  }
  if (ctx.mode === "await-final-0.6") node.finishInbound06Probe(ctx);
}

export async function connectPeer06(
  node: GnutellaServent,
  host: string,
  port: number,
  timeoutMs = node.config().connectTimeoutMs,
): Promise<void> {
  const c = node.config();
  const target = normalizePeer(host, port);
  emitHandshakeDebug(
    node,
    "outbound",
    "dial-start",
    target,
    `timeoutMs=${timeoutMs}`,
  );
  await new Promise<void>((resolve, reject) => {
    const socket = node.createConnection({ host, port });
    socket.setNoDelay(true);
    let decided = false;
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      socket.off("error", fail);
      socket.off("close", onClose);
      socket.off("connect", onConnect);
      socket.off("data", onData);
    };

    const fail = (error: unknown) => {
      if (decided) return;
      decided = true;
      cleanup();
      emitHandshakeDebug(
        node,
        "outbound",
        "failed",
        target,
        errMsg(error),
      );
      socket.destroy();
      reject(error instanceof Error ? error : new Error(errMsg(error)));
    };
    socket.setTimeout(timeoutMs, () => fail(new Error("connect timeout")));

    const onConnect = () => {
      const headers = node.baseHandshakeHeaders(socket.remoteAddress);
      if (node.tlsEnabled() && node.canUpgradeSocketToTls(socket))
        headers.upgrade = node.tlsUpgradeToken();
      socket.write(buildHandshakeBlock("GNUTELLA CONNECT/0.6", headers));
      emitHandshakeBlock(
        node,
        "outbound",
        "connect-sent",
        target,
        "GNUTELLA CONNECT/0.6",
        headers,
      );
    };
    const onClose = () =>
      fail(new Error("socket closed during handshake"));
    const onData = (chunk: string | Buffer) => {
      if (decided) return;
      buf = Buffer.concat([buf, toBuffer(chunk)]);
      let result: OutboundHandshakeResult | undefined;
      try {
        result = parseOutboundHandshakeResult(
          node,
          target,
          socket,
          buf,
          !!c.enableCompression,
        );
      } catch (error) {
        fail(error);
        return;
      }
      if (!result) return;

      const { caps, role, rest, finalHeadersWithRemote } = result;
      const acceptance = node.canAcceptPeerRole(role);
      if (!acceptance.ok) {
        socket.write(
          buildHandshakeBlock(
            `GNUTELLA/0.6 ${acceptance.code} ${acceptance.reason}`,
            {},
          ),
        );
        fail(
          new Error(
            `0.6 handshake rejected by ${target}: ${acceptance.reason}`,
          ),
        );
        return;
      }
      socket.write(
        buildHandshakeBlock("GNUTELLA/0.6 200 OK", finalHeadersWithRemote),
      );
      emitHandshakeBlock(
        node,
        "outbound",
        "final-sent",
        target,
        "GNUTELLA/0.6 200 OK",
        finalHeadersWithRemote,
      );
      decided = true;
      socket.setTimeout(0);
      cleanup();
      const upgradeToTls = shouldUpgradeSocketToTls(
        node,
        socket,
        node.peerAcceptedTlsUpgrade(caps.headers),
        true,
      );
      if (!upgradeToTls) {
        node.attachPeer(socket, true, target, role, caps, rest, target);
        resolve();
        return;
      }
      emitHandshakeDebug(
        node,
        "outbound",
        "tls-upgrade-start",
        target,
        "upgrading socket to TLS",
      );
      void node
        .upgradeSocketToTls(socket, "client", rest)
        .then((tlsSocket) => {
          emitHandshakeDebug(
            node,
            "outbound",
            "tls-upgrade-ok",
            target,
            "TLS active",
          );
          node.attachPeer(
            tlsSocket,
            true,
            target,
            role,
            caps,
            Buffer.alloc(0),
            target,
          );
          resolve();
        })
        .catch((error) => {
          emitHandshakeDebug(
            node,
            "outbound",
            "tls-upgrade-failed",
            target,
            errMsg(error),
          );
          socket.destroy();
          reject(
            error instanceof Error ? error : new Error(errMsg(error)),
          );
        });
    };
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.on("connect", onConnect);
    socket.on("data", onData);
  });
}
