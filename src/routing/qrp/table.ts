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

/** Stores keyword presence and encodes QRP updates. */
export class QrpTable {
  tableSize: number;
  infinity: number;
  entryBits: number;
  table: Uint8Array;

  /** Create an empty table with the chosen encoding. */
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

  /** Mark every keyword slot absent. */
  clear(): void {
    this.table.fill(this.infinity);
  }

  /** Rebuild keyword presence from shared files. */
  rebuildFromShares(shares: QrpIndexSource[]): void {
    this.clear();
    for (const share of shares) {
      for (const kw of share.keywords) {
        for (const term of qrpIndexTerms(kw))
          this.table[this.hashKeyword(term)] = 1;
      }
    }
  }

  /** Hash a keyword into this table. */
  hashKeyword(keyword: string): number {
    return qrpHash(keyword, Math.log2(this.tableSize));
  }

  /** Check whether this table may match a query. */
  matchesQuery(search: string): boolean {
    const kws = qrpQueryTerms(search);
    return qrpTermsMatch(kws, (kw) =>
      qrpPresenceHit(this.table[this.hashKeyword(kw)], this.infinity),
    );
  }

  /** Merge presence bits, rescaling table slots as needed. */
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

  /** Merge another local QRP table. */
  mergeFromQrp(
    other: Pick<QrpTable, "table" | "infinity" | "tableSize">,
  ): void {
    this.mergePresenceTable(other.table, other.infinity, other.tableSize);
  }

  /** Merge an available remote QRP table. */
  mergeFromRemoteQrp(state: RemoteQrpState): void {
    if (!state.table) return;
    this.mergePresenceTable(state.table, state.infinity, state.tableSize);
  }

  /** Encode this table's QRP reset message. */
  encodeReset(): Buffer {
    const payload = Buffer.alloc(6);
    payload[0] = 0x00;
    payload.writeUInt32LE(this.tableSize, 1);
    payload[5] = this.infinity;
    return payload;
  }

  /** Compress and split the table into QRP patches. */
  encodePatchChunks(
    maxChunkPayload: number,
    entryBits = this.entryBits,
  ): Buffer[] {
    const packed = this.packTable(entryBits);
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
      payload[4] = entryBits;
      parts[i].copy(payload, 5);
      chunks.push(payload);
    }
    return chunks;
  }

  /** Pack table entries at the requested bit width. */
  packTable(entryBits = this.entryBits): Buffer {
    if (entryBits === 1) return this.packOneBitTable();
    if (entryBits === 4) return this.packNibbleTable();
    if (entryBits === 8) return this.packByteTable();
    throw new Error(`unsupported QRP entry bits ${entryBits}`);
  }

  /** Pack presence changes as single bits. */
  packOneBitTable(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.tableSize / 8));
    for (let i = 0; i < this.tableSize; i++) {
      const byteIdx = i >> 3;
      const bit = 7 - (i & 7);
      if (this.table[i] < this.infinity) out[byteIdx] |= 1 << bit;
    }
    return out;
  }

  /** Pack signed presence deltas as nibbles. */
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

  /** Pack signed presence deltas as bytes. */
  packByteTable(): Buffer {
    const out = Buffer.alloc(this.tableSize);
    for (let i = 0; i < this.tableSize; i++) {
      const delta =
        this.table[i] < this.infinity ? this.table[i] - this.infinity : 0;
      out[i] = encodeSignedPatchValue(delta, 8);
    }
    return out;
  }

  /** Check whether a complete patch sequence is buffered. */
  static canApplyPatch(state: RemoteQrpState): boolean {
    return (
      state.resetSeen &&
      state.parts.size === state.seqSize &&
      state.seqSize > 0
    );
  }

  /** Collect patch parts in sequence order. */
  static orderedPatchParts(state: RemoteQrpState): Buffer[] | undefined {
    const rawParts: Buffer[] = [];
    for (let i = 1; i <= state.seqSize; i++) {
      const part = state.parts.get(i);
      if (!part) return undefined;
      rawParts.push(part);
    }
    return rawParts;
  }

  /** Allocate a remote table with all slots absent. */
  static createUnpackedTable(state: RemoteQrpState): Uint8Array {
    const table = new Uint8Array(state.tableSize);
    table.fill(state.infinity);
    return table;
  }

  /** Copy the remote table or create an empty one. */
  static mutablePatchTable(state: RemoteQrpState): Uint8Array {
    return state.table?.slice() ?? QrpTable.createUnpackedTable(state);
  }

  /** Apply one-bit toggles to a copy of the remote table. */
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

  /** Apply nibble deltas to a copy of the remote table. */
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

  /** Apply byte deltas to a copy of the remote table. */
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

  /** Decode a patch using its negotiated bit width. */
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

  /** Calculate the bytes needed to cover every slot. */
  static expectedPackedPatchBytes(
    state: RemoteQrpState,
  ): number | undefined {
    if (state.entryBits === 1) return Math.ceil(state.tableSize / 8);
    if (state.entryBits === 4) return Math.ceil(state.tableSize / 2);
    if (state.entryBits === 8) return state.tableSize;
    return undefined;
  }

  /** Describe a patch that leaves table slots uncovered. */
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

  /** Apply a complete buffered patch to remote state. */
  static applyPatch(state: RemoteQrpState): string | undefined {
    if (!QrpTable.canApplyPatch(state)) return undefined;
    const rawParts = QrpTable.orderedPatchParts(state);
    if (!rawParts) return undefined;
    const expectedBytes = QrpTable.expectedPackedPatchBytes(state);
    if (expectedBytes == null || expectedBytes <= 0) return undefined;
    let packed = Buffer.concat(rawParts);
    if (state.compressor === QRP_COMPRESSOR_DEFLATE)
      packed = zlib.inflateSync(packed, {
        maxOutputLength: expectedBytes,
      });
    const coverageError = QrpTable.packedPatchCoverageError(state, packed);
    if (coverageError) return coverageError;
    const table = QrpTable.unpackRemoteTable(state, packed);
    if (!table) return undefined;
    state.table = table;
    state.parts.clear();
    state.seqSize = 0;
    return undefined;
  }

  /** Check a remote table, allowing queries before readiness. */
  static matchesRemote(state: RemoteQrpState, search: string): boolean {
    if (!state.table || !state.tableSize) return true;
    const kws = qrpQueryTerms(search);
    const bits = Math.log2(state.tableSize);
    return qrpTermsMatch(kws, (kw) =>
      qrpPresenceHit(state.table![qrpHash(kw, bits)], state.infinity),
    );
  }

  /** Check whether a remote table contains a term. */
  static remoteHasTerm(state: RemoteQrpState, term: string): boolean {
    if (!state.table || !state.tableSize) return false;
    const bits = Math.log2(state.tableSize);
    return qrpPresenceHit(
      state.table[qrpHash(term, bits)],
      state.infinity,
    );
  }
}
