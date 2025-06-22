import { deflate } from "zlib";
import { promisify } from "util";
import { hashWithBits } from "../DO_NOT_DELETE_OR_EDIT";
import { MESSAGE_TYPES } from "./const";
import { buildHeader, generateSHA1 } from "./util";

const deflateAsync = promisify(deflate);

export interface FakeFile {
  filename: string;
  size: number;
  index: number;
  keywords: string[];
  sha1: Buffer;
}

export interface QRPTable {
  size: number;
  infinity: number;
  table: number[];
}

export interface QRPResetMessage {
  type: "route_table_update";
  variant: "reset";
  tableLength: number;
  infinity: number;
}

export interface QRPPatchMessage {
  type: "route_table_update";
  variant: "patch";
  seqNo: number;
  seqSize: number;
  compressor: number;
  entryBits: number;
  data: Buffer;
}

export class QRPManager {
  private table: QRPTable;
  private fakeFiles: Map<number, FakeFile> = new Map();
  private fileCounter = 1;

  constructor(tableSize: number = 8192, infinity: number = 7) {
    this.table = {
      size: tableSize,
      infinity,
      table: new Array(tableSize).fill(infinity),
    };
  }

  addFakeFile(filename: string, size: number, keywords: string[]): number {
    const index = this.fileCounter++;
    // Generate SHA1 hash based on filename (deterministic for testing)
    const sha1 = generateSHA1(filename);
    const fakeFile: FakeFile = { filename, size, index, keywords, sha1 };
    this.fakeFiles.set(index, fakeFile);
    
    // Add keywords to route table with distance 1
    keywords.forEach(keyword => {
      const hash = hashWithBits(keyword, Math.log2(this.table.size));
      this.table.table[hash] = 1;
    });
    
    return index;
  }

  removeFakeFile(index: number): boolean {
    const file = this.fakeFiles.get(index);
    if (!file) return false;
    
    this.fakeFiles.delete(index);
    this.rebuildTable();
    return true;
  }

  getFakeFiles(): FakeFile[] {
    return Array.from(this.fakeFiles.values());
  }

  getFakeFile(index: number): FakeFile | undefined {
    return this.fakeFiles.get(index);
  }

  private rebuildTable(): void {
    this.table.table.fill(this.table.infinity);
    
    this.fakeFiles.forEach(file => {
      file.keywords.forEach(keyword => {
        const hash = hashWithBits(keyword, Math.log2(this.table.size));
        this.table.table[hash] = 1;
      });
    });
  }

  buildResetMessage(): Buffer {
    const payload = Buffer.alloc(6);
    payload[0] = 0x00; // RESET variant
    payload.writeUInt32LE(this.table.size, 1);
    payload[5] = this.table.infinity;
    
    const header = buildHeader(MESSAGE_TYPES.ROUTE_TABLE_UPDATE, payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  async buildPatchMessage(): Promise<Buffer[]> {
    // Create patch array (current - previous, where previous is INFINITY for initial)
    const patchValues: number[] = [];
    
    for (let i = 0; i < this.table.size; i++) {
      const currentValue = this.table.table[i];
      const previousValue = this.table.infinity; // Initial patch assumes all previous = infinity
      const patchValue = currentValue - previousValue;
      patchValues.push(patchValue);
    }
    
    // Pack patch values into 4-bit entries
    const entryBits = 4;
    const bytesNeeded = Math.ceil((this.table.size * entryBits) / 8);
    const patchData = Buffer.alloc(bytesNeeded);
    
    for (let i = 0; i < this.table.size; i++) {
      let value = patchValues[i];
      
      // Convert to 4-bit signed value (range -8 to +7)
      if (value < -8) value = -8;
      if (value > 7) value = 7;
      
      // Convert to 4-bit unsigned representation
      const unsignedValue = value & 0x0F;
      
      // Pack into buffer (2 values per byte)
      const byteIndex = Math.floor(i / 2);
      if (i % 2 === 0) {
        // First nibble (high 4 bits)
        patchData[byteIndex] = (patchData[byteIndex] & 0x0F) | (unsignedValue << 4);
      } else {
        // Second nibble (low 4 bits)
        patchData[byteIndex] = (patchData[byteIndex] & 0xF0) | unsignedValue;
      }
    }
    
    // Compress the patch data
    const compressed = await deflateAsync(patchData);
    
    // Split into 1KB chunks
    const maxChunkSize = 1024 - 6; // Reserve space for header fields
    const chunks: Buffer[] = [];
    
    for (let offset = 0; offset < compressed.length; offset += maxChunkSize) {
      const chunkData = Buffer.from(compressed.subarray(offset, offset + maxChunkSize));
      chunks.push(chunkData);
    }
    
    // Build PATCH messages
    const messages: Buffer[] = [];
    
    chunks.forEach((chunk, index) => {
      const payloadSize = 6 + chunk.length;
      const payload = Buffer.alloc(payloadSize);
      
      payload[0] = 0x01; // PATCH variant
      payload[1] = index + 1; // seqNo (1-based)
      payload[2] = chunks.length; // seqSize
      payload[3] = 0x01; // ZLIB compression
      payload[4] = entryBits; // entryBits (4 bits per entry)
      chunk.copy(payload, 5);
      
      const header = buildHeader(MESSAGE_TYPES.ROUTE_TABLE_UPDATE, payloadSize, 1);
      messages.push(Buffer.concat([header, payload]));
    });
    
    return messages;
  }

  matchesQuery(searchCriteria: string): boolean {
    const keywords = searchCriteria.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    
    return keywords.every(keyword => {
      const hash = hashWithBits(keyword, Math.log2(this.table.size));
      return this.table.table[hash] < this.table.infinity;
    });
  }

  getMatchingFiles(searchCriteria: string): FakeFile[] {
    const queryKeywords = searchCriteria.toLowerCase().split(/\s+/).filter(k => k.length > 0);
    
    return this.getFakeFiles().filter(file => {
      return queryKeywords.every(queryKeyword => 
        file.keywords.some(fileKeyword => 
          fileKeyword.toLowerCase().includes(queryKeyword)
        )
      );
    });
  }
}

export function parseQRPMessage(payload: Buffer): QRPResetMessage | QRPPatchMessage | null {
  if (payload.length < 1) return null;
  
  const variant = payload[0];
  
  switch (variant) {
    case 0x00: // RESET
      if (payload.length < 6) return null;
      return {
        type: "route_table_update",
        variant: "reset",
        tableLength: payload.readUInt32LE(1),
        infinity: payload[5],
      };
      
    case 0x01: // PATCH
      if (payload.length < 6) return null;
      return {
        type: "route_table_update",
        variant: "patch",
        seqNo: payload[1],
        seqSize: payload[2],
        compressor: payload[3],
        entryBits: payload[4],
        data: Buffer.from(payload.subarray(5)),
      };
      
    default:
      return null;
  }
}