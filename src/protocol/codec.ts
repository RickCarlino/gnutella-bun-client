import { HEADER_LEN } from "../const";
import { bytesToIpBE, ipToBytesBE } from "../shared";
import type {
  QueryDescriptor,
  QueryHitDescriptor,
  ShareFile,
} from "../types";
import type {
  DescriptorHeader,
  QueryEncodeOptions,
  QueryHitEncodeOptions,
  QueryHitResult,
} from "./node_types";
import { DEFAULT_VENDOR_CODE } from "../const";
import { parseHttpHeaders } from "./handshake";
import { parseGgep, encodeGgep, type GgepItem } from "./ggep";
import {
  bitprintUrnFromGgepHash,
  firstSha1Urn,
  normalizeUrnList,
  sha1BufferFromUrn,
  textUrnFromGgepUrn,
} from "./content_urn";
import { splitQuerySearch } from "./query_search";
import { sha1ToUrn } from "./qrp";

const MODERN_QUERY_FLAG_BITS = [
  ["requesterFirewalled", 14],
  ["wantsXml", 13],
  ["leafGuidedDynamic", 12],
  ["ggepHAllowed", 11],
  ["outOfBand", 10],
] as const;

function normalizedModernQueryMaxHits(
  maxHits: number | undefined,
): number {
  return Math.max(0, Math.min(0x1ff, maxHits ?? 0));
}

function buildModernQueryFlags(options?: QueryEncodeOptions): number {
  let flags = 0x8000;
  for (const [key, bit] of MODERN_QUERY_FLAG_BITS) {
    if (options?.[key]) flags |= 1 << bit;
  }
  flags |= normalizedModernQueryMaxHits(options?.maxHits);
  return flags >>> 0;
}

function splitFsBlocks(buf: Buffer): Buffer[] {
  if (!buf.length) return [];
  const blocks: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x1c) {
      blocks.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  blocks.push(buf.subarray(start));
  return blocks.filter((x) => x.length > 0);
}

function splitTextAndGgepExtensions(rawExtensions: Buffer): {
  textBlocks: Buffer[];
  ggepItems: GgepItem[];
} {
  const ggepStart = rawExtensions.indexOf(0xc3);
  if (ggepStart === -1) {
    return {
      textBlocks: splitFsBlocks(rawExtensions),
      ggepItems: [],
    };
  }
  let ggepItems: GgepItem[] = [];
  try {
    ggepItems = parseGgep(rawExtensions.subarray(ggepStart));
  } catch {
    ggepItems = [];
  }
  return {
    textBlocks: splitFsBlocks(rawExtensions.subarray(0, ggepStart)),
    ggepItems,
  };
}

function urnsFromGgepHash(data: Buffer): string[] {
  const hashType = data[0];
  if (hashType === 0x01 && data.length >= 21) {
    return [sha1ToUrn(data.subarray(1, 21))];
  }
  if (hashType === 0x02 && data.length >= 21) {
    const bitprint = bitprintUrnFromGgepHash(data);
    if (bitprint) return normalizeUrnList([bitprint]);
    return [sha1ToUrn(data.subarray(1, 21))];
  }
  return [];
}

function urnsFromGgepItems(items: GgepItem[]): string[] {
  const rawUrns: string[] = [];
  for (const item of items) {
    if (item.id === "H") {
      rawUrns.push(...urnsFromGgepHash(item.data));
      continue;
    }
    if (item.id === "u") {
      const textUrn = textUrnFromGgepUrn(item.data);
      if (textUrn) rawUrns.push(textUrn);
    }
  }
  return normalizeUrnList(rawUrns);
}

