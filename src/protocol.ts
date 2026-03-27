import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

import {
  BASE32_ALPHABET,
  BOOTSTRAP_CONNECT_CONCURRENCY,
  BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR,
  BYE_DEFAULT_CODE,
  CANONICAL_HEADER_NAMES,
  DEFAULT_USER_AGENT,
  DEFAULT_QRP_ENTRY_BITS,
  DEFAULT_QRP_INFINITY,
  DEFAULT_QRP_TABLE_SIZE,
  DEFAULT_VENDOR_CODE,
  HEADER_LEN,
  INTERESTING_HANDSHAKE_HEADERS,
  LOCAL_ROUTE,
  MAX_XTRY,
  QRP_COMPRESSOR_DEFLATE,
  QRP_COMPRESSOR_NONE,
  QRP_HASH_MULTIPLIER,
  TYPE,
  TYPE_NAME,
} from "./const";
import {
  bytesToIpBE,
  ensureDir,
  errMsg,
  fileExists,
  ipToBytesBE,
  normalizePeer,
  parsePeer,
  safeFileName,
  sleep,
  toBuffer,
  ts,
  unique,
  walkFiles,
} from "./shared";
import type {
  ConfigDoc,
  ConnectPeerResult,
  DownloadRecord,
  GnutellaEvent,
  GnutellaEventListener,
  GnutellaServentOptions,
  NodeStatus,
  PeerAddr,
  PeerCapabilities,
  PeerInfo,
  PendingPush,
  QueryDescriptor,
  QueryHitDescriptor,
  RemoteQrpState,
  Route,
  SearchHit,
  ShareFile,
} from "./types";

type ProbeCtx = {
  socket: net.Socket;
  buf: Buffer;
  mode: "undecided" | "await-final-0.6" | "done";
  requestHeaders?: Record<string, string>;
  serverHeaders?: Record<string, string>;
};

type HttpSession = {
  socket: net.Socket;
  buf: Buffer;
  busy: boolean;
  closed: boolean;
};

export type Peer = {
  key: string;
  socket: net.Socket;
  buf: Buffer;
  outbound: boolean;
  dialTarget?: string;
  remoteLabel: string;
  capabilities: PeerCapabilities;
  inflater?: zlib.Inflate;
  deflater?: zlib.Deflate;
  remoteQrp: RemoteQrpState;
  lastPingAt: number;
  closingAfterBye?: boolean;
};

function randomId16(): Buffer {
  const id = crypto.randomBytes(16);
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

function seenKey(
  payloadType: number,
  descriptorIdHex: string,
  payload?: Buffer,
): string {
  const base = `${payloadType}:${descriptorIdHex}`;
  if (
    (payloadType === TYPE.PONG || payloadType === TYPE.QUERY_HIT) &&
    payload
  ) {
    const digest = crypto.createHash("sha1").update(payload).digest("hex");
    return `${base}:${digest}`;
  }
  return base;
}

function fromHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  const id = Buffer.from(clean, "hex");
  id[8] = 0xff;
  id[15] = 0x00;
  return id;
}

function rawHex16(hex: string): Buffer {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(clean))
    throw new Error(`expected 32 hex chars, got ${hex}`);
  return Buffer.from(clean, "hex");
}

function hasToken(value: string | undefined, token: string): boolean {
  if (!value) return false;
  return value
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .includes(token.toLowerCase());
}

function parseBoolHeader(v: string | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return undefined;
}

function parsePeerHeaderList(v: string | undefined): PeerAddr[] {
  if (!v) return [];
  return v
    .split(",")
    .map((x) => parsePeer(x.trim()))
    .filter((x): x is PeerAddr => !!x);
}

function parseListenIpHeader(v: string | undefined): PeerAddr | undefined {
  if (!v) return undefined;
  return parsePeer(v.trim()) || undefined;
}

function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function mergeHeaders(
  ...parts: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part)) out[k.toLowerCase()] = v;
  }
  return out;
}

function findHeaderEnd(raw: string): number {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return crlf + 4;
  if (lf !== -1) return lf + 2;
  return -1;
}

function parseHandshakeBlock(raw: string): {
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
    if (/^[ \t]/.test(line) && current) {
      headers[current] = `${headers[current]} ${line.trim()}`.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (headers[key]) headers[key] = `${headers[key]},${value}`;
    else headers[key] = value;
    current = key;
  }
  return { startLine, headers };
}

function canonicalHeaderName(key: string): string {
  return CANONICAL_HEADER_NAMES[key.toLowerCase()] || key;
}

