export class QrpTable {
  private bits: Uint8Array;
  private size: number = 65536;
  private isEmpty: boolean = true;

  constructor() {
    this.bits = new Uint8Array(this.size / 8);
  }

  addFile(filename: string): void {
    const words = this.tokenize(filename);
    words.forEach((word) => this.addWord(word));
  }

  addKeywords(keywords: string[]): void {
    keywords.forEach((word) => {
      if (word.length >= 3) {
        // QRP minimum word length
        this.addWord(word);
        console.log(`[QRP] Added keyword: "${word}"`);
      } else {
        console.log(`[QRP] Skipped short keyword: "${word}"`);
      }
    });
  }

  private tokenize(filename: string): string[] {
    return filename
      .toLowerCase()
      .split(/[\s\-_\.]+/)
      .filter((word) => word.length >= 3); // Min 3 chars for QRP
  }

  private addWord(word: string): void {
    // QRP spec: keywords should be lowercased
    const normalized = word.toLowerCase();
    const hash = this.hash(normalized);
    const index = hash % this.size;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    this.bits[byteIndex] |= 1 << bitIndex;
    this.isEmpty = false;
    console.log(
      `[QRP] Hashed "${word}" -> normalized: "${normalized}" -> hash: ${hash} -> index: ${index}`
    );
  }

  private hash(str: string): number {
    return this.hashWithBits(str, 16);
  }

  checkWord(word: string): boolean {
    if (word.length < 3) return false;
    const normalized = word.toLowerCase();
    const hash = this.hash(normalized);
    const index = hash % this.size;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = index % 8;
    return (this.bits[byteIndex] & (1 << bitIndex)) !== 0;
  }

  clear(): void {
    this.bits.fill(0);
    this.isEmpty = true;
  }

  getEmpty(): boolean {
    return this.isEmpty;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }

  // Test hash function against QRP spec examples
  static testHash(): void {
    const table = new QrpTable();
    const tests = [
      { input: "", bits: 13, expected: 0 },
      { input: "", bits: 16, expected: 0 },
      { input: "2459345938032343", bits: 10, expected: 146 },
      { input: "3nja9", bits: 10, expected: 581 },
      { input: "3nJa9", bits: 10, expected: 581 },
      { input: "3NJA9", bits: 10, expected: 581 },
      { input: "7777a88a8a8a8", bits: 10, expected: 342 },
      { input: "9um3o34fd", bits: 10, expected: 758 },
      { input: "a234d", bits: 10, expected: 281 },
      { input: "a3f", bits: 10, expected: 767 },
      { input: "adfk32l", bits: 10, expected: 1011 },
      { input: "asdfas23", bits: 10, expected: 503 },
      { input: "asdfjklkj3k", bits: 10, expected: 861 },
      { input: "eb", bits: 13, expected: 6791 },
      { input: "ebc", bits: 13, expected: 7082 },
      { input: "ebck", bits: 13, expected: 6698 },
      { input: "ebckl", bits: 13, expected: 3179 },
      { input: "ebcklm", bits: 13, expected: 3235 },
      { input: "ebcklme", bits: 13, expected: 6438 },
      { input: "ebcklmen", bits: 13, expected: 1062 },
      { input: "ebcklmenq", bits: 13, expected: 3527 },
      { input: "n", bits: 16, expected: 65003 },
      { input: "nd", bits: 16, expected: 54193 },
      { input: "ndf", bits: 16, expected: 4953 },
      { input: "ndfl", bits: 16, expected: 58201 },
      { input: "ndfla", bits: 16, expected: 34830 },
      { input: "ndflal", bits: 16, expected: 36910 },
      { input: "ndflale", bits: 16, expected: 34586 },
      { input: "ndflalem", bits: 16, expected: 37658 },
      { input: "ndflaleme", bits: 16, expected: 45559 },
      { input: "ol2j34lj", bits: 10, expected: 318 },
      { input: "zzzzzzzzzzz", bits: 10, expected: 944 },
    ];

    for (const test of tests) {
      // We need to create a custom hash function that uses the specified bits
      const result = table.hashWithBits(test.input.toLowerCase(), test.bits);
      const match = result === test.expected ? "✓" : "✗";
      console.log(
        `[QRP TEST] hash("${test.input}", ${test.bits}) = ${result}, expected: ${test.expected} ${match}`
      );

      // Debug the intermediate values
      if (!match && test.input.length > 0) {
        let xor = 0;
        let j = 0;
        for (let i = 0; i < test.input.length; i++) {
          const b = test.input.charCodeAt(i) & 0xff;
          const shifted = b << (j * 8);
          xor = xor ^ shifted;
          j = (j + 1) % 4;
        }
        console.log(
          `[QRP DEBUG] "${test.input}" -> xor: 0x${xor
            .toString(16)
            .padStart(8, "0")}`
        );
      }
    }
  }

  // Hash function that allows specifying bit count for testing
  private hashWithBits(str: string, bits: number): number {
    if (bits < 1 || bits > 32) {
      throw new RangeError("bits must be between 1 and 32 (inclusive)");
    }

    const A_INT = 0x4f1bbcdc; // Knuth's multiplicative constant 0x4F1BBCDC

    // 1. Build a 32‑bit value by XOR‑ing the keyword’s bytes little‑endian.
    const bytes = new TextEncoder().encode(str.toLowerCase());
    let xor = 0;
    for (let i = 0; i < bytes.length; i++) {
      xor ^= bytes[i] << ((i & 3) * 8);
    }
    xor >>>= 0; // unsigned 32‑bit

    // 2. Multiply (unsigned) by A_INT — keep full 64‑bit precision via BigInt.
    const prod = BigInt(xor) * BigInt(A_INT);

    // 3. Take the upper‑most `bits` from the 64‑bit product (see paper §Hashing).
    const mask = (1n << BigInt(bits)) - 1n;
    const result = Number((prod >> BigInt(32 - bits)) & mask);

    return result >>> 0;
  }
}
