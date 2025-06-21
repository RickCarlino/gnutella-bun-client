/**
 * Minimal QRP helpers (leaf-mode)
 *  – keyword tokenization & normalisation
 *  – FNV-1a hash → 16-bit index
 *  – bit-array QRT builder (64 Ki slots, 1 bit/slot)
 *  – RouteTableUpdate Reset & Patch payload builders
 *  – (optional) Descriptor wrapper for the wire
 *
 *  Works in Bun / Node ≥18 (for crypto.randomBytes).
 */

import { randomBytes } from "crypto";

const TABLE_SLOTS = 65_536; // 2¹⁶ – must be power-of-two
const ENTRY_BITS = 1; // we use 1-bit entries
const DESCR_ID_ROUTE_UPDATE = 0x30;

/* ──────────────────────────────────────────────────────────── *
 * 1.  Keyword Handling                                        *
 * ──────────────────────────────────────────────────────────── */

export function normalizeKeyword(word: string): string {
  return word
    .normalize("NFKD") // split accents
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks
    .toLowerCase();
}

export function tokenizeFilename(name: string): string[] {
  return name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
}

/* ──────────────────────────────────────────────────────────── *
 * 2.  FNV-1a (32-bit) → 16-bit index                         *
 *      – same hash most Gnutella impls use internally        *
 * ──────────────────────────────────────────────────────────── */

function fnv1a32(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = ((hash >>> 0) * 0x01000193) >>> 0; // FNV prime
  }
  return hash >>> 0;
}

function keywordIndex(word: string, slots = TABLE_SLOTS): number {
  return fnv1a32(word) & (slots - 1); // modulo power-of-two
}

/* ──────────────────────────────────────────────────────────── *
 * 3.  Build the 64 Ki-bit Bloom filter                        *
 * ──────────────────────────────────────────────────────────── */

export function buildQRTBits(files: string[]): Uint8Array {
  const bytes = new Uint8Array(TABLE_SLOTS >> 3); // 65 536 bits → 8 192 B

  const setBit = (idx: number) => {
    bytes[idx >> 3] |= 1 << (idx & 7);
  };

  for (const file of files) {
    for (const raw of tokenizeFilename(file)) {
      const kw = normalizeKeyword(raw);
      if (kw.length === 0) continue;
      setBit(keywordIndex(kw));
    }
  }
  return bytes;
}

/* ──────────────────────────────────────────────────────────── *
 * 4.  RouteTableUpdate payload builders                       *
 *      (Reset + single full Patch)                            *
 * ──────────────────────────────────────────────────────────── */

/** Reset = “clear table, expect 1 patch” */
export function qrpResetPayload(
  slots = TABLE_SLOTS,
  entryBits = ENTRY_BITS,
): Uint8Array {
  const buf = new Uint8Array(5 + 4); // 5-byte header + 4-byte table size
  buf.set([0x00, 0x00, 0x01, 0x00, entryBits]); // Variant, Seq#, Count, Comp, Bits
  buf[5] = slots & 0xff;
  buf[6] = (slots >> 8) & 0xff;
  buf[7] = (slots >> 16) & 0xff;
  buf[8] = (slots >> 24) & 0xff;
  return buf;
}

/** Patch = one chunk containing the whole bit-array */
export function qrpPatchPayload(
  bits: Uint8Array,
  entryBits = ENTRY_BITS,
): Uint8Array {
  const out = new Uint8Array(5 + bits.length);
  out.set([0x01, 0x01, 0x01, 0x00, entryBits]); // Variant, Seq#, Count, Comp, Bits
  out.set(bits, 5);
  return out;
}

/* ──────────────────────────────────────────────────────────── *
 * 5.  OPTIONAL: wrap payload in a Gnutella descriptor         *
 *      – returns a Buffer ready for socket.write()            *
 * ──────────────────────────────────────────────────────────── */

export function wrapDescriptor(descrId: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(23);
  randomBytes(16).copy(header, 0); // GUID
  header[16] = descrId & 0xff;
  header[17] = 1; // TTL (not critical for 0x30)
  header[18] = 0; // Hops
  header.writeUInt32LE(payload.length, 19);
  return Buffer.concat([header, Buffer.from(payload)]);
}

/* ──────────────────────────────────────────────────────────── *
 * 6.  Convenience: build & wrap both messages                 *
 * ──────────────────────────────────────────────────────────── */

export function buildQRPUpdates(sharedFiles: string[]) {
  const bits = buildQRTBits(sharedFiles);
  const reset = wrapDescriptor(DESCR_ID_ROUTE_UPDATE, qrpResetPayload());
  const patch = wrapDescriptor(DESCR_ID_ROUTE_UPDATE, qrpPatchPayload(bits));
  return { reset, patch };
}

// After handshake succeeds…
export const { reset, patch } = buildQRPUpdates(["foo.txt"]);

// socket.write(reset); // RouteTableUpdate Reset
// socket.write(patch); // RouteTableUpdate Patch
