export class QrpTable {
  private bits: Uint8Array;
  private size: number = 65536;

  constructor() {
    this.bits = new Uint8Array(this.size / 8);
  }

  addFile(filename: string): void {
    const words = this.tokenize(filename);
    words.forEach((word) => this.addWord(word));
  }

  private tokenize(filename: string): string[] {
    return filename
      .toLowerCase()
      .split(/[\s\-_\.]+/)
      .filter((word) => word.length > 0);
  }

  private addWord(word: string): void {
    const normalized = word.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const hash = this.hash(normalized);
    const index = hash % this.size;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    this.bits[byteIndex] |= 1 << bitIndex;
  }

  private hash(str: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    // Pre-rotate for better distribution
    return (h >>> 16) ^ (h & 0xffff);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }
}
