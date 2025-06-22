import { Protocol, QRPVariant, MessageType } from "./constants";
import { Hash } from "./hash";
import { SharedFile } from "./core_types";
import { MessageBuilder } from "./message_builder";
import zlib from "zlib";
import { promisify } from "util";

export class QRPManager {
  private table: number[];
  private tableSize: number;
  private infinity: number;
  private sharedFiles: Map<number, SharedFile>;
  private fileCounter: number;

  constructor(
    tableSize: number = Protocol.QRP_TABLE_SIZE,
    infinity: number = Protocol.QRP_INFINITY,
  ) {
    this.tableSize = tableSize;
    this.infinity = infinity;
    this.table = new Array(tableSize).fill(infinity);
    this.sharedFiles = new Map();
    this.fileCounter = 1;
  }

  addFile(filename: string, size: number, keywords: string[]): number {
    const index = this.fileCounter++;
    const sha1 = Hash.sha1(filename);

    this.sharedFiles.set(index, { filename, size, index, keywords, sha1 });
    this.updateTableForKeywords(keywords);

    return index;
  }

  removeFile(index: number): boolean {
    if (!this.sharedFiles.has(index)) return false;

    this.sharedFiles.delete(index);
    this.rebuildTable();

    return true;
  }

  getFiles(): SharedFile[] {
    return Array.from(this.sharedFiles.values());
  }

  getFile(index: number): SharedFile | undefined {
    return this.sharedFiles.get(index);
  }

  matchesQuery(searchCriteria: string): boolean {
    const keywords = this.extractKeywords(searchCriteria);
    return keywords.every((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      return this.table[hash] < this.infinity;
    });
  }

  getMatchingFiles(searchCriteria: string): SharedFile[] {
    const queryKeywords = this.extractKeywords(searchCriteria);

    return this.getFiles().filter((file) =>
      queryKeywords.every((queryKeyword) =>
        file.keywords.some((fileKeyword) =>
          fileKeyword.toLowerCase().includes(queryKeyword),
        ),
      ),
    );
  }

  buildResetMessage(): Buffer {
    const payload = Buffer.alloc(6);
    payload[0] = QRPVariant.RESET;
    payload.writeUInt32LE(this.tableSize, 1);
    payload[5] = this.infinity;

    const header = MessageBuilder.header(
      MessageType.ROUTE_TABLE_UPDATE,
      payload.length,
      1,
    );
    return Buffer.concat([header, payload]);
  }

  async buildPatchMessage(): Promise<Buffer[]> {
    const deflate = promisify(zlib.deflate);

    const patchData = this.createPatchData();
    const compressed = await deflate(patchData);

    return this.createPatchChunks(compressed);
  }

  private updateTableForKeywords(keywords: string[]): void {
    keywords.forEach((keyword) => {
      const hash = Hash.qrp(keyword, Math.log2(this.tableSize));
      this.table[hash] = 1;
    });
  }

  private rebuildTable(): void {
    this.table.fill(this.infinity);

    this.sharedFiles.forEach((file) => {
      this.updateTableForKeywords(file.keywords);
    });
  }

  private extractKeywords(searchCriteria: string): string[] {
    return searchCriteria
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0);
  }

  private createPatchData(): Buffer {
    const entryBits = 4;
    const bytesNeeded = Math.ceil((this.tableSize * entryBits) / 8);
    const patchData = Buffer.alloc(bytesNeeded);

    for (let i = 0; i < this.tableSize; i++) {
      const value = Math.max(-8, Math.min(7, this.table[i] - this.infinity));
      const unsignedValue = value & 0xf;
      const byteIndex = Math.floor(i / 2);

      if (i % 2 === 0) {
        patchData[byteIndex] =
          (patchData[byteIndex] & 0x0f) | (unsignedValue << 4);
      } else {
        patchData[byteIndex] = (patchData[byteIndex] & 0xf0) | unsignedValue;
      }
    }

    return patchData;
  }

  private createPatchChunks(compressed: Buffer): Buffer[] {
    const maxChunkSize = 1024 - 6;
    const chunks: Buffer[] = [];

    for (let offset = 0; offset < compressed.length; offset += maxChunkSize) {
      const chunk = compressed.subarray(offset, offset + maxChunkSize);
      chunks.push(chunk);
    }

    return chunks.map((chunk, index) => {
      const payload = Buffer.alloc(6 + chunk.length);
      payload[0] = QRPVariant.PATCH;
      payload[1] = index + 1;
      payload[2] = chunks.length;
      payload[3] = 1;
      payload[4] = 4;
      chunk.copy(payload, 5);

      const header = MessageBuilder.header(
        MessageType.ROUTE_TABLE_UPDATE,
        payload.length,
        1,
      );
      return Buffer.concat([header, payload]);
    });
  }
}