function buildHandshakeBlock(
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

function describeHandshakeResponse(
  startLine: string,
  headers: Record<string, string>,
): string {
  return `${startLine}${summarizeHandshakeHeaders(headers)}`;
}

function splitSearchTerms(input: string): string[] {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return ascii.split(/[^a-z0-9]+/).filter(Boolean);
}

function tokenizeKeywords(input: string): string[] {
  return unique(splitSearchTerms(input).filter((x) => x.length > 1));
}

function qrpQueryTerms(input: string): string[] {
  return unique(splitSearchTerms(input).filter((x) => x.length >= 3));
}

function qrpIndexTerms(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of qrpQueryTerms(input)) {
    for (let trim = 0; trim <= 3; trim++) {
      const candidate = trim === 0 ? term : term.slice(0, -trim);
      if (candidate.length < 3 || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

function qrpHash(str: string, bits: number): number {
  const bytes = Buffer.from(str.toLowerCase(), "utf8");
  let xor = 0;
  for (let i = 0; i < bytes.length; i++) xor ^= bytes[i] << ((i & 3) * 8);
  const prod = BigInt(xor >>> 0) * BigInt(QRP_HASH_MULTIPLIER >>> 0);
  const mask = (1n << BigInt(bits)) - 1n;
  return Number((prod >> BigInt(32 - bits)) & mask) >>> 0;
}

function sha1ToBase32(sha1: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of sha1) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

function sha1ToUrn(sha1: Buffer): string {
  return `urn:sha1:${sha1ToBase32(sha1)}`;
}

async function sha1File(abs: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const rs = fs.createReadStream(abs);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(hash.digest()));
  });
}

function buildModernQueryFlags(options?: {
  requesterFirewalled?: boolean;
  wantsXml?: boolean;
  leafGuidedDynamic?: boolean;
  ggepHAllowed?: boolean;
  outOfBand?: boolean;
  maxHits?: number;
}): number {
  let flags = 0x8000;
  if (options?.requesterFirewalled) flags |= 1 << 14;
  if (options?.wantsXml) flags |= 1 << 13;
  if (options?.leafGuidedDynamic) flags |= 1 << 12;
  if (options?.ggepHAllowed) flags |= 1 << 11;
  if (options?.outOfBand) flags |= 1 << 10;
  const maxHits = Math.max(0, Math.min(0x1ff, options?.maxHits ?? 0));
  flags |= maxHits;
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

function parseQueryExtensions(rawExtensions: Buffer): {
  urns: string[];
  xmlBlocks: string[];
} {
  const urns: string[] = [];
  const xmlBlocks: string[] = [];
  for (const block of splitFsBlocks(rawExtensions)) {
    if (!block.length) continue;
    if (block[0] === 0xc3) continue;
    const text = block.toString("utf8");
    if (text.startsWith("urn:")) urns.push(text);
    else if (text.startsWith("<") || text.startsWith("{"))
      xmlBlocks.push(text);
  }
  return { urns, xmlBlocks };
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

export function initialRemoteQrpState(): RemoteQrpState {
  return {
    resetSeen: false,
    tableSize: 0,
    infinity: DEFAULT_QRP_INFINITY,
    entryBits: DEFAULT_QRP_ENTRY_BITS,
    table: null,
    seqSize: 0,
    compressor: QRP_COMPRESSOR_NONE,
    parts: new Map<number, Buffer>(),
  };
}

export class QrpTable {
  tableSize: number;
  infinity: number;
  entryBits: number;
  table: Uint8Array;

  constructor(
    tableSize = DEFAULT_QRP_TABLE_SIZE,
    infinity = DEFAULT_QRP_INFINITY,
    entryBits = DEFAULT_QRP_ENTRY_BITS,
  ) {
    this.tableSize = tableSize;
    this.infinity = infinity;
    this.entryBits = entryBits;
    this.table = new Uint8Array(tableSize);
    this.clear();
  }

  clear(): void {
    this.table.fill(this.infinity);
  }

  rebuildFromShares(shares: ShareFile[]): void {
    this.clear();
    for (const share of shares) {
      for (const kw of share.keywords) {
        for (const term of qrpIndexTerms(kw))
          this.table[this.hashKeyword(term)] = 1;
      }
    }
  }

  hashKeyword(keyword: string): number {
    return qrpHash(keyword, Math.log2(this.tableSize));
  }

  matchesQuery(search: string): boolean {
    const kws = qrpQueryTerms(search);
    if (!kws.length) return true;
    return kws.every(
      (kw) => this.table[this.hashKeyword(kw)] < this.infinity,
    );
  }

  encodeReset(): Buffer {
    const payload = Buffer.alloc(6);
    payload[0] = 0x00;
    payload.writeUInt32LE(this.tableSize, 1);
    payload[5] = this.infinity;
    return payload;
  }

  encodePatchChunks(maxChunkPayload: number): Buffer[] {
    const packed = this.packTable();
    const compressed = zlib.deflateSync(packed);
    const chunks: Buffer[] = [];
    const partSize = Math.max(256, maxChunkPayload - 5);
    const parts: Buffer[] = [];
    for (let off = 0; off < compressed.length; off += partSize)
      parts.push(compressed.subarray(off, off + partSize));
    for (let i = 0; i < parts.length; i++) {
      const payload = Buffer.alloc(5 + parts[i].length);
      payload[0] = 0x01;
      payload[1] = i + 1;
      payload[2] = parts.length;
      payload[3] = QRP_COMPRESSOR_DEFLATE;
      payload[4] = this.entryBits;
      parts[i].copy(payload, 5);
      chunks.push(payload);
    }
    return chunks;
  }

  packTable(): Buffer {
    if (this.entryBits === 1) {
      const out = Buffer.alloc(Math.ceil(this.tableSize / 8));
      for (let i = 0; i < this.tableSize; i++) {
        const byteIdx = i >> 3;
        const bit = 7 - (i & 7);
        if (this.table[i] < this.infinity) out[byteIdx] |= 1 << bit;
      }
      return out;
    }
    if (this.entryBits === 4) {
      const out = Buffer.alloc(Math.ceil(this.tableSize / 2));
      for (let i = 0; i < this.tableSize; i++) {
        const nibble = this.table[i] & 0x0f;
        const byteIdx = i >> 1;
        if ((i & 1) === 0)
          out[byteIdx] = (out[byteIdx] & 0x0f) | (nibble << 4);
        else out[byteIdx] = (out[byteIdx] & 0xf0) | nibble;
      }
      return out;
    }
    throw new Error(`unsupported QRP entry bits ${this.entryBits}`);
  }

  static applyPatch(state: RemoteQrpState): void {
    if (
      !state.resetSeen ||
      state.parts.size !== state.seqSize ||
      state.seqSize <= 0
    )
      return;
    const rawParts: Buffer[] = [];
    for (let i = 1; i <= state.seqSize; i++) {
      const part = state.parts.get(i);
      if (!part) return;
      rawParts.push(part);
    }
    let packed = Buffer.concat(rawParts);
    if (state.compressor === QRP_COMPRESSOR_DEFLATE)
      packed = zlib.inflateSync(packed);
    const table = new Uint8Array(state.tableSize);
    table.fill(state.infinity);
    if (state.entryBits === 1) {
      for (let i = 0; i < state.tableSize; i++) {
        const byteIdx = i >> 3;
        const bit = 7 - (i & 7);
        const present =
          byteIdx < packed.length && !!(packed[byteIdx] & (1 << bit));
        table[i] = present ? 1 : state.infinity;
      }
    } else if (state.entryBits === 4) {
      for (let i = 0; i < state.tableSize; i++) {
        const byteIdx = i >> 1;
        if (byteIdx >= packed.length) break;
        const nibble =
          (i & 1) === 0
            ? (packed[byteIdx] >> 4) & 0x0f
            : packed[byteIdx] & 0x0f;
        table[i] = nibble;
      }
    } else {
      return;
    }
    state.table = table;
    state.parts.clear();
    state.seqSize = 0;
  }

  static matchesRemote(state: RemoteQrpState, search: string): boolean {
    if (!state.table || !state.tableSize) return true;
    const kws = qrpQueryTerms(search);
    if (!kws.length) return true;
    const bits = Math.log2(state.tableSize);
    return kws.every(
      (kw) => state.table![qrpHash(kw, bits)] < state.infinity,
    );
  }
}

export function defaultDoc(configPath: string): ConfigDoc {
  const base = path.dirname(path.resolve(configPath));
  return {
    config: {
      listenHost: "0.0.0.0",
      listenPort: 6346,
      advertisedHost: "127.0.0.1",
      advertisedPort: 6346,
      sharedDir: path.join(base, "shared"),
      downloadsDir: path.join(base, "downloads"),
      maxConnections: 8,
      connectTimeoutMs: 5000,
      pingIntervalSec: 60,
      reconnectIntervalSec: 15,
      rescanSharesSec: 30,
      routeTtlSec: 600,
      seenTtlSec: 600,
      maxPayloadBytes: 1024 * 1024,
      maxTtl: 7,
      defaultPingTtl: 1,
      defaultQueryTtl: 3,
      advertisedSpeedKBps: 512,
      downloadTimeoutMs: 15000,
      pushWaitMs: 15000,
      maxResultsPerQuery: 50,
      peers: [],
      userAgent: DEFAULT_USER_AGENT,
      queryRoutingVersion: "0.1",
      enableCompression: true,
      enableQrp: true,
      enableBye: true,
      enablePongCaching: true,
      enableGgep: true,
      advertiseUltrapeer: false,
      serveUriRes: true,
      vendorCode: DEFAULT_VENDOR_CODE,
    },
    state: {
      serventIdHex: randomId16().toString("hex"),
    },
  };
}

export async function loadDoc(configPath: string): Promise<ConfigDoc> {
  const full = path.resolve(configPath);
  if (!(await fileExists(full))) {
    const doc = defaultDoc(full);
    await ensureDir(path.dirname(full));
    await ensureDir(doc.config.sharedDir);
    await ensureDir(doc.config.downloadsDir);
    await writeDoc(full, doc);
    return doc;
  }
  const raw = await fsp.readFile(full, "utf8");
  const parsed = JSON.parse(raw) as ConfigDoc & {
    config?: Partial<ConfigDoc["config"]> & { seedPeers?: string[] };
    state?: Partial<ConfigDoc["state"]> & { knownPeers?: string[] };
  };
  const defaults = defaultDoc(full);
  const doc: ConfigDoc = {
    config: { ...defaults.config, ...parsed.config },
    state: { ...defaults.state, ...parsed.state },
  };
  doc.config.peers = unique(
    [
      ...((parsed.config?.peers || []) as string[]),
      ...((parsed.config?.seedPeers || []) as string[]),
      ...((parsed.state?.knownPeers || []) as string[]),
    ].map((x) => String(x)),
  );
  delete (doc.config as ConfigDoc["config"] & { seedPeers?: string[] })
    .seedPeers;
  delete (
    doc.state as ConfigDoc["state"] & {
      downloads?: DownloadRecord[];
      knownPeers?: string[];
    }
  ).knownPeers;
  delete (
    doc.state as ConfigDoc["state"] & {
      downloads?: DownloadRecord[];
      knownPeers?: string[];
    }
  ).downloads;
  if (
    !doc.state.serventIdHex ||
    !/^[0-9a-f]{32}$/i.test(doc.state.serventIdHex)
  ) {
    doc.state.serventIdHex = randomId16().toString("hex");
  }
  await ensureDir(doc.config.sharedDir);
  await ensureDir(doc.config.downloadsDir);
  return doc;
}

export async function writeDoc(
  configPath: string,
  doc: ConfigDoc,
): Promise<void> {
  const full = path.resolve(configPath);
  const tmp = `${full}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, full);
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

export function parseHeader(buf: Buffer) {
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
  options: {
    requesterFirewalled?: boolean;
    wantsXml?: boolean;
    leafGuidedDynamic?: boolean;
    ggepHAllowed?: boolean;
    outOfBand?: boolean;
    maxHits?: number;
    urns?: string[];
    xmlBlocks?: string[];
  } = {},
): Buffer {
  const s = Buffer.from(search, "utf8");
  const extParts: Buffer[] = [];
  for (const urn of options.urns || [])
    extParts.push(Buffer.from(urn, "utf8"));
  for (const xml of options.xmlBlocks || [])
    extParts.push(Buffer.from(xml, "utf8"));
  const sep = extParts.length ? Buffer.from([0x1c]) : Buffer.alloc(0);
  const ext = extParts.length
    ? Buffer.concat(extParts.flatMap((p, i) => (i ? [sep, p] : [p])))
    : Buffer.alloc(0);
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
  const search = payload.subarray(2, end).toString("utf8");
  const rawExtensions =
    nul === -1 ? Buffer.alloc(0) : payload.subarray(end + 1);
  const { urns, xmlBlocks } = parseQueryExtensions(rawExtensions);
  return {
    search,
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
    flagGgep: qhdFlagMeaningful(enabler, setter, 5)
      ? qhdFlagEnabled(enabler, setter, 5)
      : undefined,
    flagUploadSpeedMeasured: qhdFlagMeaningful(enabler, setter, 4)
      ? qhdFlagEnabled(enabler, setter, 4)
      : undefined,
    flagHaveUploaded: qhdFlagMeaningful(enabler, setter, 3)
      ? qhdFlagEnabled(enabler, setter, 3)
      : undefined,
    flagBusy: qhdFlagMeaningful(enabler, setter, 2)
      ? qhdFlagEnabled(enabler, setter, 2)
      : undefined,
    flagPush: qhdFlagMeaningful(enabler, setter, 0)
      ? qhdFlagEnabled(enabler, setter, 0)
      : undefined,
    qhdPrivateArea: privateArea,
  };
}

function encodeQueryHit(
  port: number,
  ip: string,
  speedKBps: number,
  results: ShareFile[],
  serventId: Buffer,
  options: {
    vendorCode?: string;
    push?: boolean;
    busy?: boolean;
    haveUploaded?: boolean;
    measuredSpeed?: boolean;
  } = {},
): Buffer {
  const parts: Buffer[] = [];
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
    const ext = Buffer.from(r.sha1Urn, "utf8");
    parts.push(item, name, Buffer.from([0x00]), ext, Buffer.from([0x00]));
  }
  parts.push(
    buildQhdBlock({
      vendorCode: options.vendorCode,
      push: !!options.push,
      busy: options.busy,
      haveUploaded: options.haveUploaded,
      measuredSpeed: options.measuredSpeed,
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
    if (off + 8 > payload.length - 16)
      throw new Error("truncated query hit result header");
    const fileIndex = payload.readUInt32LE(off);
    off += 4;
    const fileSize = payload.readUInt32LE(off);
    off += 4;
    const nameEnd = payload.indexOf(0x00, off);
    if (nameEnd === -1 || nameEnd > payload.length - 16)
      throw new Error("truncated query hit file name");
    const fileName = payload.subarray(off, nameEnd).toString("utf8");
    off = nameEnd + 1;
    const extEnd = payload.indexOf(0x00, off);
    if (extEnd === -1 || extEnd > payload.length - 16)
      throw new Error("truncated query hit extension block");
    const rawExtension = payload.subarray(off, extEnd);
    const urns: string[] = [];
    const metadata: string[] = [];
    for (const block of splitFsBlocks(rawExtension)) {
      const text = block.toString("utf8");
      if (text.startsWith("urn:")) urns.push(text);
      else if (text) metadata.push(text);
    }
    off = extEnd + 1;
    results.push({
      fileIndex,
      fileSize,
      fileName,
      urns,
      metadata,
      rawExtension,
    });
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

function parseHttpHeaders(raw: string): Record<string, string> {
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

function parseByteRange(
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
  if (!startRaw) {
    const suffixLen = Number(endRaw);
    if (!Number.isInteger(suffixLen) || suffixLen <= 0) return null;
    const length = Math.min(suffixLen, size);
    return { start: size - length, end: last, partial: length < size };
  }
  const start = Number(startRaw);
  if (!Number.isInteger(start) || start < 0) return null;
  if (size > 0 && start > last) return null;
  let end = endRaw ? Number(endRaw) : last;
  if (!Number.isInteger(end) || end < start) return null;
  if (size === 0) end = -1;
  else end = Math.min(end, last);
  return { start, end, partial: size > 0 && (start > 0 || end < last) };
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

export class GnutellaServent {
  configPath: string;
  doc: ConfigDoc;
  serventId: Buffer;
  server: net.Server | null = null;
  peers = new Map<string, Peer>();
  dialing = new Set<string>();
  peerSeq = 0;
  shares: ShareFile[] = [];
  sharesByIndex = new Map<number, ShareFile>();
  sharesByUrn = new Map<string, ShareFile>();
  seen = new Map<string, number>();
  pingRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  queryRoutes = new Map<string, Route | typeof LOCAL_ROUTE>();
  pushRoutes = new Map<string, Route>();
  lastResults: SearchHit[] = [];
  resultSeq = 1;
  downloads: DownloadRecord[] = [];
  pendingPushes = new Map<string, PendingPush[]>();
  timers: NodeJS.Timeout[] = [];
  stopped = false;
  listeners = new Set<GnutellaEventListener>();
  qrpTable = new QrpTable();
  pongCache = new Map<string, { payload: Buffer; at: number }>();

  constructor(
    configPath: string,
    doc: ConfigDoc,
    options: GnutellaServentOptions = {},
  ) {
    this.configPath = path.resolve(configPath);
    this.doc = doc;
    this.serventId = fromHex16(doc.state.serventIdHex);
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  subscribe(listener: GnutellaEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitEvent(event: GnutellaEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  emitMaintenanceError(
    operation: "SHARE_RESCAN" | "RECONNECT" | "SAVE",
    e: any,
  ): void {
    this.emitEvent({
      type: "MAINTENANCE_ERROR",
      at: ts(),
      operation,
      message: errMsg(e),
    });
  }

  schedule(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  peerInfo(peer: Peer): PeerInfo {
    return {
      key: peer.key,
      remoteLabel: peer.remoteLabel,
      outbound: peer.outbound,
      dialTarget: peer.dialTarget,
    };
  }

  peerCount(): number {
    return this.peers.size;
  }

  config() {
    return this.doc.config;
  }

  async save(): Promise<void> {
    const c = this.config();
    this.doc.config.peers = unique(this.doc.config.peers).slice(0, 4096);
    this.doc.state.serventIdHex = this.serventId.toString("hex");
    await ensureDir(path.dirname(this.configPath));
    await ensureDir(c.sharedDir);
    await ensureDir(c.downloadsDir);
    await writeDoc(this.configPath, this.doc);
  }

  async refreshShares(): Promise<void> {
    const files = await walkFiles(this.config().sharedDir);
    const shares: ShareFile[] = [];
    let idx = 1;
    for (const abs of files) {
      const st = await fsp.stat(abs);
      const rel = path
        .relative(this.config().sharedDir, abs)
        .replace(/\\/g, "/");
      const sha1 = await sha1File(abs);
      const sha1Urn = sha1ToUrn(sha1);
      const keywords = unique([
        ...tokenizeKeywords(path.basename(abs)),
        ...tokenizeKeywords(rel),
        ...tokenizeKeywords(path.parse(abs).name),
      ]);
      shares.push({
        index: idx++,
        name: path.basename(abs),
        rel,
        abs,
        size: st.size,
        sha1,
        sha1Urn,
        keywords,
      });
    }
    this.shares = shares;
    this.sharesByIndex = new Map(shares.map((x) => [x.index, x]));
    this.sharesByUrn = new Map(
      shares.map((x) => [x.sha1Urn.toLowerCase(), x]),
    );
    this.qrpTable.rebuildFromShares(shares);
    this.emitEvent({
      type: "SHARES_REFRESHED",
      at: ts(),
      count: this.shares.length,
      totalKBytes: this.totalSharedKBytes(),
    });
    if (this.config().enableQrp) {
      for (const peer of this.peers.values()) {
        void this.sendQrpTable(peer).catch(() => void 0);
      }
    }
  }

  totalSharedKBytes(): number {
    return Math.ceil(this.shares.reduce((a, x) => a + x.size, 0) / 1024);
  }

  addKnownPeer(host: string, port: number): void {
    const c = this.config();
    if (!host || !port) return;
    const peer = normalizePeer(host, port);
    const self = normalizePeer(c.advertisedHost, c.advertisedPort);
    if (peer === self) return;
    if (!this.doc.config.peers.includes(peer))
      this.doc.config.peers.push(peer);
  }

  peerDialState(
    host: string,
    port: number,
  ): "connected" | "dialing" | "none" {
    const target = normalizePeer(host, port);
    if (this.dialing.has(target)) return "dialing";
    for (const peer of this.peers.values()) {
      if (peer.dialTarget === target) return "connected";
      if (
        peer.capabilities.listenIp &&
        normalizePeer(
          peer.capabilities.listenIp.host,
          peer.capabilities.listenIp.port,
        ) === target
      )
        return "connected";
    }
    return "none";
  }

  async connectToPeer(peerSpec: string): Promise<ConnectPeerResult> {
    const addr = parsePeer(peerSpec);
    if (!addr) throw new Error("expected host:port");
    const peer = normalizePeer(addr.host, addr.port);
    const self = normalizePeer(
      this.config().advertisedHost,
      this.config().advertisedPort,
    );
    if (peer === self) throw new Error("cannot add self as peer");

    this.addKnownPeer(addr.host, addr.port);

    const state = this.peerDialState(addr.host, addr.port);
    if (state === "connected")
      return { peer, status: "already-connected" };
    if (state === "dialing") return { peer, status: "dialing" };

    try {
      await this.connectPeer(addr.host, addr.port);
      return { peer, status: "connected" };
    } catch (e) {
      return { peer, status: "saved", message: errMsg(e) };
    }
  }

  markSeen(
    payloadType: number,
    descriptorIdHex: string,
    payload?: Buffer,
  ): void {
    this.seen.set(
      seenKey(payloadType, descriptorIdHex, payload),
      Date.now(),
    );
  }

  hasSeen(
    payloadType: number,
    descriptorIdHex: string,
    payload?: Buffer,
  ): boolean {
    return this.seen.has(seenKey(payloadType, descriptorIdHex, payload));
  }

  pruneMaps(): void {
    const now = Date.now();
    const seenAge = this.config().seenTtlSec * 1000;
    const routeAge = this.config().routeTtlSec * 1000;
    for (const [k, t] of this.seen)
      if (now - t > seenAge) this.seen.delete(k);
    for (const [k, v] of this.pingRoutes)
      if (v !== LOCAL_ROUTE && now - v.ts > routeAge)
        this.pingRoutes.delete(k);
    for (const [k, v] of this.queryRoutes)
      if (v !== LOCAL_ROUTE && now - v.ts > routeAge)
        this.queryRoutes.delete(k);
    for (const [k, v] of this.pushRoutes)
      if (now - v.ts > routeAge) this.pushRoutes.delete(k);
    for (const [k, queue] of this.pendingPushes) {
      const keep: PendingPush[] = [];
      for (const pending of queue) {
        if (now - pending.createdAt > this.config().pushWaitMs)
          pending.reject(new Error("push timed out"));
        else keep.push(pending);
      }
      if (keep.length) this.pendingPushes.set(k, keep);
      else this.pendingPushes.delete(k);
    }
    for (const [k, v] of this.pongCache)
      if (now - v.at > routeAge) this.pongCache.delete(k);
    if (this.lastResults.length > 1000)
      this.lastResults = this.lastResults.slice(-1000);
  }

  baseHandshakeHeaders(): Record<string, string> {
    const c = this.config();
    const headers: Record<string, string> = {
      "user-agent": c.userAgent || DEFAULT_USER_AGENT,
      "x-ultrapeer": c.advertiseUltrapeer ? "True" : "False",
      "x-ultrapeer-needed": "False",
      "listen-ip": `${c.advertisedHost}:${c.advertisedPort}`,
      "x-max-ttl": String(c.maxTtl),
    };
    if (c.enableQrp)
      headers["x-query-routing"] = c.queryRoutingVersion || "0.1";
    if (c.enableCompression) headers["accept-encoding"] = "deflate";
    if (c.enablePongCaching) headers["pong-caching"] = "0.1";
    if (c.enableGgep) headers["ggep"] = "0.5";
    if (c.enableBye) headers["bye-packet"] = "0.1";
    return headers;
  }

  buildServerHandshakeHeaders(
    requestHeaders: Record<string, string>,
  ): Record<string, string> {
    const headers = this.baseHandshakeHeaders();
    if (
      this.config().enableCompression &&
      hasToken(requestHeaders["accept-encoding"], "deflate")
    )
      headers["content-encoding"] = "deflate";
    return headers;
  }

  buildClientFinalHeaders(
    serverHeaders: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {};
    if (
      this.config().enableCompression &&
      hasToken(serverHeaders["accept-encoding"], "deflate")
    )
      headers["content-encoding"] = "deflate";
    return headers;
  }

  buildCapabilities(
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
      supportsCompression:
        hasToken(h["accept-encoding"], "deflate") ||
        hasToken(h["content-encoding"], "deflate"),
      compressIn,
      compressOut,
      isUltrapeer: parseBoolHeader(h["x-ultrapeer"]),
      ultrapeerNeeded: parseBoolHeader(h["x-ultrapeer-needed"]),
      queryRoutingVersion: h["x-query-routing"],
      ultrapeerQueryRoutingVersion: h["x-ultrapeer-query-routing"],
      listenIp: parseListenIpHeader(h["listen-ip"]),
    };
  }

  selectTryPeers(limit = MAX_XTRY): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const self = normalizePeer(
      this.config().advertisedHost,
      this.config().advertisedPort,
    );
    const push = (s?: string) => {
      if (!s) return;
      const addr = parsePeer(s);
      if (!addr) return;
      const p = normalizePeer(addr.host, addr.port);
      if (p === self || seen.has(p)) return;
      seen.add(p);
      out.push(p);
    };
    for (const peer of this.peers.values()) {
      if (peer.capabilities.listenIp)
        push(
          normalizePeer(
            peer.capabilities.listenIp.host,
            peer.capabilities.listenIp.port,
          ),
        );
      else if (peer.dialTarget) push(peer.dialTarget);
      else push(peer.remoteLabel);
      if (out.length >= limit) return out;
    }
    for (const s of this.doc.config.peers) {
      push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  maybeAbsorbTryHeaders(headers: Record<string, string>): void {
    for (const addr of [
      ...parsePeerHeaderList(headers["x-try"]),
      ...parsePeerHeaderList(headers["x-try-ultrapeers"]),
    ])
      this.addKnownPeer(addr.host, addr.port);
  }

  reject06(
    socket: net.Socket,
    code: number,
    reason: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const tryPeers = this.selectTryPeers();
    const headers = lowerCaseHeaders(extraHeaders);
    if (tryPeers.length) {
      headers["x-try"] = tryPeers.join(",");
      headers["x-try-ultrapeers"] = tryPeers.join(",");
    }
    socket.end(
      buildHandshakeBlock(`GNUTELLA/0.6 ${code} ${reason}`, headers),
    );
  }

  async start(): Promise<void> {
    const c = this.config();
    await this.refreshShares();
    await this.startServer();
    this.schedule(
      c.rescanSharesSec * 1000,
      () =>
        void this.refreshShares().catch((e) =>
          this.emitMaintenanceError("SHARE_RESCAN", e),
        ),
    );
    this.schedule(5000, () => this.pruneMaps());
    this.schedule(
      c.reconnectIntervalSec * 1000,
      () =>
        void this.connectKnownPeers().catch((e) =>
          this.emitMaintenanceError("RECONNECT", e),
        ),
    );
    this.schedule(c.pingIntervalSec * 1000, () =>
      this.sendPing(c.defaultPingTtl),
    );
    this.schedule(
      15000,
      () =>
        void this.save().catch((e) =>
          this.emitMaintenanceError("SAVE", e),
        ),
    );
    this.emitEvent({
      type: "STARTED",
      at: ts(),
      listenHost: c.listenHost,
      listenPort: c.listenPort,
      advertisedHost: c.advertisedHost,
      advertisedPort: c.advertisedPort,
    });
    this.emitEvent({
      type: "IDENTITY",
      at: ts(),
      serventIdHex: this.serventId.toString("hex"),
    });
    void this.connectKnownPeers().catch((e) =>
      this.emitMaintenanceError("RECONNECT", e),
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    if (this.config().enableBye) {
      for (const peer of this.peers.values()) {
        try {
          if (peer.capabilities.supportsBye)
            this.sendBye(peer, BYE_DEFAULT_CODE, "normal shutdown");
        } catch {
          // ignore
        }
      }
      const waitForPeerClose = (peer: Peer) =>
        new Promise<void>((resolve) => {
          if (peer.socket.destroyed) return resolve();
          const done = () => {
            peer.socket.off("close", done);
            peer.socket.off("end", done);
            resolve();
          };
          peer.socket.once("close", done);
          peer.socket.once("end", done);
        });
      const closingPeers = [...this.peers.values()].filter(
        (peer) => peer.closingAfterBye,
      );
      if (closingPeers.length)
        await Promise.race([
          Promise.allSettled(
            closingPeers.map((peer) => waitForPeerClose(peer)),
          ),
          sleep(2000),
        ]);
    }
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.peers.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    await this.save();
  }

  async startServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) =>
        this.handleProbe(socket),
      );
      server.on("error", reject);
      server.listen(
        this.config().listenPort,
        this.config().listenHost,
        () => {
          this.server = server;
          resolve();
        },
      );
    });
  }

  handleProbe(socket: net.Socket): void {
    const ctx: ProbeCtx = {
      socket,
      buf: Buffer.alloc(0),
      mode: "undecided",
    };
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      if (ctx.mode === "done") return;
      ctx.buf = Buffer.concat([ctx.buf, toBuffer(chunk)]);
      try {
        this.tryDecideProbe(ctx);
      } catch (e) {
        this.emitEvent({
          type: "PROBE_REJECTED",
          at: ts(),
          message: errMsg(e),
        });
        socket.destroy();
      }
    });
    socket.on("error", () => void 0);
  }

  tryDecideProbe(ctx: ProbeCtx): void {
    if (ctx.mode === "undecided") {
      const raw = ctx.buf.toString("latin1");
      if (raw.startsWith("GNUTELLA CONNECT/0.6")) {
        const cut = findHeaderEnd(raw);
        if (cut === -1) return;
        const { startLine, headers } = parseHandshakeBlock(
          raw.slice(0, cut),
        );
        if (!/^GNUTELLA CONNECT\/0\.[0-9]+/i.test(startLine))
          throw new Error(`unexpected 0.6 start line: ${startLine}`);
        this.maybeAbsorbTryHeaders(headers);
        if (this.peerCount() >= this.config().maxConnections) {
          this.reject06(ctx.socket, 503, "Busy");
          ctx.mode = "done";
          return;
        }
        ctx.requestHeaders = headers;
        ctx.serverHeaders = this.buildServerHandshakeHeaders(headers);
        ctx.socket.write(
          buildHandshakeBlock("GNUTELLA/0.6 200 OK", ctx.serverHeaders),
        );
        ctx.buf = ctx.buf.subarray(cut);
        ctx.mode = "await-final-0.6";
        this.tryDecideProbe(ctx);
        return;
      }
      if (/^GNUTELLA CONNECT\/0\./i.test(raw)) {
        const cut = findHeaderEnd(raw);
        if (cut === -1) return;
        const { startLine } = parseHandshakeBlock(raw.slice(0, cut));
        throw new Error(`unsupported inbound handshake: ${startLine}`);
      }
      if (raw.startsWith("GET ") || raw.startsWith("HEAD ")) {
        const cut = findHeaderEnd(raw);
        if (cut === -1) return;
        ctx.mode = "done";
        this.startHttpSession(
          ctx.socket,
          raw.slice(0, cut),
          ctx.buf.subarray(cut),
        );
        return;
      }
      if (raw.startsWith("GIV ")) {
        const cut = findHeaderEnd(raw);
        if (cut === -1) return;
        ctx.mode = "done";
        void this.handleIncomingGiv(ctx.socket, raw.slice(0, cut)).catch(
          () => ctx.socket.destroy(),
        );
        return;
      }
      if (ctx.buf.length > 8192)
        throw new Error("unknown inbound protocol");
      return;
    }

    if (ctx.mode === "await-final-0.6") {
      const raw = ctx.buf.toString("latin1");
      const cut = findHeaderEnd(raw);
      if (cut === -1) return;
      const { startLine, headers } = parseHandshakeBlock(
        raw.slice(0, cut),
      );
      const m = /^GNUTELLA\/0\.[0-9]+\s+(\d+)/i.exec(startLine);
      if (!m) throw new Error(`unexpected final 0.6 line: ${startLine}`);
      if (Number(m[1]) !== 200)
        throw new Error(`client rejected connection: ${startLine}`);
      const requestHeaders = ctx.requestHeaders || {};
      const serverHeaders = ctx.serverHeaders || {};
      const compressIn =
        hasToken(headers["content-encoding"], "deflate") &&
        !!this.config().enableCompression;
      const compressOut =
        hasToken(serverHeaders["content-encoding"], "deflate") &&
        !!this.config().enableCompression;
      const caps = this.buildCapabilities(
        "0.6",
        mergeHeaders(requestHeaders, headers),
        compressIn,
        compressOut,
      );
      const rest = ctx.buf.subarray(cut);
      ctx.mode = "done";
      this.attachPeer(
        ctx.socket,
        false,
        `${ctx.socket.remoteAddress || "?"}:${ctx.socket.remotePort || "?"}`,
        caps,
        rest,
      );
      return;
    }
  }

  attachPeer(
    socket: net.Socket,
    outbound: boolean,
    remoteLabel: string,
    capabilities: PeerCapabilities,
    initialBuf: Buffer = Buffer.alloc(0),
    dialTarget?: string,
  ): Peer {
    const key = `peer-${++this.peerSeq}`;
    const peer: Peer = {
      key,
      socket,
      buf: Buffer.alloc(0),
      outbound,
      remoteLabel,
      dialTarget,
      capabilities,
      remoteQrp: initialRemoteQrpState(),
      lastPingAt: 0,
    };
    this.peers.set(key, peer);
    socket.setNoDelay(true);
    socket.setTimeout(0);

    let closed = false;
    const drop = (message: string) => {
      if (closed) return;
      closed = true;
      this.peers.delete(peer.key);
      if (!this.stopped)
        this.emitEvent({
          type: "PEER_DROPPED",
          at: ts(),
          peer: this.peerInfo(peer),
          message,
        });
    };

    if (peer.capabilities.compressOut) {
      peer.deflater = zlib.createDeflate();
      peer.deflater.on("data", (chunk) => {
        if (!socket.destroyed) socket.write(chunk);
      });
      peer.deflater.on("error", (e) => {
        drop(`deflater error: ${errMsg(e)}`);
        socket.destroy();
      });
    }

    const feedDecoded = (chunk: Buffer) => {
      peer.buf = Buffer.concat([peer.buf, chunk]);
      try {
        this.consumePeerBuffer(peer);
      } catch (e) {
        drop(errMsg(e));
        socket.destroy();
      }
    };

    if (peer.capabilities.compressIn) {
      peer.inflater = zlib.createInflate();
      peer.inflater.on("data", (chunk) => feedDecoded(toBuffer(chunk)));
      peer.inflater.on("error", (e) => {
        drop(`inflater error: ${errMsg(e)}`);
        socket.destroy();
      });
    }

    socket.on("data", (chunk) => {
      if (closed) return;
      const data = toBuffer(chunk);
      if (peer.inflater) peer.inflater.write(data);
      else feedDecoded(data);
    });
    socket.on("close", () => drop("socket closed"));
    socket.on("error", (e) => drop(errMsg(e)));

    if (initialBuf.length) {
      if (peer.inflater) peer.inflater.write(initialBuf);
      else feedDecoded(initialBuf);
    }

    this.emitEvent({
      type: "PEER_CONNECTED",
      at: ts(),
      peer: this.peerInfo(peer),
    });
    setTimeout(() => this.sendPing(1), 300);
    if (
      this.config().enableQrp &&
      (capabilities.queryRoutingVersion ||
        capabilities.ultrapeerQueryRoutingVersion)
    ) {
      setTimeout(
        () => void this.sendQrpTable(peer).catch(() => void 0),
        500,
      );
    }
    return peer;
  }

  startHttpSession(
    socket: net.Socket,
    firstHead: string,
    initialBuf: Buffer = Buffer.alloc(0),
  ): void {
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

    const drain = async (nextHead?: string): Promise<void> => {
      if (session.closed || session.busy) return;
      session.busy = true;
      try {
        let head = nextHead;
        while (!session.closed) {
          if (!head) {
            const raw = session.buf.toString("latin1");
            const cut = findHeaderEnd(raw);
            if (cut === -1) break;
            head = raw.slice(0, cut);
            session.buf = session.buf.subarray(cut);
          }
          const keepAlive = await this.handleIncomingGet(socket, head);
          head = undefined;
          if (!keepAlive) {
            closeSession();
            if (
              !socket.destroyed &&
              !(socket as any).writableEnded &&
              !(socket as any).ended
            )
              socket.end();
            break;
          }
        }
      } catch (e) {
        closeSession();
        socket.destroy(e instanceof Error ? e : undefined);
      } finally {
        session.busy = false;
      }
      if (session.closed) return;
      const raw = session.buf.toString("latin1");
      if (findHeaderEnd(raw) !== -1) void drain();
    };

    const onData = (chunk: string | Buffer) => {
      if (session.closed) return;
      session.buf = Buffer.concat([session.buf, toBuffer(chunk)]);
      void drain();
    };

    const onError = () => closeSession();

    socket.on("data", onData);
    socket.on("close", closeSession);
    socket.on("end", closeSession);
    socket.on("error", onError);

    void drain(firstHead);
  }

  consumePeerBuffer(peer: Peer): void {
    while (peer.buf.length >= HEADER_LEN) {
      const hdr = parseHeader(peer.buf.subarray(0, HEADER_LEN));
      if (hdr.payloadLength > this.config().maxPayloadBytes)
        throw new Error(`payload too large: ${hdr.payloadLength}`);
      if (peer.buf.length < HEADER_LEN + hdr.payloadLength) return;
      const payload = peer.buf.subarray(
        HEADER_LEN,
        HEADER_LEN + hdr.payloadLength,
      );
      peer.buf = peer.buf.subarray(HEADER_LEN + hdr.payloadLength);
      if (!this.validateDescriptor(hdr.payloadType, payload))
        throw new Error(
          `invalid ${TYPE_NAME[hdr.payloadType] || `0x${hdr.payloadType.toString(16)}`} payload`,
        );
      if (hdr.payloadType !== TYPE.QUERY)
        hdr.ttl = Math.min(hdr.ttl, this.config().maxTtl);
      this.emitEvent({
        type: "PEER_MESSAGE_RECEIVED",
        at: ts(),
        peer: this.peerInfo(peer),
        payloadType: hdr.payloadType,
        payloadTypeName:
          TYPE_NAME[hdr.payloadType] ||
          `0x${hdr.payloadType.toString(16)}`,
        descriptorIdHex: hdr.descriptorIdHex,
        ttl: hdr.ttl,
        hops: hdr.hops,
        payloadLength: payload.length,
      });
      this.handleDescriptor(peer, hdr, payload);
    }
  }

  validateDescriptor(payloadType: number, payload: Buffer): boolean {
    switch (payloadType) {
      case TYPE.PING:
        return true;
      case TYPE.PONG:
        return payload.length >= 14;
      case TYPE.BYE:
        return payload.length >= 2;
      case TYPE.ROUTE_TABLE_UPDATE:
        return payload.length >= 1;
      case TYPE.PUSH:
        return payload.length >= 26;
      case TYPE.QUERY:
        return payload.length >= 3;
      case TYPE.QUERY_HIT:
        return payload.length >= 27;
      default:
        return true;
    }
  }

  sendRaw(peer: Peer, frame: Buffer): void {
    if (peer.deflater) {
      peer.deflater.write(frame);
      peer.deflater.flush(zlib.constants.Z_SYNC_FLUSH);
      return;
    }
    peer.socket.write(frame);
  }

  sendToPeer(
    peer: Peer,
    payloadType: number,
    descriptorId: Buffer,
    ttl: number,
    hops: number,
    payload: Buffer,
  ): void {
    if (peer.closingAfterBye && payloadType !== TYPE.BYE) return;
    const frame = buildHeader(
      descriptorId,
      payloadType,
      ttl,
      hops,
      payload,
    );
    this.sendRaw(peer, frame);
  }

  forwardToRoute(
    route: Route,
    payloadType: number,
    descriptorId: Buffer,
    ttl: number,
    hops: number,
    payload: Buffer,
  ): void {
    if (ttl <= 0) return;
    const peer = this.peers.get(route.peerKey);
    if (!peer) return;
    const nextTtl = Math.max(0, ttl - 1);
    const nextHops = hops + 1;
    this.sendToPeer(
      peer,
      payloadType,
      descriptorId,
      nextTtl,
      nextHops,
      payload,
    );
  }

  broadcast(
    payloadType: number,
    descriptorId: Buffer,
    ttl: number,
    hops: number,
    payload: Buffer,
    exceptPeerKey?: string,
  ): void {
    for (const peer of this.peers.values()) {
      if (exceptPeerKey && peer.key === exceptPeerKey) continue;
      this.sendToPeer(peer, payloadType, descriptorId, ttl, hops, payload);
    }
  }

  broadcastQuery(
    descriptorId: Buffer,
    ttl: number,
    hops: number,
    payload: Buffer,
    search: string,
    exceptPeerKey?: string,
  ): void {
    for (const peer of this.peers.values()) {
      if (exceptPeerKey && peer.key === exceptPeerKey) continue;
      if (
        this.config().enableQrp &&
        !QrpTable.matchesRemote(peer.remoteQrp, search)
      )
        continue;
      this.sendToPeer(peer, TYPE.QUERY, descriptorId, ttl, hops, payload);
    }
  }

  normalizeQueryLifetime(
    ttl: number,
    hops: number,
  ): { ttl: number; hops: number } | null {
    if (ttl > 15) return null;
    const maxLife = Math.max(1, this.config().maxTtl);
    if (hops > maxLife) return null;
    return { ttl: Math.max(0, Math.min(ttl, maxLife - hops)), hops };
  }

  isIndexQuery(
    hdr: { ttl: number; hops: number },
    q: QueryDescriptor,
  ): boolean {
    return hdr.ttl === 1 && hdr.hops === 0 && q.search === "    ";
  }

  shouldIgnoreQuery(
    hdr: { ttl: number; hops: number },
    q: QueryDescriptor,
  ): boolean {
    if (q.urns.length) return false;
    if (this.isIndexQuery(hdr, q)) return false;
    if (!q.search.trim()) return true;
    const words = splitSearchTerms(q.search);
    if (!words.length) return true;
    return words.every((word) => word.length <= 1);
  }

  enqueuePendingPush(pending: PendingPush): void {
    const queue = this.pendingPushes.get(pending.serventIdHex) || [];
    queue.push(pending);
    this.pendingPushes.set(pending.serventIdHex, queue);
  }

  shiftPendingPush(serventIdHex: string): PendingPush | undefined {
    const queue = this.pendingPushes.get(serventIdHex);
    if (!queue?.length) return undefined;
    const pending = queue.shift();
    if (queue.length) this.pendingPushes.set(serventIdHex, queue);
    else this.pendingPushes.delete(serventIdHex);
    return pending;
  }

  cachePongPayload(payload: Buffer): void {
    const digest = crypto.createHash("sha1").update(payload).digest("hex");
    this.pongCache.set(digest, {
      payload: Buffer.from(payload),
      at: Date.now(),
    });
    if (this.pongCache.size > 64) {
      const oldest = [...this.pongCache.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, this.pongCache.size - 64);
      for (const [k] of oldest) this.pongCache.delete(k);
    }
  }

  handleDescriptor(peer: Peer, hdr: any, payload: Buffer): void {
    if (
      peer.closingAfterBye &&
      hdr.payloadType !== TYPE.QUERY_HIT &&
      hdr.payloadType !== TYPE.PUSH
    )
      return;
    if (
      hdr.payloadType !== TYPE.ROUTE_TABLE_UPDATE &&
      this.hasSeen(hdr.payloadType, hdr.descriptorIdHex, payload)
    )
      return;
    if (hdr.payloadType !== TYPE.ROUTE_TABLE_UPDATE)
      this.markSeen(hdr.payloadType, hdr.descriptorIdHex, payload);

    switch (hdr.payloadType) {
      case TYPE.PING:
        this.pingRoutes.set(hdr.descriptorIdHex, {
          peerKey: peer.key,
          ts: Date.now(),
        });
        this.respondPong(peer, hdr);
        if (hdr.ttl > 1 && Date.now() - peer.lastPingAt >= 1000) {
          peer.lastPingAt = Date.now();
          this.broadcast(
            TYPE.PING,
            hdr.descriptorId,
            hdr.ttl - 1,
            hdr.hops + 1,
            payload,
            peer.key,
          );
        }
        break;
      case TYPE.PONG:
        this.onPong(peer, hdr, payload);
        break;
      case TYPE.BYE:
        this.onBye(peer, payload);
        break;
      case TYPE.ROUTE_TABLE_UPDATE:
        this.onRouteTableUpdate(peer, payload);
        break;
      case TYPE.QUERY:
        {
          const q = parseQuery(payload);
          const normalized = this.normalizeQueryLifetime(
            hdr.ttl,
            hdr.hops,
          );
          this.emitEvent({
            type: "QUERY_RECEIVED",
            at: ts(),
            peer: this.peerInfo(peer),
            descriptorIdHex: hdr.descriptorIdHex,
            ttl: normalized?.ttl ?? hdr.ttl,
            hops: hdr.hops,
            search: q.search,
            urns: q.urns,
          });
          if (!normalized) break;
          hdr.ttl = normalized.ttl;
          hdr.hops = normalized.hops;
          if (this.shouldIgnoreQuery(hdr, q)) break;
          this.queryRoutes.set(hdr.descriptorIdHex, {
            peerKey: peer.key,
            ts: Date.now(),
          });
          this.respondQueryHit(peer, hdr, q);
          if (hdr.ttl > 0)
            this.broadcastQuery(
              hdr.descriptorId,
              hdr.ttl - 1,
              hdr.hops + 1,
              payload,
              q.search,
              peer.key,
            );
        }
        break;
      case TYPE.QUERY_HIT:
        this.onQueryHit(peer, hdr, payload);
        break;
      case TYPE.PUSH:
        void this.onPush(peer, hdr, payload);
        break;
      default:
        break;
    }
  }

  onRouteTableUpdate(peer: Peer, payload: Buffer): void {
    const msg = parseRouteTableUpdate(payload);
    if (msg.variant === "reset") {
      peer.remoteQrp.resetSeen = true;
      peer.remoteQrp.tableSize = msg.tableLength;
      peer.remoteQrp.infinity = msg.infinity;
      peer.remoteQrp.entryBits = DEFAULT_QRP_ENTRY_BITS;
      peer.remoteQrp.table = null;
      peer.remoteQrp.seqSize = 0;
      peer.remoteQrp.parts.clear();
      return;
    }
    if (!peer.remoteQrp.resetSeen) return;
    peer.remoteQrp.seqSize = msg.seqSize;
    peer.remoteQrp.compressor = msg.compressor;
    peer.remoteQrp.entryBits = msg.entryBits;
    peer.remoteQrp.parts.set(msg.seqNo, Buffer.from(msg.data));
    QrpTable.applyPatch(peer.remoteQrp);
  }

  async sendQrpTable(peer: Peer): Promise<void> {
    if (!this.config().enableQrp) return;
    if (
      !(
        peer.capabilities.queryRoutingVersion ||
        peer.capabilities.ultrapeerQueryRoutingVersion
      )
    )
      return;
    this.sendToPeer(
      peer,
      TYPE.ROUTE_TABLE_UPDATE,
      randomId16(),
      1,
      0,
      this.qrpTable.encodeReset(),
    );
    for (const patch of this.qrpTable.encodePatchChunks(
      Math.min(this.config().maxPayloadBytes, 60 * 1024),
    )) {
      this.sendToPeer(
        peer,
        TYPE.ROUTE_TABLE_UPDATE,
        randomId16(),
        1,
        0,
        patch,
      );
      await sleep(5);
    }
  }

  sendBye(peer: Peer, code: number, message: string): void {
    peer.closingAfterBye = true;
    const payload = encodeBye(code, message);
    this.sendToPeer(peer, TYPE.BYE, randomId16(), 1, 0, payload);
  }

  respondPong(peer: Peer, hdr: any): void {
    const ttl = Math.max(1, hdr.hops);
    const own = encodePong(
      this.config().advertisedPort,
      this.config().advertisedHost,
      this.shares.length,
      this.totalSharedKBytes(),
    );
    this.sendToPeer(peer, TYPE.PONG, hdr.descriptorId, ttl, 0, own);
    if (!this.config().enablePongCaching) return;
    let sent = 1;
    const cached = [...this.pongCache.values()].sort(
      (a, b) => b.at - a.at,
    );
    for (const entry of cached) {
      if (sent >= 10) break;
      this.sendToPeer(
        peer,
        TYPE.PONG,
        hdr.descriptorId,
        ttl,
        0,
        entry.payload,
      );
      sent++;
    }
  }

  matchQuery(q: QueryDescriptor, share: ShareFile): boolean {
    if (q.urns.length) {
      const urnSet = new Set(q.urns.map((x) => x.toLowerCase()));
      if (!urnSet.has(share.sha1Urn.toLowerCase())) return false;
    }
    const term = q.search.trim();
    if (!term) return q.urns.length > 0;
    const kws = tokenizeKeywords(term);
    if (!kws.length)
      return share.name.toLowerCase().includes(term.toLowerCase());
    const shareKw = new Set(share.keywords);
    return kws.every(
      (kw) => shareKw.has(kw) || share.name.toLowerCase().includes(kw),
    );
  }

  respondQueryHit(
    peer: Peer,
    hdr: any,
    payloadOrQuery: Buffer | QueryDescriptor,
  ): void {
    const q = Buffer.isBuffer(payloadOrQuery)
      ? parseQuery(payloadOrQuery)
      : payloadOrQuery;
    const matches = this.isIndexQuery(hdr, q)
      ? this.shares
      : this.shares.filter((f) => this.matchQuery(q, f));
    if (!matches.length) return;
    const limit = Math.max(1, this.config().maxResultsPerQuery);
    const chosen = matches.slice(0, limit);
    const batchSize = 16;
    const replyTtl = Math.min(
      this.config().maxTtl,
      Math.max(1, hdr.hops + 2),
    );
    for (let off = 0; off < chosen.length; off += batchSize) {
      const batch = chosen.slice(off, off + batchSize);
      const out = encodeQueryHit(
        this.config().advertisedPort,
        this.config().advertisedHost,
        this.config().advertisedSpeedKBps,
        batch,
        this.serventId,
        {
          vendorCode: this.config().vendorCode,
          push: false,
          busy: false,
          haveUploaded: false,
          measuredSpeed: true,
        },
      );
      this.sendToPeer(
        peer,
        TYPE.QUERY_HIT,
        hdr.descriptorId,
        replyTtl,
        0,
        out,
      );
    }
  }

  onPong(_peer: Peer, hdr: any, payload: Buffer): void {
    const pong = parsePong(payload);
    this.cachePongPayload(payload);
    this.addKnownPeer(pong.ip, pong.port);
    const route = this.pingRoutes.get(hdr.descriptorIdHex);
    if (!route) return;
    if (route === LOCAL_ROUTE) {
      this.emitEvent({
        type: "PONG",
        at: ts(),
        ip: pong.ip,
        port: pong.port,
        files: pong.files,
        kbytes: pong.kbytes,
      });
      return;
    }
    this.forwardToRoute(
      route,
      TYPE.PONG,
      hdr.descriptorId,
      hdr.ttl,
      hdr.hops,
      payload,
    );
  }

  onQueryHit(peer: Peer, hdr: any, payload: Buffer): void {
    const qh = parseQueryHit(payload);
    this.pushRoutes.set(qh.serventIdHex, {
      peerKey: peer.key,
      ts: Date.now(),
    });
    const route = this.queryRoutes.get(hdr.descriptorIdHex);
    if (!route) return;
    if (route === LOCAL_ROUTE) {
      for (const r of qh.results) {
        const hit: SearchHit = {
          resultNo: this.resultSeq++,
          queryIdHex: hdr.descriptorIdHex,
          queryHops: hdr.hops,
          remoteHost: qh.ip,
          remotePort: qh.port,
          speedKBps: qh.speedKBps,
          fileIndex: r.fileIndex,
          fileName: r.fileName,
          fileSize: r.fileSize,
          serventIdHex: qh.serventIdHex,
          viaPeerKey: peer.key,
          sha1Urn: r.urns.find((x) =>
            x.toLowerCase().startsWith("urn:sha1:"),
          ),
          urns: r.urns,
          metadata: r.metadata,
          vendorCode: qh.vendorCode,
          needsPush: qh.flagPush,
          busy: qh.flagBusy,
        };
        this.lastResults.push(hit);
        this.emitEvent({ type: "QUERY_RESULT", at: ts(), hit });
      }
      return;
    }
    this.forwardToRoute(
      route,
      TYPE.QUERY_HIT,
      hdr.descriptorId,
      hdr.ttl,
      hdr.hops,
      payload,
    );
  }

  async onPush(_peer: Peer, hdr: any, payload: Buffer): Promise<void> {
    const push = parsePush(payload);
    if (push.serventIdHex === this.serventId.toString("hex")) {
      await this.fulfillPush(push);
      return;
    }
    const route = this.pushRoutes.get(push.serventIdHex);
    if (!route) return;
    this.forwardToRoute(
      route,
      TYPE.PUSH,
      hdr.descriptorId,
      hdr.ttl,
      hdr.hops,
      payload,
    );
  }

  onBye(peer: Peer, payload: Buffer): void {
    try {
      parseBye(payload);
    } catch {
      // ignore parse failure and close anyway
    }
    peer.socket.end();
  }

  async fulfillPush(push: ReturnType<typeof parsePush>): Promise<void> {
    const share = this.sharesByIndex.get(push.fileIndex);
    if (!share) return;
    this.emitEvent({
      type: "PUSH_REQUESTED",
      at: ts(),
      fileIndex: share.index,
      fileName: share.name,
      ip: push.ip,
      port: push.port,
    });
    const socket = net.createConnection({
      host: push.ip,
      port: push.port,
    });
    socket.setNoDelay(true);
    socket.setTimeout(this.config().downloadTimeoutMs, () =>
      socket.destroy(new Error("push connect timeout")),
    );
    socket.on("error", (e) =>
      this.emitEvent({
        type: "PUSH_CALLBACK_FAILED",
        at: ts(),
        message: errMsg(e),
      }),
    );
    socket.on("connect", () => {
      socket.write(
        `GIV ${share.index}:${this.serventId.toString("hex")}/${share.name}\n\n`,
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
      this.startHttpSession(socket, head, rest);
    };
    socket.on("data", onData);
  }

  async handleIncomingGet(
    socket: net.Socket,
    head: string,
  ): Promise<boolean> {
    const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
    let m =
      /^(GET|HEAD)\s+\/get\/(\d+)\/(.+?)(?:\/)?\s+HTTP\/(\d+\.\d+)$/i.exec(
        first,
      );
    if (m) {
      const fileIndex = Number(m[2]);
      const share = this.sharesByIndex.get(fileIndex);
      if (!share) {
        socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
        return false;
      }
      return await this.handleExistingGet(socket, head, share.abs, share);
    }
    m = /^(GET|HEAD)\s+\/uri-res\/N2R\?([^\s]+)\s+HTTP\/(\d+\.\d+)$/i.exec(
      first,
    );
    if (m && this.config().serveUriRes) {
      const urn = decodeURIComponent(m[2]).toLowerCase();
      const share = this.sharesByUrn.get(urn);
      if (!share) {
        socket.end("HTTP/1.0 404 Not Found\r\n\r\n");
        return false;
      }
      return await this.handleExistingGet(socket, head, share.abs, share);
    }
    socket.end("HTTP/1.0 400 Bad Request\r\n\r\n");
    return false;
  }

  async handleExistingGet(
    socket: net.Socket,
    head: string,
    absPath: string,
    share?: ShareFile,
  ): Promise<boolean> {
    const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
    const method =
      /^(GET|HEAD)\s+/i.exec(first)?.[1]?.toUpperCase() || "GET";
    const httpVersion =
      /^([A-Z]+)\s+\S+\s+HTTP\/(\d+\.\d+)$/i.exec(first)?.[2] || "1.0";
    const responseVersion =
      httpVersion === "1.1" ? "HTTP/1.1" : "HTTP/1.0";
    const headers = parseHttpHeaders(head);
    const keepAlive = !hasToken(headers["connection"], "close");
    const st = await fsp.stat(absPath);
    const range = parseByteRange(headers["range"], st.size);
    if (!range) {
      socket.write(
        [
          `${responseVersion} 416 Range Not Satisfiable`,
          "Server: Gnutella",
          "Content-Type: application/binary",
          "Content-Length: 0",
          `Content-Range: bytes */${st.size}`,
          `Connection: ${keepAlive ? "Keep-Alive" : "close"}`,
          "",
          "",
        ].join("\r\n"),
      );
      if (!keepAlive) socket.end();
      return keepAlive;
    }
    const remaining =
      range.end >= range.start ? range.end - range.start + 1 : 0;
    const status = range.partial
      ? `${responseVersion} 206 Partial Content`
      : `${responseVersion} 200 OK`;
    const headersOut = [
      status,
      "Server: Gnutella",
      "Content-Type: application/binary",
      `Content-Length: ${remaining}`,
      ...(range.partial
        ? [`Content-Range: bytes ${range.start}-${range.end}/${st.size}`]
        : []),
      ...(share ? [`X-Gnutella-Content-URN: ${share.sha1Urn}`] : []),
      `Connection: ${keepAlive ? "Keep-Alive" : "close"}`,
      "",
      "",
    ].join("\r\n");
    socket.write(headersOut);
    if (method === "HEAD") {
      if (!keepAlive) socket.end();
      return keepAlive;
    }
    if (remaining === 0) {
      if (!keepAlive) socket.end();
      return keepAlive;
    }
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
      const fail = (e: any) => {
        if (done) return;
        done = true;
        cleanup();
        reject(e);
      };
      const onError = (e: any) => fail(e);
      const onSocketError = (e: any) => fail(e);
      const onClose = () => finish();
      const onEnd = () => {
        if (!keepAlive && !socket.destroyed) socket.end();
        finish();
      };
      rs.on("error", onError);
      rs.on("end", onEnd);
      socket.once("close", onClose);
      socket.once("error", onSocketError);
      rs.pipe(socket, { end: false });
    });
    return keepAlive;
  }

  async handleIncomingGiv(socket: net.Socket, giv: string): Promise<void> {
    const text = giv.replace(/\r\n/g, "\n");
    const m = /^GIV\s+\d+:([0-9a-fA-F]{32})\/.+\n\n$/s.exec(text);
    if (!m) {
      socket.destroy();
      return;
    }
    const serventIdHex = m[1].toLowerCase();
    const pending = this.shiftPendingPush(serventIdHex);
    if (!pending) {
      socket.destroy();
      return;
    }
    try {
      const result = await this.downloadOverSocket(
        socket,
        pending.result.fileIndex,
        pending.result.fileName,
        pending.destPath,
      );
      pending.resolve(result);
    } catch (e) {
      pending.reject(e);
    }
  }

  async downloadOverSocket(
    socket: net.Socket,
    fileIndex: number,
    fileName: string,
    destPath: string,
  ): Promise<any> {
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
    const result = await this.readHttpDownload(
      socket,
      destPath,
      `${socket.remoteAddress || "?"}:${socket.remotePort || "?"}`,
      existing,
    );
    if (
      !socket.destroyed &&
      !(socket as any).writableEnded &&
      !(socket as any).ended
    )
      socket.end();
    return result;
  }

  async directDownloadViaRequest(
    host: string,
    port: number,
    request: string,
    destPath: string,
    existing: number,
  ): Promise<any> {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(this.config().downloadTimeoutMs, () =>
      socket.destroy(new Error("download timeout")),
    );
    await new Promise<void>((resolve, reject) => {
      const onError = (e: any) => {
        socket.removeListener("connect", onConnect);
        reject(e);
      };
      const onConnect = () => {
        socket.removeListener("error", onError);
        socket.write(request);
        resolve();
      };
      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    const result = await this.readHttpDownload(
      socket,
      destPath,
      `${host}:${port}`,
      existing,
    );
    if (
      !socket.destroyed &&
      !(socket as any).writableEnded &&
      !(socket as any).ended
    )
      socket.end();
    return result;
  }

  async directDownload(hit: SearchHit, destPath: string): Promise<any> {
    await ensureDir(path.dirname(destPath));
    const existing = (await fileExists(destPath))
      ? (await fsp.stat(destPath)).size
      : 0;
    if (hit.sha1Urn && this.config().serveUriRes) {
      try {
        return await this.directDownloadViaRequest(
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
    return await this.directDownloadViaRequest(
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

  async readHttpDownload(
    socket: net.Socket,
    destPath: string,
    label: string,
    requestedStart: number,
  ): Promise<any> {
    return await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let headerDone = false;
      let remaining = 0;
      let ws: fs.WriteStream | null = null;
      let finalStart = requestedStart;
      let bodyBytes = 0;
      let done = false;
      const cleanup = () => {
        socket.off("error", onError);
        socket.off("data", onData);
        socket.off("end", onEnd);
        ws?.off("error", onWriteError);
      };
      const fail = (e: any) => {
        if (done) return;
        done = true;
        cleanup();
        try {
          ws?.destroy();
        } catch {
          // ignore
        }
        socket.destroy();
        reject(e);
      };
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        const meta = { destPath, bytes: finalStart + bodyBytes, label };
        if (!ws) {
          resolve(meta);
          return;
        }
        ws.end(() => {
          resolve(meta);
        });
      };
      const onWriteError = (e: any) => fail(e);
      const onError = (e: any) => fail(e);
      const onData = (chunk: string | Buffer) => {
        if (done) return;
        buf = Buffer.concat([buf, toBuffer(chunk)]);
        if (!headerDone) {
          const raw = buf.toString("latin1");
          const cut = findHeaderEnd(raw);
          if (cut === -1) return;
          headerDone = true;
          const head = raw.slice(0, cut);
          const first = head.replace(/\r\n/g, "\n").split("\n", 1)[0];
          const m = /^HTTP\/(\d+\.\d+)\s+(\d+)/i.exec(first);
          if (!m) return fail(new Error("invalid HTTP response"));
          const status = Number(m[2]);
          const headers = parseHttpHeaders(head);
          remaining = Number(headers["content-length"] || NaN);
          if (!Number.isFinite(remaining) || remaining < 0)
            return fail(new Error("missing Content-length"));
          if (status === 206) {
            const mRange = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(
              headers["content-range"] || "",
            );
            finalStart = mRange ? Number(mRange[1]) : requestedStart;
          } else if (status === 200) finalStart = 0;
          else return fail(new Error(`unexpected HTTP status ${status}`));
          ws = fs.createWriteStream(destPath, {
            flags: finalStart > 0 ? "r+" : "w",
            start: finalStart,
          });
          ws.on("error", onWriteError);
          buf = buf.subarray(cut);
        }
        if (!ws) return;
        const take = Math.min(remaining, buf.length);
        if (take > 0) {
          const chunkOut = buf.subarray(0, take);
          ws.write(chunkOut);
          bodyBytes += chunkOut.length;
          remaining -= take;
          buf = buf.subarray(take);
        }
        if (headerDone && remaining === 0) finish();
      };
      const onEnd = () => {
        if (!done && headerDone && remaining === 0) finish();
        else if (!done)
          fail(new Error("connection closed before full body received"));
      };
      socket.on("error", onError);
      socket.on("data", onData);
      socket.on("end", onEnd);
    });
  }

  async sendPush(hit: SearchHit, destPath: string): Promise<any> {
    const route = this.pushRoutes.get(hit.serventIdHex);
    if (!route) throw new Error("no push route for servent");
    const peer = this.peers.get(route.peerKey);
    if (!peer) throw new Error("push route peer not connected");
    const payload = encodePush(
      rawHex16(hit.serventIdHex),
      hit.fileIndex,
      this.config().advertisedHost,
      this.config().advertisedPort,
    );
    const descId = randomId16();
    const p = new Promise((resolve, reject) => {
      this.enqueuePendingPush({
        serventIdHex: hit.serventIdHex,
        result: hit,
        destPath,
        createdAt: Date.now(),
        resolve,
        reject,
      });
    });
    this.sendToPeer(
      peer,
      TYPE.PUSH,
      descId,
      Math.max(1, hit.queryHops + 2),
      0,
      payload,
    );
    return await p;
  }

  async downloadResult(
    resultNo: number,
    destOverride?: string,
  ): Promise<void> {
    const hit = this.lastResults.find((x) => x.resultNo === resultNo);
    if (!hit) throw new Error(`no such result ${resultNo}`);
    const destPath = path.resolve(
      destOverride ||
        path.join(this.config().downloadsDir, safeFileName(hit.fileName)),
    );
    try {
      await this.directDownload(hit, destPath);
      this.emitEvent({
        type: "DOWNLOAD_SUCCEEDED",
        at: ts(),
        mode: "direct",
        resultNo: hit.resultNo,
        fileName: hit.fileName,
        destPath,
        remoteHost: hit.remoteHost,
        remotePort: hit.remotePort,
      });
      this.downloads.push({
        at: ts(),
        fileName: hit.fileName,
        bytes: hit.fileSize,
        host: hit.remoteHost,
        port: hit.remotePort,
        mode: "direct",
        destPath,
      });
      return;
    } catch (e) {
      this.emitEvent({
        type: "DOWNLOAD_DIRECT_FAILED",
        at: ts(),
        resultNo: hit.resultNo,
        fileName: hit.fileName,
        destPath,
        remoteHost: hit.remoteHost,
        remotePort: hit.remotePort,
        message: errMsg(e),
      });
    }
    await this.sendPush(hit, destPath);
    this.emitEvent({
      type: "DOWNLOAD_SUCCEEDED",
      at: ts(),
      mode: "push",
      resultNo: hit.resultNo,
      fileName: hit.fileName,
      destPath,
      remoteHost: hit.remoteHost,
      remotePort: hit.remotePort,
    });
    this.downloads.push({
      at: ts(),
      fileName: hit.fileName,
      bytes: hit.fileSize,
      host: hit.remoteHost,
      port: hit.remotePort,
      mode: "push",
      destPath,
    });
  }

  sendPing(ttl: number): void {
    if (!this.peers.size) return;
    const descriptorId = randomId16();
    const hex = descriptorId.toString("hex");
    this.markSeen(TYPE.PING, hex);
    this.pingRoutes.set(hex, LOCAL_ROUTE);
    this.broadcast(
      TYPE.PING,
      descriptorId,
      Math.max(0, Math.min(ttl, this.config().maxTtl)),
      0,
      Buffer.alloc(0),
    );
    this.emitEvent({
      type: "PING_SENT",
      at: ts(),
      descriptorIdHex: hex,
      ttl,
    });
  }

  sendQuery(search: string, ttl = this.config().defaultQueryTtl): void {
    if (!this.peers.size) {
      this.emitEvent({
        type: "QUERY_SKIPPED",
        at: ts(),
        reason: "NO_PEERS_CONNECTED",
      });
      return;
    }
    const descriptorId = randomId16();
    const hex = descriptorId.toString("hex");
    this.markSeen(TYPE.QUERY, hex);
    this.queryRoutes.set(hex, LOCAL_ROUTE);
    const payload = encodeQuery(search, {
      ggepHAllowed: !!this.config().enableGgep,
      maxHits: Math.min(0x1ff, this.config().maxResultsPerQuery),
    });
    this.broadcastQuery(
      descriptorId,
      Math.min(this.config().maxTtl, ttl),
      0,
      payload,
      search,
    );
    this.emitEvent({
      type: "QUERY_SENT",
      at: ts(),
      descriptorIdHex: hex,
      ttl,
      search,
    });
  }

  getPeers(): PeerInfo[] {
    return [...this.peers.values()].map((peer) => this.peerInfo(peer));
  }

  getShares(): ShareFile[] {
    return [...this.shares];
  }

  getResults(): SearchHit[] {
    return [...this.lastResults];
  }

  clearResults(): void {
    this.lastResults = [];
    this.resultSeq = 1;
  }

  getKnownPeers(): string[] {
    return [...this.doc.config.peers];
  }

  getDownloads(): DownloadRecord[] {
    return [...this.downloads];
  }

  getServentIdHex(): string {
    return this.serventId.toString("hex");
  }

  getStatus(): NodeStatus {
    return {
      peers: this.peers.size,
      shares: this.shares.length,
      results: this.lastResults.length,
      knownPeers: this.doc.config.peers.length,
    };
  }

  async connectKnownPeers(): Promise<void> {
    const c = this.config();
    const bootstrapTimeoutMs = Math.max(
      1,
      Math.floor(c.connectTimeoutMs / BOOTSTRAP_CONNECT_TIMEOUT_DIVISOR),
    );
    const self = normalizePeer(c.advertisedHost, c.advertisedPort);
    const candidates = unique(c.peers)
      .map((peer) => parsePeer(peer))
      .filter(
        (addr): addr is PeerAddr =>
          !!addr && normalizePeer(addr.host, addr.port) !== self,
      );
    const availableSlots = Math.max(
      0,
      c.maxConnections - this.peerCount() - this.dialing.size,
    );
    const workerCount = Math.min(
      BOOTSTRAP_CONNECT_CONCURRENCY,
      availableSlots,
      candidates.length,
    );
    if (!workerCount) return;

    let next = 0;
    const dialNext = async (): Promise<void> => {
      while (next < candidates.length) {
        if (this.peerCount() + this.dialing.size >= c.maxConnections)
          return;
        const addr = candidates[next++];
        await this.connectPeer(
          addr.host,
          addr.port,
          bootstrapTimeoutMs,
        ).catch(() => void 0);
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, () => dialNext()),
    );
  }

  async connectPeer(
    host: string,
    port: number,
    timeoutMs = this.config().connectTimeoutMs,
  ): Promise<void> {
    const target = normalizePeer(host, port);
    if (this.dialing.has(target)) return;
    for (const peer of this.peers.values()) {
      if (peer.dialTarget === target) return;
      if (
        peer.capabilities.listenIp &&
        normalizePeer(
          peer.capabilities.listenIp.host,
          peer.capabilities.listenIp.port,
        ) === target
      )
        return;
    }
    this.dialing.add(target);
    try {
      await this.connectPeer06(host, port, timeoutMs);
      this.addKnownPeer(host, port);
    } finally {
      this.dialing.delete(target);
    }
  }

  async connectPeer06(
    host: string,
    port: number,
    timeoutMs = this.config().connectTimeoutMs,
  ): Promise<void> {
    const c = this.config();
    const target = normalizePeer(host, port);
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      socket.setNoDelay(true);
      socket.setTimeout(timeoutMs, () =>
        socket.destroy(new Error("connect timeout")),
      );
      let decided = false;
      let buf = Buffer.alloc(0);
      const fail = (e: any) => {
        if (decided) return;
        decided = true;
        socket.destroy();
        reject(e);
      };
      socket.on("error", fail);
      socket.on("connect", () =>
        socket.write(
          buildHandshakeBlock(
            "GNUTELLA CONNECT/0.6",
            this.baseHandshakeHeaders(),
          ),
        ),
      );
      socket.on("data", (chunk) => {
        if (decided) return;
        buf = Buffer.concat([buf, toBuffer(chunk)]);
        const raw = buf.toString("latin1");
        const cut = findHeaderEnd(raw);
        if (cut === -1) return;
        const { startLine, headers } = parseHandshakeBlock(
          raw.slice(0, cut),
        );
        this.maybeAbsorbTryHeaders(headers);
        if (
          /^GNUTELLA OK/i.test(startLine) ||
          /^GNUTELLA\/0\.4 200/i.test(startLine)
        )
          return fail(
            new Error(
              `unsupported legacy handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
            ),
          );
        const m = /^GNUTELLA\/0\.([0-9]+)\s+(\d+)/i.exec(startLine);
        if (!m)
          return fail(
            new Error(
              `unexpected handshake response from ${target}: ${describeHandshakeResponse(startLine, headers)}`,
            ),
          );
        const code = Number(m[2]);
        if (code !== 200)
          return fail(
            new Error(
              `0.6 handshake rejected by ${target}: ${describeHandshakeResponse(startLine, headers)}`,
            ),
          );
        const finalHeaders = this.buildClientFinalHeaders(headers);
        const compressIn =
          hasToken(headers["content-encoding"], "deflate") &&
          !!c.enableCompression;
        const compressOut =
          hasToken(finalHeaders["content-encoding"], "deflate") &&
          !!c.enableCompression;
        socket.write(
          buildHandshakeBlock(`GNUTELLA/0.6 200 OK`, finalHeaders),
        );
        decided = true;
        const rest = buf.subarray(cut);
        const caps = this.buildCapabilities(
          `0.${m[1]}`,
          mergeHeaders(headers, finalHeaders),
          compressIn,
          compressOut,
        );
        this.attachPeer(socket, true, target, caps, rest, target);
        resolve();
      });
    });
  }
}