function parseQueryExtensions(rawExtensions: Buffer): {
  urns: string[];
  xmlBlocks: string[];
} {
  const rawUrns: string[] = [];
  const xmlBlocks: string[] = [];
  const { textBlocks, ggepItems } =
    splitTextAndGgepExtensions(rawExtensions);
  for (const block of textBlocks) {
    if (!block.length) continue;
    const text = block.toString("utf8");
    if (text.startsWith("urn:")) rawUrns.push(text);
    else if (text.startsWith("<") || text.startsWith("{"))
      xmlBlocks.push(text);
  }
  return {
    urns: normalizeUrnList([...rawUrns, ...urnsFromGgepItems(ggepItems)]),
    xmlBlocks,
  };
}

function qhdFlagEnabled(
  enabler: number,
  setter: number,
  bit: number,
): boolean {
  if (bit === 0) return !!(setter & 1) && !!(enabler & 1);
  return !!(enabler & (1 << bit)) && !!(setter & (1 << bit));
}

function qhdFlagMeaningful(
  enabler: number,
  setter: number,
  bit: number,
): boolean {
  if (bit === 0) return !!(setter & 1);
  return !!(enabler & (1 << bit));
}

function buildQhdBlock(options: {
  vendorCode?: string;
  push: boolean;
  busy?: boolean;
  haveUploaded?: boolean;
  measuredSpeed?: boolean;
  ggep?: boolean;
  privateArea?: Buffer;
}): Buffer {
  const vendor = Buffer.alloc(4, 0);
  Buffer.from(
    (options.vendorCode || DEFAULT_VENDOR_CODE).slice(0, 4).padEnd(4, " "),
    "ascii",
  ).copy(vendor);
  const openData = Buffer.alloc(2, 0);
  if (options.ggep) {
    openData[0] |= 1 << 5;
    openData[1] |= 1 << 5;
  }
  openData[0] |= 1 << 2;
  if (options.busy) openData[1] |= 1 << 2;
  openData[0] |= 1 << 3;
  if (options.haveUploaded) openData[1] |= 1 << 3;
  openData[0] |= 1 << 4;
  if (options.measuredSpeed) openData[1] |= 1 << 4;
  openData[1] |= 1;
  if (options.push) openData[0] |= 1;
  const privateArea = options.privateArea || Buffer.alloc(0);
  return Buffer.concat([
    vendor,
    Buffer.from([openData.length]),
    openData,
    privateArea,
  ]);
}

function parseQueryHitQhd(
  privateBlock: Buffer,
): Partial<QueryHitDescriptor> {
  if (privateBlock.length < 5) return {};
  const vendorCode = privateBlock.subarray(0, 4).toString("ascii");
  const openDataSize = privateBlock[4];
  if (5 + openDataSize > privateBlock.length) return { vendorCode };
  const openData = privateBlock.subarray(5, 5 + openDataSize);
  const privateArea = privateBlock.subarray(5 + openDataSize);
  const enabler = openData[0] || 0;
  const setter = openData[1] || 0;
  return {
    vendorCode,
    openDataSize,
    flagGgep: readQhdFlag(enabler, setter, 5),
    flagUploadSpeedMeasured: readQhdFlag(enabler, setter, 4),
    flagHaveUploaded: readQhdFlag(enabler, setter, 3),
    flagBusy: readQhdFlag(enabler, setter, 2),
    flagPush: readQhdFlag(enabler, setter, 0),
    qhdPrivateArea: privateArea,
  };
}

function readQhdFlag(
  enabler: number,
  setter: number,
  bit: number,
): boolean | undefined {
  return qhdFlagMeaningful(enabler, setter, bit)
    ? qhdFlagEnabled(enabler, setter, bit)
    : undefined;
}

function parseQueryHitExtension(rawExtension: Buffer): {
  urns: string[];
  metadata: string[];
} {
  const rawUrns: string[] = [];
  const metadata: string[] = [];
  const { textBlocks, ggepItems } =
    splitTextAndGgepExtensions(rawExtension);
  for (const block of textBlocks) {
    const text = block.toString("utf8");
    if (text.startsWith("urn:")) rawUrns.push(text);
    else if (text) metadata.push(text);
  }
  return {
    urns: normalizeUrnList([...rawUrns, ...urnsFromGgepItems(ggepItems)]),
    metadata,
  };
}

