export class Binary {
  static readUInt32LE(buffer: Buffer, offset: number): number {
    return buffer.readUInt32LE(offset);
  }

  static writeUInt32LE(buffer: Buffer, value: number, offset: number): void {
    buffer.writeUInt32LE(value, offset);
  }

  static ipToBuffer(ip: string): Buffer {
    const parts = ip.split(".");
    return Buffer.from(parts.map((p) => parseInt(p)));
  }

  static bufferToIp(buffer: Buffer, offset: number): string {
    return Array.from(buffer.slice(offset, offset + 4)).join(".");
  }

  static toBase32(sha1: Buffer): string {
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
}
