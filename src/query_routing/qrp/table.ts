import zlib from "node:zlib";

import {
  DEFAULT_QRP_ENTRY_BITS,
  DEFAULT_QRP_INFINITY,
  DEFAULT_QRP_TABLE_SIZE,
  QRP_COMPRESSOR_DEFLATE,
} from "./constants";
import { qrpHash } from "./hash";
import {
  applyPresencePatchValue,
  encodeSignedPatchValue,
  flipPresencePatchValue,
} from "./patch_values";
import {
  qrpIndexTerms,
  qrpPresenceHit,
  qrpQueryTerms,
  qrpTermsMatch,
} from "./terms";
import type { QrpIndexSource, RemoteQrpState } from "./types";

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

  rebuildFromShares(shares: QrpIndexSource[]): void {
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
    return qrpTermsMatch(kws, (kw) =>
      qrpPresenceHit(this.table[this.hashKeyword(kw)], this.infinity),
    );
  }

  mergePresenceTable(
    table: Uint8Array,
    infinity: number,
    tableSize = table.length,
  ): void {
    const sourceSize = Math.min(table.length, tableSize);
    if (sourceSize <= 0) return;
    for (let i = 0; i < sourceSize; i++) {
      if (!qrpPresenceHit(table[i], infinity)) continue;
      const start = Math.max(
        0,
        Math.floor((i * this.tableSize) / sourceSize),
      );
      const end = Math.min(
        this.tableSize,
        Math.max(
          start + 1,
          Math.ceil(((i + 1) * this.tableSize) / sourceSize),
        ),
      );
      for (let j = start; j < end; j++) this.table[j] = 1;
    }
  }

  mergeFromQrp(
    other: Pick<QrpTable, "table" | "infinity" | "tableSize">,
  ): void {
    this.mergePresenceTable(other.table, other.infinity, other.tableSize);
  }

  mergeFromRemoteQrp(state: RemoteQrpState): void {
    if (!state.table) return;
    this.mergePresenceTable(state.table, state.infinity, state.tableSize);
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

  static expectedPackedPatchBytes(
    state: RemoteQrpState,
  ): number | undefined {
    if (state.entryBits === 1) return Math.ceil(state.tableSize / 8);
    if (state.entryBits === 4) return Math.ceil(state.tableSize / 2);
    if (state.entryBits === 8) return state.tableSize;
    return undefined;
  }

  static packedPatchCoverageError(
    state: RemoteQrpState,
    packed: Buffer,
  ): string | undefined {
    const expectedBytes = QrpTable.expectedPackedPatchBytes(state);
    if (expectedBytes == null || packed.length >= expectedBytes)
      return undefined;
    const coveredSlots = Math.floor((packed.length * 8) / state.entryBits);
    return `Incomplete ${state.entryBits}-bit QRP patch covered ${coveredSlots}/${state.tableSize} slots`;
  }

  static applyPatch(state: RemoteQrpState): string | undefined {
    if (!QrpTable.canApplyPatch(state)) return undefined;
    const rawParts = QrpTable.orderedPatchParts(state);
    if (!rawParts) return undefined;
    let packed = Buffer.concat(rawParts);
    if (state.compressor === QRP_COMPRESSOR_DEFLATE)
      packed = zlib.inflateSync(packed);
    const coverageError = QrpTable.packedPatchCoverageError(state, packed);
    if (coverageError) return coverageError;
    const table = QrpTable.unpackRemoteTable(state, packed);
    if (!table) return undefined;
    state.table = table;
    state.parts.clear();
    state.seqSize = 0;
    return undefined;
  }

  static matchesRemote(state: RemoteQrpState, search: string): boolean {
    if (!state.table || !state.tableSize) return true;
    const kws = qrpQueryTerms(search);
    const bits = Math.log2(state.tableSize);
    return qrpTermsMatch(kws, (kw) =>
      qrpPresenceHit(state.table![qrpHash(kw, bits)], state.infinity),
    );
  }

  static remoteHasTerm(state: RemoteQrpState, term: string): boolean {
    if (!state.table || !state.tableSize) return false;
    const bits = Math.log2(state.tableSize);
    return qrpPresenceHit(
      state.table[qrpHash(term, bits)],
      state.infinity,
    );
  }
}
