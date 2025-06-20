import { createQrpReset, createQrpPatch } from "./parser";

const TABLE_SLOTS = 65536;
const ENTRY_BITS = 1;

class BitArray {
  private buffer: Uint8Array;
  private size: number;

  constructor(size: number) {
    this.size = size;
    this.buffer = new Uint8Array(Math.ceil(size / 8));
  }

  set(index: number, value: number): void {
    if (index >= this.size) return;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    if (value) {
      this.buffer[byteIndex] |= (1 << bitIndex);
    } else {
      this.buffer[byteIndex] &= ~(1 << bitIndex);
    }
  }

  get(index: number): number {
    if (index >= this.size) return 0;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    return (this.buffer[byteIndex] >> bitIndex) & 1;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }
}

function normalizeKeyword(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
    .replace(/[^a-z0-9]/g, ""); // Keep only alphanumeric
}

function tokenizeFileName(fileName: string): string[] {
  return fileName
    .split(/[\s\-_\.]+/)
    .filter(word => word.length > 0);
}

// Simple FNV-1a hash truncated to 16 bits
function hash(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash & 0xFFFF; // Take lower 16 bits
}

export interface SharedFile {
  name: string;
  size: number;
}

export function generateQrpTable(sharedFiles: SharedFile[]): BitArray {
  const qrtBits = new BitArray(TABLE_SLOTS);
  
  for (const file of sharedFiles) {
    const keywords = tokenizeFileName(file.name);
    for (const word of keywords) {
      const normalized = normalizeKeyword(word);
      if (normalized.length < 1) continue;
      const index = hash(normalized) % TABLE_SLOTS;
      qrtBits.set(index, 1);
    }
  }
  
  return qrtBits;
}

export function sendQrpTable(
  send: (buffer: Buffer) => void,
  sharedFiles: SharedFile[]
): void {
  // Generate the QRP table
  const qrtBits = generateQrpTable(sharedFiles);
  const tableData = qrtBits.toBuffer();
  
  // Send RESET first
  send(createQrpReset(TABLE_SLOTS));
  
  // Send PATCH with table data
  send(createQrpPatch(
    1,              // seqNo
    1,              // seqCount (single patch)
    ENTRY_BITS,     // 1 bit per entry
    tableData,      // The actual table data
    0,              // no compression
    1               // TTL
  ));
}