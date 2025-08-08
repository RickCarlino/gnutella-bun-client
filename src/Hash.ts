import { createHash } from "crypto";

export class Hash {
  // QRP hash as used for Query Routing tables
  static qrp(str: string, bits: number): number {
    const A_INT = 0x4f1bbcdc; // Knuth-like multiplicative constant
    const bytes = new TextEncoder().encode(str.toLowerCase());
    let xor = 0;
    for (let i = 0; i < bytes.length; i++) {
      xor ^= bytes[i] << ((i & 3) * 8);
    }
    const prod = BigInt(xor >>> 0) * BigInt(A_INT >>> 0);
    const mask = (1n << BigInt(bits)) - 1n;
    return Number((prod >> BigInt(32 - bits)) & mask) >>> 0;
  }
  static sha1(data: string | Buffer): Buffer {
    return createHash("sha1").update(data).digest();
  }

  static sha1ToBase32(sha1: Buffer): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let result = "";
    let bits = 0;
    let value = 0;

    for (const byte of sha1) {
      value = (value << 8) | byte;
      bits += 8;

      while (bits >= 5) {
        result += chars[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }

    if (bits > 0) {
      result += chars[(value << (5 - bits)) & 31];
    }

    return result.padEnd(32, "=");
  }

  static sha1ToUrn(sha1: Buffer): string {
    return `urn:sha1:${this.sha1ToBase32(sha1)}`;
  }
}
