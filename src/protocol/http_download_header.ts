import type { HttpDownloadRange } from "../transfers/types";
import { parseHttpHeaders } from "./handshake";

type HttpDownloadHeader = {
  remaining: number;
  finalStart: number;
  range?: HttpDownloadRange;
  connectionClose?: true;
};

function byteCount(value: string, label: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new Error(`invalid ${label}`);
  }
  return number;
}

function parseRange(
  value: string,
  requestedStart: number,
): HttpDownloadRange {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value);
  if (!match) throw new Error("invalid Content-Range");
  const start = byteCount(match[1], "range start");
  const end = byteCount(match[2], "range end");
  const total =
    match[3] === "*" ? undefined : byteCount(match[3], "range total");
  if (
    start !== requestedStart ||
    end < start ||
    end === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("unexpected Content-Range offsets");
  }
  if (total !== undefined && end >= total) {
    throw new Error("invalid Content-Range total");
  }
  return { start, end, ...(total !== undefined ? { total } : {}) };
}

function responseStatus(head: string): {
  version: string;
  status: number;
} {
  const match = /^HTTP\/(\d+\.\d+)\s+(\d+)/i.exec(head);
  if (!match) throw new Error("invalid HTTP response");
  const status = Number(match[2]);
  if (status !== 200 && status !== 206) {
    throw new Error(`unexpected HTTP status ${status}`);
  }
  return { version: match[1], status };
}

function contentLength(headers: Record<string, string>): number {
  if (headers["transfer-encoding"]) {
    throw new Error("unsupported Transfer-Encoding");
  }
  if (headers["content-length"] === undefined) {
    throw new Error("missing Content-length");
  }
  return byteCount(headers["content-length"], "Content-Length");
}

function closesConnection(version: string, connection = ""): boolean {
  const tokens = connection.toLowerCase().split(/\s*,\s*/);
  return (
    tokens.includes("close") ||
    (version === "1.0" && !tokens.includes("keep-alive"))
  );
}

export function parseHttpDownloadHeader(
  head: string,
  requestedStart: number,
): HttpDownloadHeader {
  const { version, status } = responseStatus(head);
  const headers = parseHttpHeaders(head);
  const remaining = contentLength(headers);
  const connectionClose = closesConnection(version, headers.connection);
  const range =
    status === 206
      ? parseRange(headers["content-range"] || "", requestedStart)
      : undefined;
  if (range && remaining !== range.end - range.start + 1) {
    throw new Error("Content-Length does not match Content-Range");
  }
  return {
    remaining,
    finalStart: range?.start ?? 0,
    ...(range ? { range } : {}),
    ...(connectionClose ? { connectionClose: true } : {}),
  };
}
