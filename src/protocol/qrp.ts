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

const QRP_MIN_WORD_LENGTH = 3;
const QRP_MAX_CUT_CHARS = 5;

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
    ...new Set(
      splitSearchTerms(input).filter(
        (x) => x.length >= QRP_MIN_WORD_LENGTH,
      ),
    ),
  ];
}

function qrpIndexTerms(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const term of qrpQueryTerms(input)) {
    let candidate = term;
    for (let trim = 0; trim <= QRP_MAX_CUT_CHARS; trim++) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
      if (candidate.length <= QRP_MIN_WORD_LENGTH) break;
      const next = candidate.slice(0, -1);
      if (next.length <= QRP_MIN_WORD_LENGTH) break;
      candidate = next;
    }
  }
  return out;
}

function qrpWordHitThreshold(hit: number, word: number): boolean {
  return word < 3 ? hit === word : Math.trunc((3 * hit) / word) >= 2;
}

function qrpTermsMatch(
  terms: string[],
  hasTerm: (term: string) => boolean,
): boolean {
  if (!terms.length) return true;
  let hit = 0;
  for (const term of terms) {
    if (hasTerm(term)) hit++;
  }
  return qrpWordHitThreshold(hit, terms.length);
}

function encodeSignedPatchValue(delta: number, bits: number): number {
  const signBit = 1 << (bits - 1);
  const min = -signBit;
  const max = signBit - 1;
  if (delta < min || delta > max)
    throw new Error(`QRP ${bits}-bit patch delta out of range ${delta}`);
  return delta & ((1 << bits) - 1);
}

function applyPresencePatchValue(
  current: number,
  infinity: number,
  encoded: number,
  bits: number,
): number {
  if (encoded === 0) return current;
  const signBit = 1 << (bits - 1);
  return encoded & signBit ? 1 : infinity;
}

function flipPresencePatchValue(
  current: number,
  infinity: number,
): number {
  return current < infinity ? infinity : 1;
}

function qrpHashBytes(str: string): number[] {
  const bytes: number[] = [];
  for (const char of str) {
    let codePoint = char.codePointAt(0) ?? 0;
    if (codePoint >= 0x41 && codePoint <= 0x5a) codePoint += 0x20;
    if (codePoint <= 0xffff) {
      bytes.push(codePoint & 0xff);
      continue;
    }
    const value = codePoint - 0x10000;
    const high = 0xd800 + (value >> 10);
    const low = 0xdc00 + (value & 0x3ff);
    bytes.push(high & 0xff, low & 0xff);
  }
  return bytes;
}

function qrpHash(str: string, bits: number): number {
  const bytes = qrpHashBytes(str);
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
    return qrpTermsMatch(
      kws,
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
    if (this.entryBits === 8) return this.packByteTable();
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
      const delta =
        this.table[i] < this.infinity ? this.table[i] - this.infinity : 0;
      const nibble = encodeSignedPatchValue(delta, 4);
      const byteIdx = i >> 1;
      if ((i & 1) === 0)
        out[byteIdx] = (out[byteIdx] & 0x0f) | (nibble << 4);
      else out[byteIdx] = (out[byteIdx] & 0xf0) | nibble;
    }
    return out;
  }

  packByteTable(): Buffer {
    const out = Buffer.alloc(this.tableSize);
    for (let i = 0; i < this.tableSize; i++) {
      const delta =
        this.table[i] < this.infinity ? this.table[i] - this.infinity : 0;
      out[i] = encodeSignedPatchValue(delta, 8);
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

  static mutablePatchTable(state: RemoteQrpState): Uint8Array {
    return state.table?.slice() ?? QrpTable.createUnpackedTable(state);
  }

  static unpackOneBitTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array {
    const table = QrpTable.mutablePatchTable(state);
    for (let i = 0; i < state.tableSize; i++) {
      const byteIdx = i >> 3;
      const bit = 7 - (i & 7);
      if (byteIdx < packed.length && packed[byteIdx] & (1 << bit))
        table[i] = flipPresencePatchValue(table[i], state.infinity);
    }
    return table;
  }

  static unpackNibbleTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array {
    const table = QrpTable.mutablePatchTable(state);
    for (let i = 0; i < state.tableSize; i++) {
      const byteIdx = i >> 1;
      if (byteIdx >= packed.length) break;
      const nibble =
        (i & 1) === 0
          ? (packed[byteIdx] >> 4) & 0x0f
          : packed[byteIdx] & 0x0f;
      table[i] = applyPresencePatchValue(
        table[i],
        state.infinity,
        nibble,
        4,
      );
    }
    return table;
  }

  static unpackByteTable(
    state: RemoteQrpState,
    packed: Buffer,
  ): Uint8Array {
    const table = QrpTable.mutablePatchTable(state);
    for (let i = 0; i < state.tableSize; i++) {
      if (i >= packed.length) break;
      table[i] = applyPresencePatchValue(
        table[i],
        state.infinity,
        packed[i],
        8,
      );
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
    if (state.entryBits === 8)
      return QrpTable.unpackByteTable(state, packed);
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
    const bits = Math.log2(state.tableSize);
    return qrpTermsMatch(
      kws,
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