function ggepSha1Item(sha1: Buffer | undefined): GgepItem | undefined {
  return sha1
    ? {
        id: "H",
        data: Buffer.concat([Buffer.from([0x01]), sha1]),
      }
    : undefined;
}

function ggepHashItemsFromUrns(
  urns: string[],
  enabled: boolean,
): GgepItem[] {
  if (!enabled) return [];
  const sha1 = sha1BufferFromUrn(firstSha1Urn(urns) || "");
  const item = ggepSha1Item(sha1);
  return item ? [item] : [];
}

function ggepHashItemsForShare(
  share: ShareFile,
  textUrns: string[],
  enabled: boolean,
): GgepItem[] {
  if (!enabled) return [];
  const sha1 =
    share.sha1 || sha1BufferFromUrn(firstSha1Urn(textUrns) || "");
  const item = ggepSha1Item(sha1);
  return item ? [item] : [];
}

function ggepBrowseHostItem(enabled: boolean): GgepItem[] {
  return enabled ? [{ id: "BH", data: Buffer.alloc(0) }] : [];
}

function buildExtensionPayload(
  textParts: Buffer[],
  ggepItems: GgepItem[],
): Buffer {
  const ggep = ggepItems.length ? encodeGgep(ggepItems) : Buffer.alloc(0);
  const blocks = [...textParts, ...(ggep.length ? [ggep] : [])];
  if (!blocks.length) return Buffer.alloc(0);
  return Buffer.concat(
    blocks.flatMap((block, index) =>
      index === 0 ? [block] : [Buffer.from([0x1c]), block],
    ),
  );
}

function queryHitFieldEnd(
  payload: Buffer,
  start: number,
  endLimit: number,
  label: string,
): number {
  const end = payload.indexOf(0x00, start);
  if (end === -1 || end > endLimit)
    throw new Error(`truncated query hit ${label}`);
  return end;
}

function parseQueryHitResultAt(
  payload: Buffer,
  offset: number,
): {
  result: QueryHitResult;
  nextOffset: number;
} {
  const tailStart = payload.length - 16;
  if (offset + 8 > tailStart)
    throw new Error("truncated query hit result header");
  const fileIndex = payload.readUInt32LE(offset);
  const fileSize = payload.readUInt32LE(offset + 4);
  const nameEnd = queryHitFieldEnd(
    payload,
    offset + 8,
    tailStart,
    "file name",
  );
  const fileName = payload.subarray(offset + 8, nameEnd).toString("utf8");
  const extStart = nameEnd + 1;
  const extEnd = queryHitFieldEnd(
    payload,
    extStart,
    tailStart,
    "extension block",
  );
  const rawExtension = payload.subarray(extStart, extEnd);
  return {
    result: {
      fileIndex,
      fileSize,
      fileName,
      ...parseQueryHitExtension(rawExtension),
      rawExtension,
    },
    nextOffset: extEnd + 1,
  };
}

function parseByteRangeSuffix(
  endRaw: string,
  size: number,
  last: number,
): { start: number; end: number; partial: boolean } | null {
  const suffixLen = Number(endRaw);
  if (!Number.isInteger(suffixLen) || suffixLen <= 0) return null;
  const length = Math.min(suffixLen, size);
  return { start: size - length, end: last, partial: length < size };
}

function explicitByteRangeEnd(
  endRaw: string,
  start: number,
  size: number,
  last: number,
): number | undefined {
  const end = endRaw ? Number(endRaw) : last;
  if (!Number.isInteger(end) || end < start) return undefined;
  if (size === 0) return -1;
  return Math.min(end, last);
}

function parseByteRangeExplicit(
  startRaw: string,
  endRaw: string,
  size: number,
  last: number,
): { start: number; end: number; partial: boolean } | null {
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return null;
  if (size > 0 && start > last) return null;
  const end = explicitByteRangeEnd(endRaw, start, size, last);
  if (end == null) return null;
  return { start, end, partial: size > 0 && (start > 0 || end < last) };
}

