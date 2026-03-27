import net from "node:net";

import {
  CANONICAL_HEADER_NAMES,
  INTERESTING_HANDSHAKE_HEADERS,
} from "../const";
import {
  ipv4Subnet16,
  isRoutableIpv4,
  normalizeIpv4,
  parsePeer,
} from "../shared";
import type { PeerAddr } from "../types";

export function hasToken(
  value: string | undefined,
  token: string,
): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(token.toLowerCase());
}

export function parseBoolHeader(
  v: string | undefined,
): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

export function parsePeerHeaderList(v: string | undefined): PeerAddr[] {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => parsePeer(x.trim()))
    .filter((x): x is PeerAddr => !!x);
}

export function parseListenIpHeader(
  v: string | undefined,
): PeerAddr | undefined {
  if (!v) return undefined;
  return parsePeer(v.trim()) || undefined;
}

function parseRemoteIpHeader(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return normalizeIpv4(v.split(",")[0]?.trim());
}

export function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

export function mergeHeaders(
  ...parts: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) out[k.toLowerCase()] = v;
  }
  return out;
}

export function findHeaderEnd(raw: string): number {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return crlf + 4;
  if (lf !== -1) return lf + 2;
  return -1;
}

function appendContinuationLine(
  headers: Record<string, string>,
  current: string,
  line: string,
): boolean {
  if (!/^[ \t]/.test(line) || !current) return false;
  headers[current] = `${headers[current]} ${line.trim()}`.trim();
  return true;
}

function recordHeaderLine(
  headers: Record<string, string>,
  line: string,
): string {
  const idx = line.indexOf(":");
  if (idx === -1) return "";
  const key = line.slice(0, idx).trim().toLowerCase();
  const value = line.slice(idx + 1).trim();
  headers[key] = headers[key] ? `${headers[key]},${value}` : value;
  return key;
}

export function parseHandshakeBlock(raw: string): {
  startLine: string;
  headers: Record<string, string>;
} {
  const end = findHeaderEnd(raw);
  const text = end === -1 ? raw : raw.slice(0, end);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const startLine = lines.shift()?.trim() || "";
  const headers: Record<string, string> = {};
  let current = "";

  for (const line of lines) {
    if (!line) continue;
    if (appendContinuationLine(headers, current, line)) continue;
    current = recordHeaderLine(headers, line);
  }
  return { startLine, headers };
}

function canonicalHeaderName(key: string): string {
  return CANONICAL_HEADER_NAMES[key.toLowerCase()] || key;
}

export function buildHandshakeBlock(
  startLine: string,
  headers: Record<string, string>,
): Buffer {
  const lines = [startLine];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${canonicalHeaderName(k)}: ${v}`);
  }
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"), "latin1");
}

function summarizeHandshakeHeaders(
  headers: Record<string, string>,
): string {
  const parts = INTERESTING_HANDSHAKE_HEADERS.filter(
    (key) => !!headers[key],
  ).map((key) => `${canonicalHeaderName(key)}=${headers[key]}`);
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

export function describeHandshakeResponse(
  startLine: string,
  headers: Record<string, string>,
): string {
  return `${startLine}${summarizeHandshakeHeaders(headers)}`;
}

export function observedAdvertisedHostCandidate(
  headers: Record<string, string>,
  reporterHost?: string,
): { observedHost: string; subnet: string } | undefined {
  const observedHost = parseRemoteIpHeader(
    headers["remote-ip"] || headers["x-remote-ip"],
  );
  const reporter = normalizeIpv4(reporterHost);
  if (!observedHost || !reporter) return undefined;
  if (!isRoutableIpv4(observedHost) || !isRoutableIpv4(reporter))
    return undefined;
  const subnet = ipv4Subnet16(reporter);
  if (!subnet) return undefined;
  return { observedHost, subnet };
}

export function socketCanEnd(socket: net.Socket): boolean {
  return (
    !socket.destroyed &&
    !(socket as net.Socket & { writableEnded?: boolean }).writableEnded &&
    !(socket as net.Socket & { ended?: boolean }).ended
  );
}

export function parseHttpHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line
      .slice(idx + 1)
      .trim();
  }
  return out;
}
