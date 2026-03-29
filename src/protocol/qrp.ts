import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";

import {
  DEFAULT_QRP_ENTRY_BITS,
  DEFAULT_QRP_INFINITY,
  DEFAULT_QRP_TABLE_SIZE,
  QRP_COMPRESSOR_DEFLATE,
  QRP_COMPRESSOR_NONE,
  QRP_HASH_MULTIPLIER,
} from "../const";
import type { QueryDescriptor, RemoteQrpState, ShareFile } from "../types";
import { base32Encode } from "./content_urn";

export function splitSearchTerms(input: string): string[] {
  const ascii = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return ascii.split(/[^a-z0-9]+/).filter(Boolean);
}

export function tokenizeKeywords(input: string): string[] {
  return [...new Set(splitSearchTerms(input).filter((x) => x.length > 1))];
}

function qrpQueryTerms(input: string): string[] {
  return [
    ...new Set(splitSearchTerms(input).filter((x) => x.length >= 3)),
  ];
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

export function sha1ToUrn(sha1: Buffer): string {
  return `urn:sha1:${base32Encode(sha1)}`;
}

export async function sha1File(abs: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const rs = fs.createReadStream(abs);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("error", reject);
    rs.on("end", () => resolve(hash.digest()));
  });
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

  mergePresenceTable(table: Uint8Array, infinity: number): void {
    const length = Math.min(this.table.length, table.length);
    for (let i = 0; i < length; i++) {
      if (table[i] < infinity) this.table[i] = 1;
    }
  }

  mergeFromQrp(other: Pick<QrpTable, "table" | "infinity">): void {
    this.mergePresenceTable(other.table, other.infinity);
  }

  mergeFromRemoteQrp(state: RemoteQrpState): void {
    if (!state.table) return;
    this.mergePresenceTable(state.table, state.infinity);
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
    if (this.entryBits === 1) return this.packOneBitTable();
    if (this.entryBits === 4) return this.packNibbleTable();
    throw new Error(`unsupported QRP entry bits ${this.entryBits}`);
  }

  packOneBitTable(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.tableSize / 8));
    for (let i = 0; i < this.tableSize; i++) {
      const byteIdx = i >> 3;
      const bit = 7 - (i & 7);
      if (this.table[i] < this.infinity) out[byteIdx] |= 1 << bit;
    }
    return out;
  }

  packNibbleTable(): Buffer {
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

  static canApplyPatch(state: RemoteQrpState): boolean {
    return (
      state.resetSeen &&
      state.parts.size === state.seqSize &&
      state.seqSize > 0
    );
  }

  static orderedPatchParts(state: RemoteQrpState): Buffer[] | undefined {
    const rawParts: Buffer[] = [];
    for (let i = 1; i <= state.seqSize; i++) {
      const part = state.parts.get(i);
      if (!part) return undefined;
      rawParts.push(part);
    }
    return rawParts;
  }

  static createUnpackedTable(state: RemoteQrpState): Uint8Array {
    const table = new Uint8Array(state.tableSize);
    table.fill(state.infinity);
    return table;
  }

  static unpackOneBitTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array {
    const table = QrpTable.createUnpackedTable(state);
    for (let i = 0; i < state.tableSize; i++) {
      const byteIdx = i >> 3;
      const bit = 7 - (i & 7);
      const present =
        byteIdx < packed.length && !!(packed[byteIdx] & (1 << bit));
      table[i] = present ? 1 : state.infinity;
    }
    return table;
  }

  static unpackNibbleTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array {
    const table = QrpTable.createUnpackedTable(state);
    for (let i = 0; i < state.tableSize; i++) {
      const byteIdx = i >> 1;
      if (byteIdx >= packed.length) break;
      const nibble =
        (i & 1) === 0
          ? (packed[byteIdx] >> 4) & 0x0f
          : packed[byteIdx] & 0x0f;
      table[i] = nibble;
    }
    return table;
  }

  static unpackRemoteTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array | undefined {
    if (state.entryBits === 1)
      return QrpTable.unpackOneBitTable(state, packed);
    if (state.entryBits === 4)
      return QrpTable.unpackNibbleTable(state, packed);
    return undefined;
  }

  static applyPatch(state: RemoteQrpState): void {
    if (!QrpTable.canApplyPatch(state)) return;
    const rawParts = QrpTable.orderedPatchParts(state);
    if (!rawParts) return;
    let packed = Buffer.concat(rawParts);
    if (state.compressor === QRP_COMPRESSOR_DEFLATE)
      packed = zlib.inflateSync(packed);
    const table = QrpTable.unpackRemoteTable(state, packed);
    if (!table) return;
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

export function matchQuery(
  q: QueryDescriptor,
  share: Pick<ShareFile, "name" | "sha1Urn" | "keywords">,
): boolean {
  if (q.urns.length) {
    if (!share.sha1Urn) return false;
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

function canRouteQrpQuery(
  q: Pick<QueryDescriptor, "search" | "urns">,
  matchesSearch: (search: string) => boolean,
): boolean {
  if (q.urns.length) return true;
  return matchesSearch(q.search);
}

export function canRouteRemoteQrpQuery(
  state: RemoteQrpState,
  q: Pick<QueryDescriptor, "search" | "urns">,
): boolean {
  return canRouteQrpQuery(q, (search) =>
    QrpTable.matchesRemote(state, search),
  );
}