export function parseByteRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number; partial: boolean } | null {
  const last = size > 0 ? size - 1 : -1;
  if (!rangeHeader) return { start: 0, end: last, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (!startRaw && !endRaw) return null;
  if (!startRaw) return parseByteRangeSuffix(endRaw, size, last);
  return parseByteRangeExplicit(startRaw, endRaw, size, last);
}

export function buildHeader(
  descriptorId: Buffer,
  payloadType: number,
  ttl: number,
  hops: number,
  payload: Buffer,
): Buffer {
  const h = Buffer.alloc(HEADER_LEN);
  descriptorId.copy(h, 0, 0, 16);
  h[16] = payloadType & 0xff;
  h[17] = ttl & 0xff;
  h[18] = hops & 0xff;
  h.writeUInt32LE(payload.length >>> 0, 19);
  return Buffer.concat([h, payload]);
}

export function parseHeader(buf: Buffer): DescriptorHeader {
  return {
    descriptorId: buf.subarray(0, 16),
    descriptorIdHex: buf.subarray(0, 16).toString("hex"),
    payloadType: buf[16],
    ttl: buf[17],
    hops: buf[18],
    payloadLength: buf.readUInt32LE(19),
  };
}

export function encodePong(
  port: number,
  ip: string,
  files: number,
  kbytes: number,
  ggep?: Buffer,
): Buffer {
  const b = Buffer.alloc(14 + (ggep?.length || 0));
  b.writeUInt16LE(port & 0xffff, 0);
  ipToBytesBE(ip).copy(b, 2);
  b.writeUInt32LE(files >>> 0, 6);
  b.writeUInt32LE(kbytes >>> 0, 10);
  if (ggep?.length) ggep.copy(b, 14);
  return b;
}

export function parsePong(payload: Buffer) {
  if (payload.length < 14)
    throw new Error(`invalid pong length ${payload.length}`);
  return {
    port: payload.readUInt16LE(0),
    ip: bytesToIpBE(payload.subarray(2, 6)),
    files: payload.readUInt32LE(6),
    kbytes: payload.readUInt32LE(10),
    ggep: payload.subarray(14),
  };
}

export function encodeQuery(
  search: string,
  options: QueryEncodeOptions = {},
): Buffer {
  const s = Buffer.from(search, "utf8");
  const urns = normalizeUrnList(options.urns || []);
  const ext = buildExtensionPayload(
    [
      ...urns.map((urn) => Buffer.from(urn, "utf8")),
      ...(options.xmlBlocks || []).map((xml) => Buffer.from(xml, "utf8")),
    ],
    ggepHashItemsFromUrns(urns, !!options.ggepHAllowed),
  );
  const out = Buffer.alloc(2 + s.length + 1 + ext.length);
  out.writeUInt16BE(buildModernQueryFlags(options), 0);
  s.copy(out, 2);
  out[2 + s.length] = 0;
  if (ext.length) ext.copy(out, 3 + s.length);
  return out;
}

export function parseQuery(payload: Buffer): QueryDescriptor {
  if (payload.length < 3)
    throw new Error(`invalid query length ${payload.length}`);
  const flagsRaw = payload.readUInt16BE(0);
  const nul = payload.indexOf(0x00, 2);
  const end = nul === -1 ? payload.length : nul;
  const rawSearch = payload.subarray(2, end).toString("utf8");
  const rawExtensions =
    nul === -1 ? Buffer.alloc(0) : payload.subarray(end + 1);
  const { search, urns: inlineUrns } = splitQuerySearch(rawSearch);
  const { urns: extensionUrns, xmlBlocks } =
    parseQueryExtensions(rawExtensions);
  const urns = normalizeUrnList([...inlineUrns, ...extensionUrns]);
  const normalizedSearch =
    urns.length > 0 && search === "\\" ? "" : search;
  return {
    search: normalizedSearch,
    flagsRaw,
    requesterFirewalled: !!(flagsRaw & (1 << 14)),
    wantsXml: !!(flagsRaw & (1 << 13)),
    leafGuidedDynamic: !!(flagsRaw & (1 << 12)),
    ggepHAllowed: !!(flagsRaw & (1 << 11)),
    outOfBand: !!(flagsRaw & (1 << 10)),
    maxHits: flagsRaw & 0x1ff,
    urns,
    xmlBlocks,
    rawExtensions,
  };
}

export function encodeQueryHit(
  port: number,
  ip: string,
  speedKBps: number,
  results: ShareFile[],
  serventId: Buffer,
  options: QueryHitEncodeOptions = {},
): Buffer {
  const parts: Buffer[] = [];
  const trailerGgepItems = ggepBrowseHostItem(!!options.browseHost);
  let ggepUsed = trailerGgepItems.length > 0;
  parts.push(Buffer.from([results.length & 0xff]));
  const head = Buffer.alloc(10);
  head.writeUInt16LE(port & 0xffff, 0);
  ipToBytesBE(ip).copy(head, 2);
  head.writeUInt32LE(speedKBps >>> 0, 6);
  parts.push(head);
  for (const r of results) {
    const name = Buffer.from(r.name, "utf8");
    const item = Buffer.alloc(8);
    item.writeUInt32LE(r.index >>> 0, 0);
    item.writeUInt32LE(r.size >>> 0, 4);
    const textUrns = normalizeUrnList(r.sha1Urn ? [r.sha1Urn] : []);
    const ggepItems = ggepHashItemsForShare(
      r,
      textUrns,
      !!options.ggepHashes,
    );
    if (ggepItems.length) ggepUsed = true;
    const ext = buildExtensionPayload(
      textUrns.map((urn) => Buffer.from(urn, "utf8")),
      ggepItems,
    );
    parts.push(item, name, Buffer.from([0x00]), ext, Buffer.from([0x00]));
  }
  const trailerPrivateArea = trailerGgepItems.length
    ? encodeGgep(trailerGgepItems)
    : Buffer.alloc(0);
  parts.push(
    buildQhdBlock({
      vendorCode: options.vendorCode,
      push: !!options.push,
      busy: options.busy,
      haveUploaded: options.haveUploaded,
      measuredSpeed: options.measuredSpeed,
      ggep: ggepUsed,
      privateArea: trailerPrivateArea,
    }),
  );
  parts.push(serventId);
  return Buffer.concat(parts);
}

export function parseQueryHit(payload: Buffer): QueryHitDescriptor {
  if (payload.length < 27)
    throw new Error(`invalid query hit length ${payload.length}`);
  const hits = payload[0];
  const port = payload.readUInt16LE(1);
  const ip = bytesToIpBE(payload.subarray(3, 7));
  const speedKBps = payload.readUInt32LE(7);
  let off = 11;
  const results: QueryHitDescriptor["results"] = [];
  for (let i = 0; i < hits; i++) {
    const parsed = parseQueryHitResultAt(payload, off);
    off = parsed.nextOffset;
    results.push(parsed.result);
  }
  const serventId = payload.subarray(payload.length - 16);
  const qhdBlock = payload.subarray(off, payload.length - 16);
  return {
    hits,
    port,
    ip,
    speedKBps,
    results,
    ...parseQueryHitQhd(qhdBlock),
    serventId,
    serventIdHex: serventId.toString("hex"),
  };
}

export function encodePush(
  serventId: Buffer,
  fileIndex: number,
  ip: string,
  port: number,
): Buffer {
  const b = Buffer.alloc(26);
  serventId.copy(b, 0, 0, 16);
  b.writeUInt32LE(fileIndex >>> 0, 16);
  ipToBytesBE(ip).copy(b, 20);
  b.writeUInt16LE(port & 0xffff, 24);
  return b;
}

export function parsePush(payload: Buffer) {
  if (payload.length < 26)
    throw new Error(`invalid push length ${payload.length}`);
  return {
    serventId: payload.subarray(0, 16),
    serventIdHex: payload.subarray(0, 16).toString("hex"),
    fileIndex: payload.readUInt32LE(16),
    ip: bytesToIpBE(payload.subarray(20, 24)),
    port: payload.readUInt16LE(24),
    ggep: payload.subarray(26),
  };
}

export function encodeBye(code: number, message: string): Buffer {
  const msg = Buffer.from(message, "utf8");
  const payload = Buffer.alloc(2 + msg.length + 1);
  payload.writeUInt16LE(code & 0xffff, 0);
  msg.copy(payload, 2);
  return payload;
}

export function parseBye(payload: Buffer): {
  code: number;
  message: string;
} {
  if (payload.length < 2)
    throw new Error(`invalid bye length ${payload.length}`);
  const nul = payload.indexOf(0x00, 2);
  const end = nul === -1 ? payload.length : nul;
  return {
    code: payload.readUInt16LE(0),
    message: payload.subarray(2, end).toString("utf8"),
  };
}

export function parseRouteTableUpdate(payload: Buffer):
  | { variant: "reset"; tableLength: number; infinity: number }
  | {
      variant: "patch";
      seqNo: number;
      seqSize: number;
      compressor: number;
      entryBits: number;
      data: Buffer;
    } {
  if (payload.length < 1)
    throw new Error("invalid route table update length");
  if (payload[0] === 0x00) {
    if (payload.length < 6) throw new Error("invalid qrp reset length");
    return {
      variant: "reset",
      tableLength: payload.readUInt32LE(1),
      infinity: payload[5],
    };
  }
  if (payload[0] === 0x01) {
    if (payload.length < 6) throw new Error("invalid qrp patch length");
    return {
      variant: "patch",
      seqNo: payload[1],
      seqSize: payload[2],
      compressor: payload[3],
      entryBits: payload[4],
      data: payload.subarray(5),
    };
  }
  throw new Error(`unsupported qrp variant ${payload[0]}`);
}

export function buildGetRequest(
  fileIndex: number,
  fileName: string,
  start: number,
  host?: string,
  port?: number,
): string {
  const rawName = encodeURI(fileName).replace(/#/g, "%23");
  const hostHeader = host && port ? `Host: ${host}:${port}\r\n` : "";
  return `GET /get/${fileIndex}/${rawName} HTTP/1.1\r\nUser-Agent: Gnutella\r\n${hostHeader}Connection: Keep-Alive\r\nRange: bytes=${start}-\r\n\r\n`;
}

export function buildUriResRequest(
  urn: string,
  start: number,
  host?: string,
  port?: number,
): string {
  const hostHeader = host && port ? `Host: ${host}:${port}\r\n` : "";
  return `GET /uri-res/N2R?${urn} HTTP/1.1\r\nUser-Agent: Gnutella\r\n${hostHeader}Connection: Keep-Alive\r\nRange: bytes=${start}-\r\n\r\n`;
}

export function parseHttpDownloadHeader(
  head: string,
  requestedStart: number,
): { remaining: number; finalStart: number } {
  const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
  const match = /^HTTP\/(\d+\.\d+)\s+(\d+)/i.exec(first);
  if (!match) throw new Error("invalid HTTP response");
  const status = Number(match[2]);
  const headers = parseHttpHeaders(head);
  const remaining = Number(headers["content-length"] || NaN);
  if (!Number.isFinite(remaining) || remaining < 0)
    throw new Error("missing Content-length");
  if (status === 206) {
    const rangeMatch = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
      headers["content-range"] || "",
    );
    return {
      remaining,
      finalStart: rangeMatch ? Number(rangeMatch[1]) : requestedStart,
    };
  }
  if (status === 200) return { remaining, finalStart: 0 };
  throw new Error(`unexpected HTTP status ${status}`);
}
